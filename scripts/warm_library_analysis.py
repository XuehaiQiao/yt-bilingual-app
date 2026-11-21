#!/usr/bin/env python3
"""免费库教学分析预热（specs/024 2026-11-22 修订 + specs/028）。

把 ``content/library`` 的 55 个视频 + 67 篇文章，按 ``level × target_lang`` 逐条
走**与线上按需生成完全相同的路径**（``teaching_analysis.ensure_analysis``），
把结果写进全局缓存 ``content_teaching_analysis``。之后登录用户首次打开某档位
命中缓存（零模型调用、零配额），游客也能只读命中。

用法（仓库根目录）::

    # 只看待生成条数与预估费用（不调模型、不写库）
    backend/venv/bin/python scripts/warm_library_analysis.py --user-id <uid> --dry-run

    # 真跑（中文全部 6 档；确认后自动跳过已有缓存、可随时中断续跑）
    backend/venv/bin/python scripts/warm_library_analysis.py --user-id <uid> --yes

    # 指定档位/语言/并发（档位可用 A1–C2 或 liftoff…supernova）
    backend/venv/bin/python scripts/warm_library_analysis.py --user-id <uid> \
        --level A1,A2,B1,B2,C1 --lang zh-CN --concurrency 2 --yes

行为：

- **断点续跑**：同一 ``(content_hash, level, target_lang, analysis_version)``
  已缓存就跳过，不扣费；中途失败下次再跑只补缺失项；
- **计费**：走既有 ``feature=analysis`` 配额/余额/账本路径，按 ``--user-id``
  归属；缓存命中不写用量。用户不存在直接报错（不猜、不代开）；
- **并发 1–2**（默认 1）；每条形如
  ``video <id> level=<档> lang=<lang> 生成 in=… out=… $…``，末尾汇总；
- ``--dry-run``（或没带 ``--yes``）只统计条数/费用：按真实 prompt 文本估算
  输入 token、按候选词全量释义估算输出 token，再乘目标模型当前价目表，属
  **保守上界**；实际花费以逐条 ``ai_usage`` 为准。

日配额：``analysis`` 默认每用户每天 30 次（``AI_DAILY_QUOTA_ANALYSIS``），远小于
全量预热条数。脚本开跑前会检查「今日剩余配额」，不够时直接给出可复制的重跑
命令（用环境变量只提高本次进程的上限，不改 .env、不写库配置）::

    AI_DAILY_QUOTA_ANALYSIS=4000 backend/venv/bin/python scripts/warm_library_analysis.py --user-id <uid> --yes

余额/日预算（``AI_DAILY_BUDGET_USER_USD`` 默认 $1）仍是真实硬闸：预估费用
超过余额/预算时脚本只警告（预估是上界），实际超限会在 429/402 处停下——已生成
的部分都已落缓存，次日/加额后可续跑。

退出码：0 全部完成（含本来就已缓存）；1 有失败条目；2 环境/迁移/参数问题。
"""
from __future__ import annotations

import argparse
import asyncio
import contextvars
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import auth_db  # noqa: E402
import billing  # noqa: E402
import config  # noqa: E402
import languages  # noqa: E402
import routes_library  # noqa: E402
import teaching_analysis  # noqa: E402
from ai import ledger, quota  # noqa: E402
from ai.ledger import QuotaExceeded  # noqa: E402

# CLI 允许的 CEFR 简写 → 028 内部档位 id（前端滑块 id 不变）。
CEFR_TO_LEVEL = {
    "A1": "liftoff",
    "A2": "orbit",
    "B1": "moonwalk",
    "B2": "interstellar",
    "C1": "deep-space",
    "C2": "supernova",
}
DEFAULT_LEVELS = ",".join(teaching_analysis.LEVEL_IDS)
DEFAULT_LANG = languages.DEFAULT_TARGET_LANG

# token 估算系数（保守上界）：英文按 ~1.3 token/词、CJK 按 ~1.7 字符/token、
# 标点与 JSON 结构按 ~4 字符/token。只用于 --dry-run 预估，不参与计费。
_WORD_RE = re.compile(r"[A-Za-z]+")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
OUTPUT_TOKENS_PER_HIGHLIGHT = 18
OUTPUT_TOKENS_PER_IDIOM = 28
OUTPUT_TOKENS_PER_CULTURE = 32

# 每条的实测用量由 ai.ledger.insert_usage 累积到当前任务（billing.settle 与
# record_usage 两条写路径都会经过它；asyncio.to_thread 会复制 contextvars）。
_TASK_USAGE: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "warm_library_task_usage", default=None
)
_ORIGINAL_INSERT_USAGE = ledger.insert_usage


def _instrument_ledger() -> None:
    """给 ai_usage 写入挂钩，按任务统计 tokens/费用（只统计 feature=analysis）。"""

    def _insert_usage(conn, fields, **kwargs):
        row = _ORIGINAL_INSERT_USAGE(conn, fields, **kwargs)
        task = _TASK_USAGE.get()
        if task is not None and isinstance(fields, dict) and fields.get("feature") == "analysis":
            task["input_tokens"] += int(fields.get("input_tokens") or 0)
            task["output_tokens"] += int(fields.get("output_tokens") or 0)
            task["cost_usd"] += float(fields.get("est_cost_usd") or 0.0)
            task["calls"] += int(fields.get("calls") or 1)
            task["model"] = fields.get("model_id") or task["model"]
        return row

    ledger.insert_usage = _insert_usage


@dataclass(frozen=True)
class Content:
    kind: str  # "videos" / "articles"（content/library 子目录名）
    entry_id: str
    title: str
    blocks: list[dict]
    words: int


@dataclass(frozen=True)
class Task:
    content: Content
    level: str
    lang: str

    @property
    def label(self) -> str:
        return f"{self.content.kind[:-1]} {self.content.entry_id} level={self.level} lang={self.lang}"


@dataclass
class Estimate:
    input_tokens: int
    output_tokens: int
    cost_usd: float


# ---------------------------------------------------------------------------
# 参数解析 / 预检
# ---------------------------------------------------------------------------

def _fail(message: str) -> None:
    print(f"错误：{message}", file=sys.stderr)
    raise SystemExit(2)


def _parse_levels(raw: str) -> list[str]:
    levels: list[str] = []
    for part in (raw or "").split(","):
        token = part.strip()
        if not token:
            continue
        token = CEFR_TO_LEVEL.get(token.upper(), token)
        try:
            level = teaching_analysis.normalize_level(token)
        except teaching_analysis.AnalysisInvalidRequest as exc:
            _fail(f"--level 含非法档位 {part!r}：{exc}")
        if level not in levels:
            levels.append(level)
    if not levels:
        _fail("--level 不能为空（可用 A1–C2 或 liftoff/orbit/moonwalk/interstellar/deep-space/supernova）")
    return levels


def _parse_langs(raw: str) -> list[str]:
    langs: list[str] = []
    for part in (raw or "").split(","):
        token = part.strip()
        if not token:
            continue
        try:
            lang = languages.resolve_target_lang(token)
        except languages.UnsupportedLanguage as exc:
            _fail(f"--lang 含不支持的语言 {part!r}：{exc}")
        if lang not in langs:
            langs.append(lang)
    if not langs:
        _fail("--lang 不能为空（例如 zh-CN / vi-VN）")
    return langs


def _load_contents() -> list[Content]:
    """读并校验全部内容（与详情端点同一套校验/分析块口径）。"""
    library = Path(config.LIBRARY_DIR)
    contents: list[Content] = []
    for kind, manifest_name in (("videos", "videos.json"), ("articles", "articles.json")):
        manifest_path = library / manifest_name
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            ids = manifest[kind]
        except (OSError, ValueError, KeyError) as exc:
            _fail(f"读取 {manifest_path} 失败：{exc}")
        for entry_id in ids:
            try:
                payload = routes_library.load_payload(kind, entry_id)
            except Exception as exc:  # noqa: BLE001 - 内容坏就整体报错，不静默漏条
                _fail(f"读取免费资源 {kind}/{entry_id} 失败：{exc}")
            blocks = routes_library.analysis_blocks(kind, payload)
            if not blocks:
                _fail(f"免费资源 {kind}/{entry_id} 没有可分析的英文内容")
            words = sum(len(_WORD_RE.findall(block.get("en_text") or "")) for block in blocks)
            contents.append(
                Content(
                    kind=kind,
                    entry_id=entry_id,
                    title=str(payload.get("title") or entry_id),
                    blocks=blocks,
                    words=words,
                )
            )
    return contents


def _table_exists(name: str) -> bool:
    import sqlite3

    try:
        with sqlite3.connect(config.AUTH_DB_PATH) as conn:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (name,)
            ).fetchone()
    except sqlite3.Error:
        return False
    return row is not None


def _preflight(user_id: str, *, real_run: bool) -> dict:
    """身份/迁移/模型与配额预检；返回可复用的环境信息。"""
    db_path = config.AUTH_DB_PATH
    if not db_path or not Path(db_path).is_file():
        _fail(
            f"数据库不存在：{db_path!r}（先跑 alembic upgrade head，或用 AUTH_DB_PATH 指向线上库）"
        )
    user = auth_db.get_user_by_id(user_id)
    if user is None:
        _fail(f"--user-id 不存在：{user_id!r}（不会自动创建账号）")
    if not _table_exists(teaching_analysis.TABLE):
        _fail("缺少 content_teaching_analysis 表（先运行 `backend/venv/bin/alembic upgrade head`）")

    chain = quota.degradation_chain(teaching_analysis.FEATURE)
    model = chain[0] if chain else config.DEFAULT_MODEL

    if real_run:
        if not billing.schema_ready():
            _fail("计费表未就绪（未跑 0025 迁移）；预热必须走真实计费路径，先 `alembic upgrade head`")
        if not chain:
            _fail("当前没有可用模型（检查 .env 的模型 Key 与 model_prices 单价）")
        if billing.price_for_model(model) is None:
            _fail(f"模型 {model} 没有可核实单价（model_prices），严格计费会 503 model_unpriced")

    return {"user": user, "model": model, "chain": chain}


def _quota_status(user_id: str) -> tuple[int, int]:
    """(已用, 日上限)；读不到配额表时按 fail-open 返回 (0, 0 表示未知)。"""
    limit = int(getattr(config, "AI_DAILY_QUOTA_ANALYSIS", 0) or 0)
    try:
        usage = ledger.daily_usage(user_id, teaching_analysis.FEATURE)
    except Exception:  # noqa: BLE001 - 配额表不可用时运行期 fail-open
        return 0, 0
    used = int(((usage.get("quota") or {}).get("used_units")) or 0)
    return used, limit


def _price_for_estimate(model_id: str) -> tuple[float, float, str]:
    """(in $/Mtok, out $/Mtok, 来源)；与真实计费同源，缺价回落到目录上界。"""
    try:
        if billing.schema_ready():
            price = billing.price_for_model(model_id)
            if price is not None:
                return (
                    price["inputMicroUsdPerMtok"] / 1_000_000,
                    price["outputMicroUsdPerMtok"] / 1_000_000,
                    f"model_prices({price.get('priceVersion') or price.get('sourceKind')})",
                )
    except Exception:  # noqa: BLE001 - 只影响预估展示
        pass
    in_price, out_price = ledger.price_for(model_id)
    return in_price, out_price, "MODEL_CATALOG/known-ceiling"


# ---------------------------------------------------------------------------
# 预估（dry-run）
# ---------------------------------------------------------------------------

def _estimate_tokens(text: str) -> int:
    cjk = len(_CJK_RE.findall(text))
    words = _WORD_RE.findall(text)
    tokens = len(words) * 1.3 + cjk / 1.7 + (len(text) - cjk - sum(len(w) for w in words)) / 4
    return max(1, int(tokens))


def _estimate_task(task: Task, model_id: str) -> Estimate:
    normalized = teaching_analysis.normalize_blocks(task.content.blocks)
    candidates = teaching_analysis._candidate_words_for_blocks(normalized, task.level)
    prompt = teaching_analysis.build_prompt(normalized, task.level, task.lang, candidates)
    input_tokens = _estimate_tokens(prompt)
    highlight_count = sum(len(items) for items in candidates.values())
    output_tokens = (
        highlight_count * OUTPUT_TOKENS_PER_HIGHLIGHT
        + min(teaching_analysis.MAX_IDIOMS, len(normalized)) * OUTPUT_TOKENS_PER_IDIOM
        + min(teaching_analysis.MAX_CULTURE, len(normalized)) * OUTPUT_TOKENS_PER_CULTURE
    )
    in_price, out_price, _ = _price_for_estimate(model_id)
    cost = (input_tokens * in_price + output_tokens * out_price) / 1_000_000
    return Estimate(input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=cost)


def _build_plan(
    contents: list[Content], levels: list[str], langs: list[str]
) -> tuple[list[Task], list[Task]]:
    """返回 (待生成任务, 已缓存任务)；顺序：lang → level → 内容。"""
    pending: list[Task] = []
    cached: list[Task] = []
    for lang in langs:
        for level in levels:
            for content in contents:
                task = Task(content=content, level=level, lang=lang)
                if teaching_analysis.reusable_cached_analysis(
                    content.blocks, level, lang
                ) is not None:
                    cached.append(task)
                else:
                    pending.append(task)
    return pending, cached


def _print_plan(
    contents: list[Content],
    levels: list[str],
    langs: list[str],
    pending: list[Task],
    cached: list[Task],
    model_id: str,
    estimates: list[Estimate],
) -> None:
    videos = sum(1 for content in contents if content.kind == "videos")
    articles = len(contents) - videos
    total = len(pending) + len(cached)
    print(
        f"内容：{videos} 视频 + {articles} 文章 = {len(contents)} 条 "
        f"（{sum(content.words for content in contents):,} 英文词）"
    )
    print(f"档位：{', '.join(levels)}（{len(levels)}）｜目标语言：{', '.join(langs)}（{len(langs)}）")
    print(f"模型：{model_id}（预估价目）")
    print(f"任务：{total}；已缓存：{len(cached)}；待生成：{len(pending)}")
    if not estimates:
        return
    input_tokens = sum(item.input_tokens for item in estimates)
    output_tokens = sum(item.output_tokens for item in estimates)
    cost = sum(item.cost_usd for item in estimates)
    _, _, price_source = _price_for_estimate(model_id)
    print(f"价目来源：{price_source}")
    print(
        f"预估（保守上界）：输入 {input_tokens:,} tokens / 输出 {output_tokens:,} tokens "
        f"≈ ${cost:.4f}"
    )
    per_task = cost / len(estimates)
    print(f"平均每条 ≈ ${per_task:.4f}；按实际缓存写入/模型返回减少，真实费用以 ai_usage 为准。")
    print(
        "参考：specs/024 记录「单档单语言全量约 $0.10」；本预估按 prompt 实文"
        "（含双语 + 候选词）与候选词全量释义取上界，通常高于实测。"
    )


# ---------------------------------------------------------------------------
# 真实执行
# ---------------------------------------------------------------------------

def _fmt_usd(value: float) -> str:
    return f"${value:.4f}" if value >= 0.0001 else f"${value:.6f}"


async def _run_tasks(tasks: list[Task], user_id: str, concurrency: int) -> dict:
    stats = {
        "generated": 0,
        "failed": 0,
        "skipped": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "consecutive_failures": 0,
        "abort_reason": None,
    }
    semaphore = asyncio.Semaphore(concurrency)
    abort = asyncio.Event()
    total = len(tasks)
    started_at = time.perf_counter()

    async def worker(index: int, task: Task) -> None:
        async with semaphore:
            if abort.is_set():
                stats["skipped"] += 1
                return
            usage = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "calls": 0, "model": None}
            token = _TASK_USAGE.set(usage)
            started = time.perf_counter()
            try:
                await teaching_analysis.ensure_analysis(
                    task.content.blocks,
                    task.level,
                    task.lang,
                    content_ref=f"library:{task.content.entry_id}",
                    user_id=user_id,
                )
            except (QuotaExceeded, billing.BillingError) as exc:
                stats["failed"] += 1
                stats["abort_reason"] = f"{type(exc).__name__}: {exc}"
                abort.set()
                elapsed = time.perf_counter() - started
                print(f"[{index:3d}/{total}] {task.label} 失败（硬闸，停止后续）：{exc}（{elapsed:.1f}s）")
            except Exception as exc:  # noqa: BLE001 - 逐条失败继续，最后汇总
                stats["failed"] += 1
                stats["consecutive_failures"] += 1
                elapsed = time.perf_counter() - started
                print(f"[{index:3d}/{total}] {task.label} 失败：{type(exc).__name__}: {exc}（{elapsed:.1f}s）")
                if stats["consecutive_failures"] >= 3 and not abort.is_set():
                    stats["abort_reason"] = "连续失败 3 条，停止后续（多半是模型/Key/单价问题）"
                    abort.set()
            else:
                stats["generated"] += 1
                stats["consecutive_failures"] = 0
                stats["input_tokens"] += usage["input_tokens"]
                stats["output_tokens"] += usage["output_tokens"]
                stats["cost_usd"] += usage["cost_usd"]
                elapsed = time.perf_counter() - started
                if usage["calls"]:
                    detail = (
                        f"in={usage['input_tokens']:,} out={usage['output_tokens']:,} "
                        f"{_fmt_usd(usage['cost_usd'])}"
                    )
                else:
                    detail = "已写入缓存（未记录到 ai_usage）"
                print(
                    f"[{index:3d}/{total}] {task.label} 生成 {detail}"
                    f"（{elapsed:.1f}s，{usage['model'] or '?'}）"
                )
            finally:
                _TASK_USAGE.reset(token)

    await asyncio.gather(*(worker(index + 1, task) for index, task in enumerate(tasks)))
    stats["elapsed"] = time.perf_counter() - started_at
    return stats


def _print_summary(stats: dict, total: int) -> None:
    elapsed = stats["elapsed"]
    print("-" * 72)
    print(
        f"汇总：任务 {total}｜生成 {stats['generated']}｜失败 {stats['failed']}｜"
        f"中止后跳过 {stats['skipped']}"
    )
    if stats["generated"]:
        print(
            f"实测：输入 {stats['input_tokens']:,} tokens / 输出 {stats['output_tokens']:,} "
            f"tokens ≈ {_fmt_usd(stats['cost_usd'])}（来自 ai_usage 逐条累计）"
        )
    if stats["abort_reason"]:
        print(f"提前停止：{stats['abort_reason']}")
    print(f"耗时 {elapsed:.1f}s")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="免费库视频/文章教学分析预热（按 level × target_lang 写全局缓存）",
    )
    parser.add_argument("--user-id", required=True, help="计费归属用户 id（必须已存在）")
    parser.add_argument(
        "--level",
        default=DEFAULT_LEVELS,
        help=f"逗号分隔档位；CEFR A1–C2 或 {','.join(teaching_analysis.LEVEL_IDS)}（默认全部 6 档）",
    )
    parser.add_argument("--lang", default=DEFAULT_LANG, help=f"逗号分隔目标语言（默认 {DEFAULT_LANG}）")
    parser.add_argument("--dry-run", action="store_true", help="只统计条数与预估费用，不调模型、不写库")
    parser.add_argument("--yes", action="store_true", help="确认真跑（不带 --yes 等同 dry-run）")
    parser.add_argument("--concurrency", type=int, choices=(1, 2), default=1, help="并发任务数（1–2，默认 1）")
    args = parser.parse_args(argv)

    levels = _parse_levels(args.level)
    langs = _parse_langs(args.lang)
    real_run = bool(args.yes and not args.dry_run)

    env = _preflight(args.user_id, real_run=real_run)
    model_id = env["model"]
    contents = _load_contents()
    pending, cached = _build_plan(contents, levels, langs)
    estimates = [_estimate_task(task, model_id) for task in pending]
    _print_plan(contents, levels, langs, pending, cached, model_id, estimates)
    estimated_cost = sum(item.cost_usd for item in estimates)

    if not real_run:
        if not args.dry_run:
            print("未带 --yes：按 dry-run 处理，未调用模型、未写库。")
        else:
            print("dry-run：未调用模型、未写库。")
        if pending:
            used, limit = _quota_status(args.user_id) if _table_exists("ai_quota") else (0, 0)
            if limit:
                print(f"今日 analysis 配额：已用 {used}/{limit}；本次待生成 {len(pending)}。")
                if len(pending) > max(0, limit - used):
                    print(
                        f"提示：配额不足，真跑前可临时提高本次进程上限："
                        f"AI_DAILY_QUOTA_ANALYSIS={used + len(pending)} "
                        f"backend/venv/bin/python scripts/warm_library_analysis.py "
                        f"--user-id {args.user_id} --level {','.join(levels)} "
                        f"--lang {','.join(langs)} --concurrency {args.concurrency} --yes"
                    )
        return 0

    if not pending:
        print("所有内容/档位/语言都已有缓存，无需生成。")
        return 0

    user = env["user"]
    try:
        balance = billing.get_balance(user["id"])
    except billing.BillingError as exc:
        _fail(f"读取余额失败：{exc}")
    available = int(balance["availableMicroUsd"]) / 1_000_000
    if estimated_cost > available:
        print(
            f"警告：预估上界 {_fmt_usd(estimated_cost)} 超过可用余额 {_fmt_usd(available)}；"
            "真实花费通常更低，但超限会在 402 处停止（已生成部分已缓存，充值后可续跑）。"
        )

    used, limit = _quota_status(args.user_id)
    retry_env = [f"AI_DAILY_QUOTA_ANALYSIS={used + len(pending) if limit else len(pending)}"]
    try:
        today_spend = ledger.daily_spend(user["id"])
        budget = float(getattr(config, "AI_DAILY_BUDGET_USER_USD", 0) or 0)
        if budget > 0 and today_spend + estimated_cost > budget:
            needed_budget = round((today_spend + estimated_cost) * 1.2 + 0.01, 2)
            retry_env.append(f"AI_DAILY_BUDGET_USER_USD={needed_budget:g}")
            print(
                f"警告：预估上界 {_fmt_usd(estimated_cost)} + 今日已花 {_fmt_usd(today_spend)} "
                f"超过用户日预算 ${budget:.2f}；超限会 429。可临时提高 "
                f"AI_DAILY_BUDGET_USER_USD（只影响本次进程）。"
            )
    except Exception as exc:  # noqa: BLE001 - 预算展示失败不阻断
        print(f"提示：读取今日预算失败（{exc}），跳过预算检查。")

    if limit == 0:
        _fail("analysis 日配额为 0（AI_DAILY_QUOTA_ANALYSIS），无法生成；请先调高再运行")
    if len(pending) > max(0, limit - used):
        _fail(
            f"今日 analysis 配额不够：剩余 {max(0, limit - used)}，本次待生成 {len(pending)}。"
            f"这样重新运行（只影响本次进程，不改 .env）："
            f"{' '.join(retry_env)} backend/venv/bin/python scripts/warm_library_analysis.py "
            f"--user-id {args.user_id} --level {','.join(levels)} --lang {','.join(langs)} "
            f"--concurrency {args.concurrency} --yes"
        )

    _instrument_ledger()
    print(f"开始预热：{len(pending)} 条，并发 {args.concurrency}，模型 {model_id}。")
    try:
        stats = asyncio.run(_run_tasks(pending, user["id"], args.concurrency))
    finally:
        ledger.insert_usage = _ORIGINAL_INSERT_USAGE
    _print_summary(stats, len(pending))
    if stats["failed"] or stats["abort_reason"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
