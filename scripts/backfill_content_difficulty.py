#!/usr/bin/env python3
"""回填 content_difficulty：70 条 serving + 30 条 curated = 100 条（计划书 §7.3 / §10.2）。

用法（仓库根目录）：

    backend/venv/bin/python scripts/backfill_content_difficulty.py
    backend/venv/bin/python scripts/backfill_content_difficulty.py --dry-run
    backend/venv/bin/python scripts/backfill_content_difficulty.py --only serving
    backend/venv/bin/python scripts/backfill_content_difficulty.py --report /tmp/r.json

数据来源（全部只读、不联网）：

- serving：``content/library/videos/*.json``（3 条，预生成双语字幕块）+
  ``content/library/articles/*.json``（67 条，3 篇原创 + 64 篇公版短文）；
- curated：``content/curated.json`` 30 条 + ``data/curated-subtitles/<videoId>.json``
  字幕缓存（由构建期 ``scripts/fetch_curated_subtitles.py`` 生成；缺缓存的原因
  会写进报告，不会静默跳过）。

幂等：同一条内容重算结果相同时跳过（不刷新 updated_at）；表按
``(content_ref, content_kind, version)`` upsert。报告写 ``data/reports/``（已
gitignore）并打印摘要：覆盖率、按 kind/band 分布、与编辑标注的 ±1 带对照、
失败原因。退出码：0 全部成功；1 有失败；2 环境/迁移问题。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import config  # noqa: E402
import difficulty  # noqa: E402

LEVEL_INDEX = {"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C1": 4, "C1+": 5}


def _read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def serving_items() -> list[tuple[str, str]]:
    """content/library 清单里的 3 视频 + 67 文章（随清单动态枚举）。"""
    library = Path(config.LIBRARY_DIR)
    items: list[tuple[str, str]] = []
    videos_path = library / "videos.json"
    articles_path = library / "articles.json"
    if videos_path.is_file():
        for video_id in _read_json(videos_path).get("videos") or []:
            if isinstance(video_id, str):
                items.append(("video", video_id))
    if articles_path.is_file():
        for article_id in _read_json(articles_path).get("articles") or []:
            if isinstance(article_id, str):
                items.append(("article", article_id))
    return items


def curated_items() -> list[tuple[str, str]]:
    path = Path(config.CURATED_CONTENT_PATH)
    if not path.is_file():
        return []
    data = _read_json(path)
    return [
        ("curated", item["videoId"])
        for item in data.get("items") or []
        if isinstance(item, dict) and isinstance(item.get("videoId"), str)
    ]


def _strip_volatile(features: dict) -> dict:
    copied = dict(features)
    copied.pop("computed_at", None)
    return copied


def _unchanged(existing: dict | None, payload: dict) -> bool:
    if existing is None:
        return False
    existing_features = existing.get("features") or {}
    new_features = payload.get("features") or {}
    if _strip_volatile(existing_features) != _strip_volatile(new_features):
        return False
    # get_row() 返回 camelCase 的对外形状；payload 仍是 DB 列名。
    for existing_key, payload_key in (
        ("cefrInput", "cefr_input"),
        ("lexicalBand", "lexical_band"),
        ("syntaxBand", "syntax_band"),
        ("level", "level"),
        ("method", "method"),
    ):
        if existing.get(existing_key) != payload.get(payload_key):
            return False
    return True


def backfill(
    items: list[tuple[str, str]], *, dry_run: bool = False
) -> dict:
    started = time.time()
    results: list[dict] = []
    payloads: list[dict] = []
    for kind, ref in items:
        entry = {"kind": kind, "ref": ref}
        try:
            content = difficulty.resolve_content(kind, ref)
            if content is None:
                entry.update(status="not_found", error="内容不存在")
                results.append(entry)
                continue
            features = difficulty.compute_for_content(content)
            payload = difficulty.payload_from_features(
                kind, ref, features, editorial_level=content.get("editorial_level")
            )
            entry["features"] = payload["features"]
            entry["cefrInput"] = payload.get("cefr_input")
            entry["level"] = payload.get("level")
            existing = difficulty.get_row(kind, ref) if not dry_run else None
            if _unchanged(existing, payload):
                entry["status"] = "skipped"
            else:
                entry["status"] = "computed"
                payloads.append(payload)
        except difficulty.DifficultyNotFound:
            entry.update(status="not_found", error="内容不存在")
        except difficulty.DifficultyInvalid as exc:
            entry.update(status="failed", error=str(exc))
        except difficulty.DifficultyUnavailable as exc:
            entry.update(status="failed", error=str(exc))
        except Exception as exc:  # noqa: BLE001 - 回填报告要保留真实原因
            entry.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        results.append(entry)

    written = 0
    if payloads and not dry_run:
        written = difficulty.upsert_payloads(payloads)

    computed = [item for item in results if item["status"] == "computed"]
    skipped = [item for item in results if item["status"] == "skipped"]
    failed = [item for item in results if item["status"] in ("failed", "not_found")]
    by_kind: dict[str, dict[str, int]] = {}
    by_band: dict[str, int] = {}
    editorial_band: dict[str, int] = {}
    band_distance: dict[str, int] = {}
    for item in results:
        if item.get("cefrInput"):
            by_band[item["cefrInput"]] = by_band.get(item["cefrInput"], 0) + 1
            if item.get("level") in LEVEL_INDEX and item["cefrInput"] in LEVEL_INDEX:
                distance = abs(
                    LEVEL_INDEX[item["cefrInput"]] - LEVEL_INDEX[item["level"]]
                )
                editorial_band[item["level"]] = editorial_band.get(item["level"], 0) + 1
                band_distance[str(distance)] = band_distance.get(str(distance), 0) + 1
        stats = by_kind.setdefault(item["kind"], {"total": 0, "computed": 0, "skipped": 0, "failed": 0})
        stats["total"] += 1
        stats["computed" if item["status"] == "computed" else "skipped" if item["status"] == "skipped" else "failed"] += 1

    total = len(results)
    return {
        "schema": "content-difficulty-backfill.v1",
        "generatedAt": int(time.time() * 1000),
        "durationMs": int((time.time() - started) * 1000),
        "dryRun": dry_run,
        "total": total,
        "attempted": total,
        "computed": len(computed),
        "skipped": len(skipped),
        "failed": len(failed),
        "written": written,
        "coverage": round((total - len(failed)) / total, 4) if total else 0.0,
        "byKind": by_kind,
        "byBand": dict(sorted(by_band.items())),
        "editorialBand": dict(sorted(editorial_band.items())),
        "bandDistance": dict(sorted(band_distance.items())),
        "failures": [
            {"kind": item["kind"], "ref": item["ref"], "status": item["status"], "error": item.get("error")}
            for item in failed
        ],
        "items": [
            {
                "kind": item["kind"],
                "ref": item["ref"],
                "status": item["status"],
                "level": item.get("level"),
                "cefrInput": item.get("cefrInput"),
                "error": item.get("error"),
            }
            for item in results
        ],
    }


def print_report(report: dict) -> None:
    print(
        f"回填 {report['total']} 条：computed={report['computed']} "
        f"skipped={report['skipped']} failed={report['failed']} "
        f"written={report['written']} coverage={report['coverage']:.1%}"
    )
    print("按 kind：", json.dumps(report["byKind"], ensure_ascii=False))
    print("按 cefr_input：", json.dumps(report["byBand"], ensure_ascii=False))
    print("编辑标注分布：", json.dumps(report["editorialBand"], ensure_ascii=False))
    print("带距离（|computed-editorial|）：", json.dumps(report["bandDistance"], ensure_ascii=False))
    if report["failures"]:
        print("失败：")
        for failure in report["failures"]:
            print(f" - {failure['kind']}:{failure['ref']} [{failure['status']}] {failure['error']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="回填 content_difficulty")
    parser.add_argument(
        "--only", choices=("all", "serving", "curated"), default="all"
    )
    parser.add_argument("--dry-run", action="store_true", help="只计算不写库")
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "data" / "reports" / "content-difficulty-backfill.json",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    items = []
    if args.only in ("all", "serving"):
        items.extend(serving_items())
    if args.only in ("all", "curated"):
        items.extend(curated_items())
    if not items:
        print("没有可回填的内容（检查 content/library 与 content/curated.json）", file=sys.stderr)
        return 2
    try:
        report = backfill(items, dry_run=args.dry_run)
    except difficulty.DifficultyUnavailable as exc:
        print(f"环境不可用：{exc}", file=sys.stderr)
        return 2
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print_report(report)
    print(f"报告已写入：{args.report}")
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
