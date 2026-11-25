"""内容分级口径的只读对比（P2-46）。

本模块**不计算难度、不写库、不改缓存**；它只回答一个运维问题：
「同一内容，本地和线上展示的等级为什么不同，差在哪一层？」

三层口径（禁止混用）：

- ``editorial``：内容 JSON 的 ``level``（人工标注）。``GET /api/library*`` 的
  ``level`` 就是它；没有算法数据时也用它兜底展示。
- ``computed``：``content_difficulty.cefr_input``（``difficulty.v1`` 规则计算，
  0 LLM）。``GET /api/content/difficulty`` 的 ``cefrInput`` 就是它。
- ``display``：前端徽章规则 ``cefrInput ?? editorial``，不是第三个数据源。
  ``source=computed`` 显示算法级，``source=legacy`` 回退编辑级。

本地/线上不一致的常见根因是 ``content_difficulty`` 的数据覆盖不同（一方没跑
回填），不是内容 JSON 写错。编辑级与算法级允许相差一档，不互相覆盖、不互相
回填；报告只对比，写库仍由 ``scripts/backfill_content_difficulty.py`` 负责。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import config
import difficulty

AUDIT_SCHEMA = "content-difficulty-audit.v1"
# 与编辑级 A1–C2 对齐；算法级 C1+ 合并到 C2 一档。
LEVEL_INDEX = {"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C1": 4, "C2": 5, "C1+": 5}
# 内容编辑可写 A1–C2；算法（difficulty.v1）只输出 A1–C1+，C2 内容没有算法级。
EDITORIAL_LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")
ALGORITHM_LEVELS = difficulty.CEFR_LEVELS
REMOTE_BATCH = 40
DEFAULT_TIMEOUT = 20.0

RemoteLoader = Callable[[Sequence[tuple[str, str]]], Mapping[tuple[str, str], Mapping[str, Any]]]


class AuditUnavailable(RuntimeError):
    """审计所需的本地产物/线上接口不可用；不产生半份报告。"""


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AuditUnavailable(f"读取 {path} 失败：{exc}") from exc


def _manifest_ids(path: Path, key: str) -> list[str]:
    if not path.is_file():
        raise AuditUnavailable(f"缺少清单：{path}")
    data = _read_json(path)
    values = data.get(key) if isinstance(data, dict) else None
    if not isinstance(values, list):
        raise AuditUnavailable(f"{path.name} 缺少 {key} 数组")
    return [value for value in values if isinstance(value, str) and value]


def serving_items() -> list[tuple[str, str]]:
    """当前 serving 内容（3 类）：library 视频 + 文章 + curated 精选。

    顺序与清单一致（video → article → curated），便于报告对比。
    """
    library = Path(config.LIBRARY_DIR)
    items: list[tuple[str, str]] = []
    items.extend(
        ("video", ref) for ref in _manifest_ids(library / "videos.json", "videos")
    )
    items.extend(
        ("article", ref) for ref in _manifest_ids(library / "articles.json", "articles")
    )
    curated_path = Path(config.CURATED_CONTENT_PATH)
    if curated_path.is_file():
        data = _read_json(curated_path)
        raw_items = data.get("items") if isinstance(data, dict) else None
        for item in raw_items or []:
            if isinstance(item, dict):
                ref = item.get("videoId")
                if isinstance(ref, str) and ref:
                    items.append(("curated", ref))
    return items


def level_distance(editorial: str | None, computed: str | None) -> int | None:
    """编辑级与算法级的档差；任一不可识别时返回 None。"""
    if editorial not in LEVEL_INDEX or computed not in LEVEL_INDEX:
        return None
    return abs(LEVEL_INDEX[editorial] - LEVEL_INDEX[computed])


def _raw_editorial_level(kind: str, ref: str) -> str | None:
    """直接读内容源的人工编辑 ``level``（支持 C2，不受算法 A1–C1 限制）。"""
    if kind in ("article", "video"):
        path = Path(config.LIBRARY_DIR) / f"{kind}s" / f"{ref}.json"
        if not path.is_file():
            raise AuditUnavailable(f"内容文件不存在：{path}")
        data = _read_json(path)
        value = data.get("level") if isinstance(data, dict) else None
        return value if isinstance(value, str) and value in EDITORIAL_LEVELS else None
    if kind == "curated":
        data = _read_json(Path(config.CURATED_CONTENT_PATH))
        raw_items = data.get("items") if isinstance(data, dict) else None
        for item in raw_items or []:
            if not isinstance(item, dict) or item.get("videoId") != ref:
                continue
            value = item.get("level")
            return value if isinstance(value, str) and value in EDITORIAL_LEVELS else None
        return None
    return None


def _editorial_levels(
    items: Iterable[tuple[str, str]]
) -> tuple[dict[tuple[str, str], str | None], list[dict[str, str]]]:
    levels: dict[tuple[str, str], str | None] = {}
    errors: list[dict[str, str]] = []
    for kind, ref in items:
        try:
            levels[(kind, ref)] = _raw_editorial_level(kind, ref)
        except AuditUnavailable as exc:
            levels[(kind, ref)] = None
            errors.append({"kind": kind, "ref": ref, "error": str(exc)})
    return levels, errors


def audit_item(
    kind: str,
    ref: str,
    *,
    editorial_level: str | None,
    row: Mapping[str, Any] | None = None,
    remote: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """单条对比：编辑级 / 本地算法级 / 本地展示级 /（可选）线上展示级。"""
    computed = row.get("cefrInput") if isinstance(row, Mapping) else None
    stored_editorial = row.get("level") if isinstance(row, Mapping) else None
    local_source = "computed" if computed else "legacy"
    local_display = computed or editorial_level
    item: dict[str, Any] = {
        "kind": kind,
        "ref": ref,
        "editorialLevel": editorial_level,
        # C2 内容不在 difficulty.v1 的输出域（A1–C1+），没有算法级是预期行为。
        "algorithmEligible": editorial_level in ALGORITHM_LEVELS,
        "computedLevel": computed,
        "storedEditorialLevel": stored_editorial,
        "localSource": local_source,
        "localDisplay": local_display,
    }
    distance = level_distance(editorial_level, computed)
    if distance is not None:
        item["editorialDistance"] = distance
    if row is not None and stored_editorial != editorial_level:
        # 内容 JSON 的编辑级改过但没重跑回填：行里仍是旧编辑级（仅提示）。
        item["storedEditorialDrift"] = {
            "stored": stored_editorial,
            "content": editorial_level,
        }
    if remote is not None:
        remote_computed = remote.get("cefrInput")
        remote_editorial = remote.get("level")
        remote_source = remote.get("source")
        if remote_source not in ("computed", "legacy"):
            remote_source = "computed" if remote_computed else "legacy"
        remote_display = remote_computed or remote_editorial
        item["remote"] = {
            "source": remote_source,
            "level": remote_editorial,
            "cefrInput": remote_computed,
            "display": remote_display,
        }
        if local_display is not None and remote_display is not None:
            item["displayMatch"] = local_display == remote_display
        if (
            remote_editorial is not None
            and editorial_level is not None
            and remote_editorial != editorial_level
        ):
            # 线上内容 JSON 与本地不同（通常是发布版本不同）。
            item["remoteEditorialDrift"] = {
                "remote": remote_editorial,
                "local": editorial_level,
            }
    return item


def _chunks(items: Sequence[tuple[str, str]], size: int) -> Iterable[Sequence[tuple[str, str]]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def fetch_remote(
    api_base: str,
    items: Sequence[tuple[str, str]],
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[tuple[str, str], dict[str, Any]]:
    """只读拉线上 ``/api/content/difficulty/batch``（自动按 ≤40 条分批）。"""
    base = api_base.rstrip("/")
    if not base:
        raise AuditUnavailable("api_base 不能为空")
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for chunk in _chunks(list(items), REMOTE_BATCH):
        query = urllib.parse.urlencode(
            {"items": ",".join(f"{kind}:{ref}" for kind, ref in chunk)}
        )
        url = f"{base}/api/content/difficulty/batch?{query}"
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise AuditUnavailable(f"线上难度接口不可用（{base}）：{exc}") from exc
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            raise AuditUnavailable(f"线上难度接口返回不是 JSON（{base}）") from exc
        rows = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise AuditUnavailable(f"线上难度接口返回缺少 items（{base}）")
        for raw_item in rows:
            if not isinstance(raw_item, dict):
                continue
            kind = raw_item.get("kind")
            ref = raw_item.get("ref")
            if isinstance(kind, str) and isinstance(ref, str):
                result[(kind, ref)] = raw_item
    return result


def _by_kind(items: Sequence[tuple[str, str]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for kind, _ref in items:
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def _summarize(
    items: Sequence[tuple[str, str]],
    audited: Sequence[dict[str, Any]],
    *,
    remote_requested: bool,
    remote_error: str | None,
) -> dict[str, Any]:
    computed = [item for item in audited if item["localSource"] == "computed"]
    legacy = [item for item in audited if item["localSource"] == "legacy"]
    legacy_outside = [item for item in legacy if not item["algorithmEligible"]]
    legacy_unexpected = [item for item in legacy if item["algorithmEligible"]]
    distance: dict[str, int] = {}
    for item in computed:
        key = str(item.get("editorialDistance"))
        if key != "None":
            distance[key] = distance.get(key, 0) + 1
    changes = sum(
        1
        for item in computed
        if item.get("editorialLevel") and item["localDisplay"] != item["editorialLevel"]
    )
    summary: dict[str, Any] = {
        "total": len(items),
        "byKind": _by_kind(items),
        "local": {
            "computed": len(computed),
            "legacy": len(legacy),
            # C2 等算法域外内容回退编辑级是设计行为，不算缺数据。
            "legacyOutsideAlgorithm": len(legacy_outside),
            "legacyUnexpected": len(legacy_unexpected),
            "editorialMissing": sum(
                1 for item in audited if item["editorialLevel"] is None
            ),
            "storedEditorialDrift": sum(
                1 for item in audited if "storedEditorialDrift" in item
            ),
        },
        "editorialVsComputed": dict(sorted(distance.items(), key=lambda pair: int(pair[0]))),
        # 若对本地这 100+ 条跑回填，展示等级会从编辑级换成算法级的条数。
        "displayChangesFromEditorial": changes,
    }
    if remote_requested:
        remote_items = [item for item in audited if "remote" in item]
        mismatches = [item for item in audited if item.get("displayMatch") is False]
        summary["remote"] = {
            "returned": len(remote_items),
            "missing": len(items) - len(remote_items),
            "computed": sum(1 for item in remote_items if item["remote"]["source"] == "computed"),
            "legacy": sum(1 for item in remote_items if item["remote"]["source"] == "legacy"),
            "displayMismatch": len(mismatches),
            "editorialDrift": sum(
                1 for item in audited if "remoteEditorialDrift" in item
            ),
            "error": remote_error,
        }
    return summary


def _plan(
    audited: Sequence[dict[str, Any]], *, remote_requested: bool
) -> dict[str, Any]:
    """回填计划（只列地址，不写库）：谁缺算法行、谁不在算法域内。"""
    def ref(kind: str, ref: str, editorial: str | None) -> dict[str, Any]:
        return {"kind": kind, "ref": ref, "editorialLevel": editorial}

    plan: dict[str, Any] = {
        "localMissing": [
            ref(item["kind"], item["ref"], item["editorialLevel"])
            for item in audited
            if item["algorithmEligible"] and item["localSource"] == "legacy"
        ],
        "outsideAlgorithm": [
            ref(item["kind"], item["ref"], item["editorialLevel"])
            for item in audited
            if not item["algorithmEligible"]
        ],
    }
    if remote_requested:
        plan["remoteMissing"] = [
            ref(item["kind"], item["ref"], item["editorialLevel"])
            for item in audited
            if item["algorithmEligible"]
            and "remote" in item
            and item["remote"]["source"] == "legacy"
        ]
    return plan


def build_report(
    api_base: str | None = None,
    *,
    remote_loader: RemoteLoader | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """只读对比报告；``remote_loader`` 供测试注入，正常 CLI 用 ``api_base``。"""
    items = serving_items()
    rows = difficulty.get_rows(items)
    levels, content_errors = _editorial_levels(items)

    remote_requested = bool(api_base or remote_loader)
    remote_map: dict[tuple[str, str], Mapping[str, Any]] = {}
    remote_error: str | None = None
    if remote_loader is not None:
        try:
            remote_map = dict(remote_loader(items) or {})
        except Exception as exc:  # noqa: BLE001 - 报告要保留真实原因
            remote_error = f"{type(exc).__name__}: {exc}"
    elif api_base:
        try:
            remote_map = fetch_remote(api_base, items, timeout=timeout)
        except AuditUnavailable as exc:
            remote_error = str(exc)

    audited = [
        audit_item(
            kind,
            ref,
            editorial_level=levels.get((kind, ref)),
            row=rows.get((kind, ref)),
            remote=remote_map.get((kind, ref)) if remote_requested else None,
        )
        for kind, ref in items
    ]
    report: dict[str, Any] = {
        "schema": AUDIT_SCHEMA,
        "generatedAt": int(time.time() * 1000),
        "apiBase": api_base or None,
        "summary": _summarize(
            items,
            audited,
            remote_requested=remote_requested,
            remote_error=remote_error,
        ),
        "mismatches": [
            {
                "kind": item["kind"],
                "ref": item["ref"],
                "editorialLevel": item["editorialLevel"],
                "computedLevel": item["computedLevel"],
                "localDisplay": item["localDisplay"],
                "remoteDisplay": item["remote"]["display"],
                "distance": item.get("editorialDistance"),
            }
            for item in audited
            if item.get("displayMatch") is False
        ],
        "contentErrors": content_errors,
        "plan": _plan(audited, remote_requested=remote_requested),
        "items": audited,
    }
    return report


def format_summary(report: Mapping[str, Any]) -> str:
    summary = report.get("summary") or {}
    local = summary.get("local") or {}
    by_kind = summary.get("byKind") or {}
    total = summary.get("total", 0)
    lines = [
        f"分级只读对比：{total} 条 serving"
        f"（video {by_kind.get('video', 0)} / article {by_kind.get('article', 0)}"
        f" / curated {by_kind.get('curated', 0)}）",
        f"本地 content_difficulty：computed {local.get('computed', 0)}"
        f" / legacy {local.get('legacy', 0)}"
        f"（算法域外 {local.get('legacyOutsideAlgorithm', 0)}"
        f" / 缺行 {local.get('legacyUnexpected', 0)}）"
        f" / 编辑级缺失 {local.get('editorialMissing', 0)}",
        f"编辑级 vs 算法级档差：{summary.get('editorialVsComputed') or {}}",
        f"回填会改变展示等级：{summary.get('displayChangesFromEditorial', 0)} 条",
    ]
    plan = report.get("plan") or {}
    lines.append(
        f"回填计划：本地缺行 {len(plan.get('localMissing') or [])} 条"
        f" / 算法域外 {len(plan.get('outsideAlgorithm') or [])} 条（C2，需人工决定）"
    )
    remote = summary.get("remote")
    if remote is not None:
        lines.append(f"线上缺行（需回填）：{len(plan.get('remoteMissing') or [])} 条")
        lines.append(
            f"线上 {report.get('apiBase') or '(注入)'}：返回 {remote.get('returned', 0)} 条"
            f" / computed {remote.get('computed', 0)} / legacy {remote.get('legacy', 0)}"
            f" / 缺失 {remote.get('missing', 0)}"
        )
        lines.append(
            f"本地与线上展示不一致：{remote.get('displayMismatch', 0)} 条"
            f" / 线上编辑级漂移 {remote.get('editorialDrift', 0)} 条"
        )
        if remote.get("error"):
            lines.append(f"线上接口错误：{remote['error']}")
    return "\n".join(lines)
