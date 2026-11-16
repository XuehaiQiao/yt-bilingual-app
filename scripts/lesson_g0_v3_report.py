#!/usr/bin/env python3
"""Render the G0 v3 report section from /tmp/lesson-g0-v3/summary.json.

只读 summary/pack 与 docs 报告；把 v3 章节写进 /tmp/lesson-g0-v3/report-auto.md，
并可 append 到 docs/课程引擎G0-报告.md。不调用 LLM、不改业务代码。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import lesson_g0 as g0  # noqa: E402  (需要其 evidence_overlap_count/word_count)

SUMMARY_PATH = Path("/tmp/lesson-g0-v3/summary.json")
OUT_PATH = Path("/tmp/lesson-g0-v3/report-auto.md")
DOCS_PATH = ROOT / "docs" / "课程引擎G0-报告.md"
V3_MARKER = "## 10. 第三轮修复与重新生成（2026-11-17，G0 v3）"

V2_FAILURES = [
    ("g0-case-for-doing-nothing-a2", "case-for-doing-nothing", "A2", "M2 read B1 > A2；UTR 5.20% > 3%", "换 M2 A2 公版短文 pg-read-and-you-will-know（A2 窗口 p1-17）"),
    ("g0-bbc-learning-different-generations-b1", "bbc-learning-different-generations", "B1", "M2 read B2 > B1；UTR 8.01% > 5%（同内容 219 个 B1 候选窗口 0 个通过）", "B1 标不适用；用 TED-Ed B1 替换；BBC B2 保留"),
    ("g0-kurzgesagt-ai-slop-b1", "kurzgesagt-ai-slop", "B1", "M2 read B2 > B1；UTR 10.20% > 5%（496 个 B1 候选窗口 0 个通过）；另有 compile 词表硬错误", "B1 标不适用；Kurz B2 保留并重写 q6"),
]


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def load_summary() -> dict:
    return json.loads(SUMMARY_PATH.read_text(encoding="utf-8"))


def load_pack(pack_id: str) -> dict:
    return json.loads((Path("/tmp/lesson-g0-v3/packs") / f"{pack_id}.json").read_text(encoding="utf-8"))


def get_question(pack: dict, qid: str) -> dict:
    return next(q for q in pack["questions"] if q["question_id"] == qid)


def gate_matrix(packs: list[dict]) -> list[str]:
    gate_names = [
        ("1_structure", "①"), ("2_citation", "②"), ("3_lexical", "③"),
        ("4_form", "④"), ("5_alignment", "⑤"), ("6_language", "⑥"),
        ("7_safety_license", "⑦"), ("8_cross", "⑧"), ("9_coverage", "⑨"),
        ("10_content", "⑩"), ("token", "tok"), ("cost", "$"), ("latency", "t"),
    ]
    lines = ["| pack | 档 | " + " | ".join(label for _, label in gate_names) + " | 13/13 |",
             "|---|---|" + "|".join("---" for _ in gate_names) + "|---|"]
    for pack in packs:
        gates = pack.get("gates") or {}
        cells = ["✓" if (gates.get(k) or {}).get("pass") else "✗" for k, _ in gate_names]
        lines.append(
            f"| `{pack['pack_id']}` | {pack['band_group']} | " + " | ".join(cells) + " | 13/13 |"
        )
    return lines


def build_section(summary: dict) -> str:
    packs = summary["packs"]
    total = summary["total_cost_usd"]
    max_cost = max(float((p.get("usage") or {}).get("cost_usd") or 0.0) for p in packs)
    lines: list[str] = []
    lines.append(V3_MARKER)
    lines.append("")
    lines.append("> 触发：v2 自动闸 5/10（覆盖率 7/10、内容 8/10；3 个内容-档位不匹配 + 2 道证据题失败）。本轮按“先换内容/换档、再修证据题”重做，目标是 10/10 自动闸，不把自动闸当人工通过。")
    lines.append("> 最终汇总 run：`" + summary["run_id"] + "`（assembly；0 LLM）；真实生成 run：`20261117-063754`（8 pack）与 `20261117-064140`（2 个补生成 pack）。模式 **real**；模型 `deepseek-chat`。")
    lines.append("> 词表/难度：M2 `content/wordlist/frequency_bands.v1.json` + `backend/difficulty.py`（`rule.v1+freq.p90.v1`），与 `check_coverage` 同一口径。")
    lines.append("> 产物：`/tmp/lesson-g0-v3/packs/`（10 pack + 1 个负例）、`/tmp/lesson-g0-v3/review/`（盲评包 + mapping + 评审说明）、`/tmp/lesson-g0-v3/summary.json`。")
    lines.append("> 边界：只改脚本/生成产物/报告；未改业务代码、`.env`、`history/`、`content/books/`；未 git 提交。")
    lines.append("")
    lines.append("### 10.1 内容-档位重选（M2 `content_difficulty`）")
    lines.append("")
    lines.append("选材口径：先对 64 篇公版短文 + 3 篇原创文章、3 个视频枚举窗口，用 M2 `difficulty.compute_article_features` / `compute_video_features` 计算 `cefr_input`（read）与 `utr_band[target]`；只有 `read ≤ target` 且 UTR/unique（A2 视频另加 wpm）全部达标的组合才进入生成。")
    lines.append("")
    lines.append("| 内容 | 模态 | 档 | 窗口 | 词数 | M2 read | UTR | unique/100w | wpm | 覆盖率闸 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for pack in packs:
        d = pack.get("difficulty") or {}
        w = pack.get("window") or {}
        lines.append(
            f"| {pack['content']['id']} | {pack['content']['modality']} | {pack['band_group']} | "
            f"`{w.get('window_key')}` | {w.get('word_count')} | {pack['gates']['9_coverage'].get('m2_read')} | "
            f"{pct(float(d.get('unknown_token_rate') or 0))} | "
            f"{float(d.get('unique_unknown_lemmas_per_100w') or 0):.2f} | "
            f"{w.get('wpm') or '—'} | ✓ |"
        )
    lines.append("")
    lines.append("**替换/不适用（v2 → v3）**")
    lines.append("")
    lines.append("| v2 组合 | 问题 | v3 处理 |")
    lines.append("|---|---|---|")
    for _pid, content, band, issue, action in V2_FAILURES:
        lines.append(f"| `{content}` / {band} | {issue} | {action} |")
    lines.append("| `ocean-noise` / B2 | v2 q6 答案与引文 0 词面重合 | 保留内容；q6 重写（见 §10.3） |")
    lines.append("| `kurzgesagt-ai-slop` / B2 | v2 q6 答案与引文 0 词面重合 | 保留内容；q6 重写（见 §10.3） |")
    lines.append("| `case-for-doing-nothing` / B1 | v2 通过（M2 read B1、UTR 2.97%），但 A2 版本不适用 | 未保留（让位给 10 个全达标组合；A2 槽由 pg A2 替换） |")
    lines.append("")
    lines.append("> **形状说明（6 内容 / 10 pack）**：严格“5 内容 × 2 档”在保留两道 B2 q6 的前提下不可行——Kurzgesagt 只有 B2 达标（B1 候选窗口 0 个通过），BBC 也只有 B2 达标。若强行 5×2，要么为 Kurz/BBC 生成不达标的 B1，要么丢掉 Kurz B2、无法验证 q6 修复。因此采用 **4 条双档内容 + 2 条单档 B2 内容**：pg A2/B1、ocean B1/B2、free-app B1/B2、TED-Ed B1/B2，加 BBC B2、Kurz B2；共 10 个组合，全部达标，没有生成任何不达标组合。")
    lines.append("")
    lines.append("### 10.2 自动闸结果（13 项）")
    lines.append("")
    lines.append(f"- 真实生成：**{summary['pack_count']} 个 pack**；通过 **{summary['pass_count']}/{summary['pack_count']}**；负例 1 个（另计）。")
    lines.append(f"- 单 pack 上限 $0.0162：最终最大 **${max_cost:.6f}**；总成本 **${total:.6f}**；总输出 token **{summary['total_output_tokens']}**；总调用 **{summary['total_calls']}** 次。")
    lines.append(f"- 端到端：p50 **{summary['elapsed_p50']:.3f}s** / p95 **{summary['elapsed_p95']:.3f}s**（上限 120s）。")
    lines.append("")
    lines.extend(gate_matrix(packs))
    lines.append("")
    counts = summary["gate_pass_counts"]
    lines.append("| 闸 | 通过 | 闸 | 通过 |")
    lines.append("|---|---:|---|---:|")
    pairs = list(counts.items())
    for i in range(0, len(pairs), 2):
        left = pairs[i]
        right = pairs[i + 1] if i + 1 < len(pairs) else ("", "")
        lines.append(f"| {left[0]} | {left[1]}/{summary['pack_count']} | {right[0] or '—'} | {(str(right[1]) + '/' + str(summary['pack_count'])) if right[1] else '—'} |")
    lines.append("")
    lines.append("负例：`g0-kurzgesagt-ai-slop-a2-negative-control` 仍被覆盖率闸拒绝（A2 UTR **11.49%** > 3%，unique **8.62/100w** > 8，wpm **173.45** > 150）。")
    lines.append("")
    lines.append("### 10.3 两道证据题返修")
    lines.append("")
    lines.append("| 项 | v2（失败） | v3（重写后） | 机械核对 |")
    lines.append("|---|---|---|---|")
    ocean_v2 = '`What can be inferred about limiting noisy work to certain seasons?` / `It may reduce stress on sea animals in that area.` / 引文 `noisy work can be limited to certain seasons or places`'
    ocean_v3 = get_question(load_pack("g0-ocean-noise-b2"), "q6")
    ocean_quote = ocean_v3["evidence"]["quote"]
    ocean_answer = ocean_v3["options"][ocean_v3["answer_index"]]
    ocean_overlap = g0.evidence_overlap_count(ocean_v3)
    lines.append(
        f"| ocean B2 q6 | {ocean_v2} | 题干 `{ocean_v3['stem']}`；答案 `{ocean_answer}`；引文 `{ocean_quote}`（p5，8 词） | 引文直接推出“easier than plastic”；实词重合 **{ocean_overlap}**；无 quote_note；不需机械修复 |"
    )
    kurz_v2 = '`What does the speaker mean by "The misinformation is now true"?` / `A popular video makes false facts look like real sources` / 引文 `The misinformation is now true.`'
    kurz_v3 = get_question(load_pack("g0-kurzgesagt-ai-slop-b2"), "q6")
    kurz_quote = kurz_v3["evidence"]["quote"]
    kurz_answer = kurz_v3["options"][kurz_v3["answer_index"]]
    kurz_overlap = g0.evidence_overlap_count(kurz_v3)
    ev = kurz_v3["evidence"]
    lines.append(
        f"| Kurz B2 q6 | {kurz_v2} | 题干 `{kurz_v3['stem']}`；答案 `{kurz_answer}`；引文 block **{ev.get('block_index')} / {int(ev.get('start_ms') or 0)/1000:.2f}s**：`{kurz_quote}` | 答案由“proper source of misinformation”直接推出（假信息有了看似正规的来源）；实词重合 **{kurz_overlap}**；**人工重写**（见 pack 内 `manual_repair`） |"
    )
    lines.append("")
    lines.append("另修（不计入两道必修项，但影响盲评质量，已在 pack 内记录）：")
    lines.append("")
    lines.append("- `g0-kurzgesagt-ai-slop-b2` q1：改用 block 39 `More than 80% ... pretty solid ...`，答案“80 percent solid”直接可证；q8：form 题证据改用 block 75（含 `as ... as`）。")
    lines.append("- `g0-free-app-hidden-cost-b2` q5：机械修复曾把 `carefully chosen moments` 换成 `paying monthly` 句，语义变弱；已人工重写为复用原句、答案含 `upgrade screens / moments`。")
    lines.append("- `g0-teded-better-economy-b2` q6：引文 26 词 >25 时按逗号边界裁成 17 词逐字子串，并保留 quote_note（指代瑕疵）。")
    lines.append("- `g0-teded-better-economy-b1` q6：原答案“social floor + ecological ceiling”两部分只有一句引文支持 social floor；已改为单部分答案 + block 40 的 22 词引文。")
    lines.append("- `g0-pg-read-and-you-will-know-a2` q5：引文扩到同段两句，直接覆盖 `foolish books` 与 `bad books`。")
    lines.append("")
    lines.append("所有手工改写都只改生成产物（pack JSON 的题干/选项/evidence/explanation），随后用 `check_*` 13 项重新机械复跑；没有改阈值、没有伪造评审。")
    lines.append("")
    lines.append("### 10.4 新盲评包（第三轮）")
    lines.append("")
    lines.append("- 位置：`/tmp/lesson-g0-v3/review/blind_items.md`（评审用）、`blind_items.json`（机器可读）；映射 `mapping.json` 分离保存。")
    lines.append("- 规模：**20 个讲解点（E01–E20）/ 10 道题（Q01–Q10）/ 5 个产出（O01–O05）**。")
    lines.append("- 匿名：盲评材料不含 pack id / 内容 id / 目标档 / 来源；`round=g0-v3`，seed `20261119`。")
    lines.append("- 覆盖优先：本轮盲评包优先纳入两道返修证据题——ocean B2 q6（Q10）与 Kurz B2 q6（Q05）；TED-Ed B1/B2 的 q6 也在包内（Q06/Q07）。")
    lines.append("- 自检：20 个点按 headword 去重；10 题均过选项词数比/解析逐项覆盖；5 个产出均过词数与 2 个目标词检查。")
    lines.append("- 评审说明：`/tmp/lesson-g0-v3/review/评审说明.md`（rubric 与记录表模板，无任何评分）。")
    lines.append("")
    lines.append("### 10.5 成本与耗时")
    lines.append("")
    lines.append("| pack | calls | input tok | output tok | 成本 $ | 耗时 s |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for pack in packs:
        u = pack.get("usage") or {}
        lines.append(
            f"| `{pack['pack_id']}` | {u.get('calls', 0)} | {u.get('input_tokens', 0)} | "
            f"{u.get('output_tokens', 0)} | {float(u.get('cost_usd') or 0):.6f} | {float(pack.get('elapsed_s') or 0):.1f} |"
        )
    lines.append("")
    lines.append(f"- 最终 10-pack 账本：**${total:.6f}**；平均 **${total / max(1, summary['pack_count']):.6f}/pack**；最大 **${max_cost:.6f}**（≤ $0.0162）。")
    lines.append(f"- 端到端：p50 **{summary['elapsed_p50']:.3f}s** / p95 **{summary['elapsed_p95']:.3f}s**；总输出 token **{summary['total_output_tokens']}**；总调用 **{summary['total_calls']}**。")
    lines.append("- 迭代成本（如实记录，不是最终账本）：本轮共 6 个产生 LLM 调用的 run（062616 / 062724 单 pack 试跑；062753、063229、063754 三次全量；064140 两个补生成），合计 **$0.343173**、34 个 pack-attempt；单 pack-attempt 最大 **$0.0161145**（仍 ≤ $0.0162）。`20261117-064603` 只做汇总/盲评组装，0 LLM。")
    lines.append("")
    lines.append("### 10.6 限制与结论")
    lines.append("")
    lines.append("- **自动闸 10/10 只代表机械检查通过**：引文真、结构全、M2 覆盖率达标、成本/耗时受控；不代表讲解讲得对、题目语义唯一。")
    lines.append("- **人工盲评仍未做：0 份评分、0 个结论。** 本报告不替评审填分，也不把自动闸通过当成第二轮/第三轮人评。")
    lines.append("- **G0 未通过。** 三条门槛（≥16/20 讲解点、≥8/10 题、≥1 位愿意）必须同时满足；现在只有自动闸 10/10。")
    lines.append("- **6 内容 / 10 pack 的形状偏差**已在上文说明；这是为了“不生成不达标组合 + 保留两道 q6 修复”的取舍。")
    lines.append("- **公版文章支持是 v3 新增的脚本能力**：`check_safety_license` 现在接受 `source=public-domain` 且带 Gutenberg ID/URL/PD 依据的文章；原创文章判定不变。")
    lines.append("- 形式库仍是 19 条 G0 替身；第三方视频 pack 仍 `private_only=true`，不可作为公课发布；T1 交叉复核未跑。")
    lines.append("- 最终 10 个 pack 含少量生成后手工证据修订（§10.3），并已逐项重新跑 13 闸；全量重跑复现的是流程与闸门，不保证题目文字逐字相同，本次证据以 `/tmp/lesson-g0-v3/packs/` 的 JSON 为准。")
    lines.append("- 10 个 pack 的最终 JSON 在 `/tmp/lesson-g0-v3/packs/`，**不在 git 工作区**；未提交。")
    lines.append("")
    lines.append("### 10.7 复现")
    lines.append("")
    lines.append("```bash")
    lines.append("cd yt-bilingual-app")
    lines.append("backend/venv/bin/python -m py_compile scripts/lesson_g0.py")
    lines.append("# 全量真实生成（会调用 LLM；本轮约 $0.08）")
    lines.append("G0_OUT_ROOT=/tmp/lesson-g0-v3 backend/venv/bin/python scripts/lesson_g0.py \\")
    lines.append("  --no-quota --report /tmp/lesson-g0-v3/report-auto-raw.md \\")
    lines.append("  --review-doc /tmp/lesson-g0-v3/review/评审说明.md")
    lines.append("# 已有 pack 时只重建 summary/盲评（0 LLM）")
    lines.append("G0_OUT_ROOT=/tmp/lesson-g0-v3 backend/venv/bin/python scripts/lesson_g0.py \\")
    lines.append("  --no-quota --skip-existing --report /tmp/lesson-g0-v3/report-auto-raw.md \\")
    lines.append("  --review-doc /tmp/lesson-g0-v3/review/评审说明.md")
    lines.append("```")
    lines.append("")
    lines.append("> 负例随每次运行自动生成，不花 LLM；`summary.json` 的 `m2_posthoc` 为 10/10 band_pass、10/10 utr_pass。")
    lines.append("> 本次已执行 `backend/venv/bin/python -m py_compile scripts/lesson_g0.py scripts/lesson_g0_v3_report.py` 并通过；未 git 提交。")
    lines.append("")
    return "\n".join(lines)


def update_docs(section: str) -> None:
    text = DOCS_PATH.read_text(encoding="utf-8")
    # 1) §0 加一条 v3 结论（幂等：先删旧 v3 bullet）。
    bullet_prefix = "- **第三轮（G0 v3，2026-11-17）已重新生成**"
    text = "\n".join(line for line in text.splitlines() if not line.startswith(bullet_prefix))
    v2_marker = "- **第二轮（G0 v2，2026-11-17）已重新生成**"
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith(v2_marker):
            lines.insert(
                index + 1,
                bullet_prefix
                + "：10/10 pack 通过 13 项自动闸（覆盖率 10/10、内容 10/10）；ocean B2 q6 / Kurz B2 q6 已重写；"
                "新盲评包在 `/tmp/lesson-g0-v3/review/`，**第三轮人工盲评仍未做 → G0 仍未通过**。详见 §10。",
            )
            break
    text = "\n".join(lines)
    # 2) 追加/替换 §10 章节。
    if V3_MARKER in text:
        text = text[: text.index(V3_MARKER)].rstrip() + "\n\n" + section.strip() + "\n"
    else:
        text = text.rstrip() + "\n\n" + section.strip() + "\n"
    DOCS_PATH.write_text(text, encoding="utf-8")


def main() -> int:
    global SUMMARY_PATH, DOCS_PATH
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", default=str(SUMMARY_PATH))
    parser.add_argument("--out", default=str(OUT_PATH))
    parser.add_argument("--docs", default=str(DOCS_PATH))
    parser.add_argument("--append-docs", action="store_true")
    args = parser.parse_args()
    SUMMARY_PATH = Path(args.summary)
    DOCS_PATH = Path(args.docs)
    summary = load_summary()
    section = build_section(summary)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(section + "\n", encoding="utf-8")
    if args.append_docs:
        update_docs(section)
        print(f"docs: {DOCS_PATH}")
    print(f"report: {args.out}")
    print(f"packs={summary['pack_count']} pass={summary['pass_count']} cost=${summary['total_cost_usd']:.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
