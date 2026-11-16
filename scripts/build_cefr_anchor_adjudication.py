#!/usr/bin/env python3
"""生成 CEFR M2 锚校准的「15 条分歧仲裁包」与空白仲裁表。

只读输入（不改、不复制进仓库其他位置）
--------------------------------------
- ``docs/reports/cefr-anchor-truth-2026-11-17.json``     条目元数据/分带（编辑带与机器预测带只用于断言，不写进包）
- ``docs/reports/cefr-anchor-packet-2026-11-17.md``      60 条盲评包（文本条目的 ≤120 词摘录来自这里）
- ``docs/reports/cefr-anchor-answer-sheet-rater-{a,b}-2026-11-17.csv``  两位评审的标签与理由

只写输出
--------
- ``docs/reports/cefr-anchor-adjudication-2026-11-17.md``    仲裁包（可单独交给第三位评审/负责人）
- ``docs/reports/cefr-anchor-adjudication-sheet-2026-11-17.csv``  空白仲裁表（15 行）

为什么这样做
------------
仲裁者只需要三样东西：条目本身、两位评审各自的 band 与理由、一条明确的仲裁问题。
一旦看到机器预测带或编辑标注，仲裁就变成「往哪边靠」的锚定游戏，而不是独立判断——
所以本脚本**结构上不写这两个字段**，并在退出前对每个条目块做机器断言。

机器断言（失败即非 0 退出，不产出半成品）
------------------------------------------
1. 分歧条目恰为 15 条、全部 ``|A−B| = 1``，id 与 truth 一一对应；
2. 每个条目块内出现的 band 名 ⊆ {A 的 band, B 的 band}（混入第三带即报错）；
3. 每个条目块内不含机器预测带/编辑标注/truth/baseline/holdout 等字样；
4. 文本摘录 ≤120 词且与 ``truth.excerptWords`` 一致；视频条目只给链接 + 时间窗，不给字幕正文；
5. 仲裁表 15 行 × 5 列、除 ``anon_id`` 外全部为空（不让上一次的答案混进来）。

用法
----
    backend/venv/bin/python scripts/build_cefr_anchor_adjudication.py
    backend/venv/bin/python scripts/build_cefr_anchor_adjudication.py --check   # 只断言，不写文件

输出确定性：同样的输入重跑得到逐字节相同的两份文件（不含生成时钟）。
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
REPORTS = REPO_ROOT / "docs" / "reports"

TRUTH_PATH = REPORTS / "cefr-anchor-truth-2026-11-17.json"
PACKET_PATH = REPORTS / "cefr-anchor-packet-2026-11-17.md"
RATER_A_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-a-2026-11-17.csv"
RATER_B_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-b-2026-11-17.csv"
PACK_OUT = REPORTS / "cefr-anchor-adjudication-2026-11-17.md"
SHEET_OUT = REPORTS / "cefr-anchor-adjudication-sheet-2026-11-17.csv"

DATE = "2026-11-17"
BAND_ORDER = {"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C1": 4, "C1+": 5}
BAND_RE = re.compile(r"\b(A1|A2|B1|B2|C1)\b")
FORBIDDEN_TOKENS = (
    "autoBand",
    "editorialBand",
    "editorial",
    "difficulty.v1",
    "cefr-anchor-truth",
    "baseline",
    "编辑标注",
    "编辑带",
    "调参集",
    "holdout",
)


# ---------------------------------------------------------------- 输入读取


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {str(key).strip(): (value or "").strip() for key, value in row.items() if key}
            for row in reader
        ]


def load_truth(path: Path = TRUTH_PATH) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        truth = json.load(handle)
    items = truth.get("items")
    if not isinstance(items, list) or len(items) != 60:
        raise SystemExit(f"truth 必须含 60 条 items：{path}")
    return truth


def load_labels(path: Path) -> dict[str, dict[str, str]]:
    labels: dict[str, dict[str, str]] = {}
    for row in read_csv_rows(path):
        anon_id = row.get("anon_id", "")
        if not anon_id:
            continue
        if anon_id in labels:
            raise SystemExit(f"{path.name} 的 anon_id 重复：{anon_id}")
        labels[anon_id] = {
            "band": row.get("band", "").upper(),
            "confidence": row.get("confidence", ""),
            "notes": row.get("notes", ""),
        }
    return labels


def load_packet_excerpts(path: Path = PACKET_PATH) -> dict[str, list[str]]:
    """从 60 条盲评包里取每条文本条目的摘录（blockquote 行）。"""
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"(?m)^### (M2-\d{3}) ", text)
    excerpts: dict[str, list[str]] = {}
    for index in range(1, len(parts), 2):
        anon_id, body = parts[index], parts[index + 1]
        excerpts[anon_id] = [line[2:].strip() for line in body.splitlines() if line.startswith("> ")]
    return excerpts


# ---------------------------------------------------------------- 判定与格式化


def parse_band(raw: str) -> str:
    band = (raw or "").strip().upper()
    return band[:-1] if band.endswith("+") else band


def band_gap(left: str, right: str) -> int:
    if left not in BAND_ORDER or right not in BAND_ORDER:
        raise SystemExit(f"非法 band：{left!r}/{right!r}")
    return abs(BAND_ORDER[left] - BAND_ORDER[right])


def trim_reason(text: str, limit: int = 150) -> str:
    value = (text or "").strip()
    if len(value) <= limit:
        return value
    cut = value[:limit]
    for separator in ("。", "；"):
        position = cut.rfind(separator)
        if position >= limit * 0.55:
            return cut[: position + 1].strip()
    return cut.strip() + "…"


def format_duration(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return "未知"
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def format_window(window: Mapping[str, Any], url: str) -> str:
    start = int(round(float(window.get("start") or 0)))
    return (
        f"{window.get('startLabel')}–{window.get('endLabel')}"
        f"（约 {window.get('seconds')} 秒，{window.get('tokens')} 词）— {url}&t={start}s"
    )


# ---------------------------------------------------------------- 泄漏断言


def assert_block_clean(block: str, anon_id: str, allowed_bands: set[str]) -> None:
    for token in FORBIDDEN_TOKENS:
        if token in block:
            raise SystemExit(f"泄漏断言失败：{anon_id} 条目块出现禁用字样 {token!r}")
    leaked = {band for band in BAND_RE.findall(block) if band not in allowed_bands}
    if leaked:
        raise SystemExit(f"泄漏断言失败：{anon_id} 条目块出现 {sorted(leaked)}，只允许 {sorted(allowed_bands)}")


# ---------------------------------------------------------------- 条目块


def build_item_block(
    index: int,
    item: Mapping[str, Any],
    rater_a: Mapping[str, str],
    rater_b: Mapping[str, str],
    excerpt_lines: Sequence[str],
) -> tuple[str, dict[str, Any]]:
    anon_id = str(item["anonId"])
    band_a = parse_band(rater_a["band"])
    band_b = parse_band(rater_b["band"])
    title = str(item.get("title") or "（无标题）")
    lines: list[str] = [f"### 仲裁 {index:02d} ｜ `{anon_id}` ｜ {item['contentType']}", ""]

    if item["kind"] == "video":
        url = str(item.get("url") or "")
        if not url:
            raise SystemExit(f"{anon_id} 是视频但缺少链接")
        lines.append(
            f"- **内容**：{title}（频道：{item.get('channel') or '未知频道'}，"
            f"时长 {format_duration(item.get('durationSec'))}）"
        )
        lines.append(f"- **链接**：{url}")
        for window_index, window in enumerate(item.get("windows") or [], start=1):
            lines.append(f"- **时间窗 {window_index}**：{format_window(window, url)}")
        lines.append(
            "- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；"
            "第三方视频只给链接 + 时间窗，包内不转载字幕。"
        )
    else:
        excerpt = " ".join(line.strip() for line in excerpt_lines if line.strip())
        words = len(excerpt.split())
        expected = item.get("excerptWords")
        if not excerpt:
            raise SystemExit(f"{anon_id} 是文本条目但盲评包里没有摘录")
        if words > 120:
            raise SystemExit(f"{anon_id} 摘录 {words} 词，超过 120 词上限")
        if isinstance(expected, int) and expected != words:
            raise SystemExit(f"{anon_id} 摘录 {words} 词与 truth.excerptWords {expected} 不一致")
        source_set = str(item.get("sourceSet") or "")
        if source_set == "public_domain_book_13":
            origin = (
                f"{item.get('author') or '佚名'}《{title}》（{item.get('year') or '年份未知'}），"
                f"Project Gutenberg #{item.get('gutenbergId')}；美国公版"
            )
            if item.get("gutenbergId"):
                origin += f"（https://www.gutenberg.org/ebooks/{item['gutenbergId']}）"
        elif source_set == "placement_11":
            origin = "LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文"
        else:
            origin = "LinguaTrek 编辑部原创，随仓库分发；包内给节选"
        lines.append(f"- **字数**：{words} 词")
        lines.append(f"- **出典**：{origin}")
        lines.append("")
        lines.append(f"> {excerpt}")
        lines.append("")
        lines.append("- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。")

    lines.append("")
    lines.append(
        f"- **评审 A**：band **{band_a}** ｜ 置信度 {rater_a.get('confidence') or '—'}"
        f" ｜ 理由（评审原话节选）：{trim_reason(rater_a.get('notes', '')) or '（未填）'}"
    )
    lines.append(
        f"- **评审 B**：band **{band_b}** ｜ 置信度 {rater_b.get('confidence') or '—'}"
        f" ｜ 理由（评审原话节选）：{trim_reason(rater_b.get('notes', '')) or '（未填）'}"
    )
    lines.append("")
    lines.append(
        f"- **仲裁问题：这条内容整体更接近哪一带？** → [ ] {band_a}　[ ] {band_b}"
        f"（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）"
    )
    lines.append("")
    block = "\n".join(lines)
    assert_block_clean(block, anon_id, {band_a, band_b})
    priority = rater_a.get("confidence") in ("2", "3") and rater_b.get("confidence") in ("2", "3")
    return block, {"anonId": anon_id, "bandA": band_a, "bandB": band_b, "priority": priority}


# ---------------------------------------------------------------- 静态段落

RUBRIC_TABLE = """\
| 带 | 词汇 | 句法 | 篇章 / 信息 | 听力（仅视频） |
|---|---|---|---|---|
| **A2** | 日常高频词；少量高频短语 | 简单句 + 基础连接（and/but/because）；常见时态 | 2–5 句的短段落；直接信息；结构可预测 | 慢速、清晰、标准口音；话题日常 |
| **B1** | 常见词为主；少量抽象词、短语动词 | 主从复合句；常见连接词；叙事/说明有层次 | 多段短文；主旨 + 若干细节；有明确结构 | 正常偏慢；清晰标准口音；少量习语/连读 |
| **B2** | 词汇较丰富；抽象/专业词增多 | 多重从句、非谓语、被动等复杂结构 | 长段落；观点、论证、隐含关系；需推断 | 正常语速；有连读/弱读；话题抽象或专业 |
| **C1** | 词汇广；习语、隐喻、语域变化 | 复杂句法、省略、倒装、名词化等 | 长而密集；隐含意义、立场、修辞；需综合理解 | 接近自然语速；口音/语域变化；信息密度高 |
"""

RULES_SECTION = f"""\
## 2. 仲裁规则

### 2.1 判什么：整体理解难度，不是单词难度

要判的是：**处在目标 band 的学习者，不查词、不借助译文，能不能一遍拿到主旨与主要细节。**
不是数生词、不是看标题话题，也不是看作者名气。

**不算「升级」的情形**（只影响局部，不改变整体可理解度）：

- 单个低频/旧式具体词（如 bonnet、gig、currant buns），其余句子仍是简单叙事；
- 专有名词、人名地名、书内虚构名；
- 术语在上下文里被解释、或被例子反复支撑（教学视频、科普旁白的常见做法）；
- 数字、日期、单位、标点造成的视觉密度。

**算「升级」的情形**（整体负荷，会叠加）：

- 需要**推断**说话人立场、反讽、隐含前提，或论证跨越多段才能拼出结论；
- 名词化、多重嵌套从句、省略/倒装/非谓语密集出现（不是偶发一两句）；
- 信息密度高：单位时间内新概念多，且没有停顿、重复、板书辅助；
- 语速 + 连读/弱读 + 口音/背景音共同抬高听力门槛（视频按「听」判，不按字幕稿判）；
- 语域跨度大（旧式书面语、法律/学术套语、方言口语），词都认识也要额外解析。

### 2.2 CEFR 描述符（与本轮盲评包同一 rubric，只给用得到的四带）

{RUBRIC_TABLE}
### 2.3 只差一带时怎么选（本包 15 条全部是相邻带分歧）

1. **先整体、后局部**：先通读/通听一遍，凭第一印象定一带；再用描述符核对词汇、句法、篇章三项，看是否有两项以上支持另一带。三项里只有一项擦边 → 维持第一印象。
2. **不取平均、不搞多数票**：band 没有中间档，「A 说 B2、B 说 C1」不等于各一半；也不要用「评审 A 在 14/15 条里都比 B 高」去反向修正（见 §2.5）。
3. **边界五五开时的默认**：选**较低**带、confidence 设 1，并在 reason 里写明「另一带是 X，为什么」。这与盲评包原有 rubric（边界取较低带）一致，也让后续敏感性分析有据可查。
4. **只差一带的典型判据**（可直接对照）：
   - **A2/B1**：情节/话题能否只靠日常词与简单句串起来？出现过去完成时、so…that、定语从句但仍一眼可懂 → 仍可 A2；若需要跟着时间线、人物关系做一点推断，且这类句子成片出现 → B1。
   - **B1/B2**：是否出现了**成段的论证**（而不只是叙事 + 结论）？要理解「为什么」而不只是「发生了什么」→ B2；若论证被例子反复解释、句子偏短 → B1。
   - **B2/C1**：是否要**同时**处理抽象概念、隐含立场与高密度信息？术语多但有解释、语速中等 → B2；术语密集且连续解释机制、几乎不给喘息 → C1。
5. **不确定就写下来**：reason 里写清「哪一带、为什么、还差什么证据」，比一个没有依据的 band 更有用。

### 2.4 置信度

- **3** = 确定；**2** = 比较确定；**1** = 在相邻两带之间摇摆（边界判断）。
- 视频条目若只看了字幕、没有实际听音，请把 confidence 设为 1，并在 reason 写明「仅字幕」。

### 2.5 两条已观测到的偏差（只作提醒，不是答案）

- 两位评审里 **A 在 15 条分歧中有 14 条给出更高的 band**，两人平均 band 只差 0.22 带（A 2.92 / B 2.70）。这说明分歧是同一批边界的两种读法，而不是「一边全对」；请独立判断，不要默认向 A 靠。
- 本批材料**整体**存在来源标注与人工判断的系统性差异（已在锚报告里量化）。包内不提供任何来源等级，请不要用「出版社/年代/频道会怎么标」反推答案。

### 2.6 独立性与保密

- 不要打开 `cefr-anchor-truth-2026-11-17.json`、`cefr-anchor-baseline-2026-11-17.*`、`cefr-anchor-analysis-2026-11-17.json`；不要搜索条目的原始等级。
- 不要与评审 A/B 讨论，也不要看他们的完整答案表（本包已摘录各自理由，足够仲裁）。
- 仲裁只决定这 15 条；评审间一致性（κ）仍按 A/B 的独立标签报告，**不会**用仲裁结果去修饰。
"""


def build_document(
    items: Sequence[Mapping[str, Any]],
    labels_a: Mapping[str, Mapping[str, str]],
    labels_b: Mapping[str, Mapping[str, str]],
    excerpts: Mapping[str, Sequence[str]],
) -> tuple[str, list[dict[str, Any]]]:
    disputes: list[tuple[Mapping[str, Any], str, str]] = []
    for item in items:
        anon_id = str(item["anonId"])
        band_a = parse_band(labels_a[anon_id]["band"])
        band_b = parse_band(labels_b[anon_id]["band"])
        if band_a == band_b:
            continue
        if band_gap(band_a, band_b) != 1:
            raise SystemExit(
                f"{anon_id} 的分歧跨越 {band_gap(band_a, band_b)} 带，不属于相邻带仲裁范围"
            )
        disputes.append((item, band_a, band_b))
    if len(disputes) != 15:
        raise SystemExit(f"预期 15 条相邻带分歧，实际 {len(disputes)} 条")

    blocks: list[str] = []
    records: list[dict[str, Any]] = []
    for index, (item, _band_a, _band_b) in enumerate(disputes, start=1):
        anon_id = str(item["anonId"])
        block, record = build_item_block(
            index, item, labels_a[anon_id], labels_b[anon_id], excerpts.get(anon_id, [])
        )
        blocks.append(block)
        records.append(record)

    priority_ids = [str(record["anonId"]) for record in records if record["priority"]]
    table_rows = []
    for index, ((item, _band_a, _band_b), record) in enumerate(zip(disputes, records), start=1):
        title = str(item.get("title") or "").replace("|", "｜").strip()
        if len(title) > 38:
            title = title[:37] + "…"
        table_rows.append(
            f"| {index:02d} | `{record['anonId']}` | {'视频' if item['kind'] == 'video' else '文本'} | {title} |"
            f" {record['bandA']} | {record['bandB']} | {'优先' if record['priority'] else '边界'} |"
        )

    header = f"""\
# CEFR M2 内容锚 · 15 条分歧仲裁包（{DATE}）

> schema：`cefr-anchor-adjudication.v1` ｜ 状态：**待仲裁（0/15 已填）** ｜ 生成脚本：`scripts/build_cefr_anchor_adjudication.py`（确定性输出，同输入重跑逐字节一致）
> 配套填写表：[`cefr-anchor-adjudication-sheet-2026-11-17.csv`](cefr-anchor-adjudication-sheet-2026-11-17.csv) ｜ 上一环：[60 条盲评包](cefr-anchor-packet-2026-11-17.md) ｜ 背景：[锚校准报告](cefr-anchor-report-2026-11-17.md)

## 0. 这是什么、要你做什么

- 60 条内容锚已完成两位评审的独立评分：45 条完全一致，**15 条相差恰好 1 带**（无跨两带）。
- 这 15 条需要**第三位评审/教研负责人**（或两位评审讨论后的定稿人）各给**一个** band，形成 consensus 标签。
- 你不需要评另外 45 条，也不需要给整批内容重新定级。
- 仲裁只产出**标签**：**不改**任何词典、阈值或内容数据，不触发自动难度调参。

## 1. 包里有什么、刻意没有什么

| 有 | 没有（故意的） |
|---|---|
| 15 条内容本身（文本给 ≤120 词摘录；第三方视频给链接 + 时间窗） | 机器自动预测的 band |
| 评审 A / B 各自的 band、置信度、理由节选 | 编辑标注的 band |
| 仲裁规则与 CEFR 描述符（§2） | 调参集/holdout 归属 |
| 空白填写表（15 行） | 其他 45 条的评分与来源映射 |

> 不显示机器预测带与编辑标注是为了避免锚定：看到「机器判 C1」或「编辑标 A2」再去选，得到的不是独立判断。
> 脚本对每个条目块做了机器断言（条目块内只允许出现该条 A/B 两个 band 名，且不含上述字段字样），见 §6。

"""

    listing = f"""\
\n## 3. 15 条清单（按匿名 id 排序，与填写表逐行对应）

| # | 匿名 id | 类型 | 标题 | 评审 A | 评审 B | 复核优先级 |
|---|---|---|---|---|---:|---:|---|
{chr(10).join(table_rows)}

- **优先** = 两位评审置信度都 ≥2（不是「低置信度摇摆」能解释的实质分歧），共 {len(priority_ids)} 条：{", ".join(f"`{value}`" for value in priority_ids)}。
- **边界** = 至少一位置信度为 1，其余 {15 - len(priority_ids)} 条。
- 建议顺序：先做 {len(priority_ids)} 条「优先」，再做 {15 - len(priority_ids)} 条「边界」；顺序不影响结论。

## 4. 逐条材料

> 每条只有三块信息：内容 / 评审 A / 评审 B，末尾一个仲裁问题。视频请实际听音，文本只看给的这段摘录。

{chr(10).join(blocks)}
## 5. 怎么填

填写表 `cefr-anchor-adjudication-sheet-2026-11-17.csv`，列定义：

| 列 | 填什么 | 合法值 |
|---|---|---|
| `anon_id` | 不要改 | 15 个 `M2-0xx` |
| `adjudicated_band` | 你定的 band | `A1` / `A2` / `B1` / `B2` / `C1`（**只填一个**，不要写 `B2/C1`、不要写 `B2+`） |
| `adjudicator` | 仲裁者代号 | 如 `J-01`（不写真实姓名） |
| `reason` | 1–3 句依据 | 引用 §2 描述符或具体证据（哪句/哪段让你定在这一带） |
| `confidence` | 置信度 | `3` / `2` / `1` |

15 行都填完才算完成；只填一部分时重算脚本输出 `pending`，不产生任何数字。

## 6. 生成自检（脚本每次生成都跑，失败即不产出文件）

1. 分歧条目恰为 15 条、全部 `|A−B| = 1`，id 与 truth 一一对应；
2. 每个条目块内出现的 band 名 ⊆ {{该条 A band, B band}}（混入第三带即报错）；
3. 每个条目块内不出现机器预测带、编辑标注、truth、baseline、holdout 等字样；
4. 文本摘录 ≤120 词且与 truth 的 `excerptWords` 一致；视频条目块内**没有**任何字幕正文；
5. 填写表 15 行 × 5 列，除 `anon_id` 外全部为空。

## 7. 填完之后

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
backend/venv/bin/python scripts/recompute_cefr_anchor.py \\
  --adjudication docs/reports/cefr-anchor-adjudication-sheet-2026-11-17.csv \\
  --output docs/reports/cefr-anchor-recalibration-2026-11-17.json
```

- 空表 → `status=pending`，不出任何一致性/κ/CI 数字；
- 只填一部分 → `status=partial_adjudication`，列出缺的 id，仍不出数字；
- 15 条填完 → 重算 κ、±1、Wilson CI、holdout，并**只报告**门槛是否满足；脚本不改 `difficulty.py` 阈值。

**门槛提醒**：holdout 只有 20 条，`±1` 点估计 80%（16/20）对应的 Wilson 95% CI 是 58.4%–91.9%，下限远低于 80%。
按「点估计 ≥80% 且 Wilson 下限 ≥80%」的严格口径，n=20 时只有 20/20 才可能通过；想在 95% CI 下确认 80%，
观测值要到约 88%–90% 且样本量约 100。**15 条填完 ≠ 校准通过**，这是扩样与调参的输入，不是结论。

## 8. 已知边界

- 评审 A/B 是在隔离环境中完成的独立评审（见 [`cefr-anchor-ai-double-review-2026-11-17.md`](cefr-anchor-ai-double-review-2026-11-17.md)）；视频条目的听音判断仍需人类复核，8 条视频分歧建议由能实际听音的人仲裁。
- 本包只解决「相邻带取哪一带」；不解决「编辑标注整体偏低」这一假设——那需要公版书锚复核（见 [`cefr-anchor-public-domain-review-2026-11-17.md`](cefr-anchor-public-domain-review-2026-11-17.md)）。
"""

    document = header + RULES_SECTION + listing
    return document, records


# ---------------------------------------------------------------- 写出


def build_sheet_rows(
    items: Sequence[Mapping[str, Any]],
    labels_a: Mapping[str, Mapping[str, str]],
    labels_b: Mapping[str, Mapping[str, str]],
) -> list[list[str]]:
    rows: list[list[str]] = []
    for item in items:
        anon_id = str(item["anonId"])
        if parse_band(labels_a[anon_id]["band"]) == parse_band(labels_b[anon_id]["band"]):
            continue
        rows.append([anon_id, "", "", "", ""])
    return rows


def write_sheet(path: Path, rows: Sequence[Sequence[str]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["anon_id", "adjudicated_band", "adjudicator", "reason", "confidence"])
        writer.writerows(rows)


def final_assertions(
    document: str,
    blocks: Sequence[str],
    sheet_rows: Sequence[Sequence[str]],
    records: Sequence[Mapping[str, Any]],
) -> None:
    if len(sheet_rows) != 15:
        raise SystemExit(f"填写表应为 15 行，实际 {len(sheet_rows)} 行")
    if any(any(cell for cell in row[1:]) for row in sheet_rows):
        raise SystemExit("填写表必须全空（除 anon_id）")
    if "autoBand" in document or "editorialBand" in document:
        raise SystemExit("整包扫描失败：出现机器预测带/编辑标注字段名")
    for block in blocks:
        for token in FORBIDDEN_TOKENS:
            if token in block:
                raise SystemExit(f"整包扫描失败：条目段出现 {token!r}")
    if document.count("[ ] ") < 30:
        raise SystemExit("仲裁选项不足 15×2")
    for record in records:
        if f"`{record['anonId']}`" not in document:
            raise SystemExit(f"条目缺失：{record['anonId']}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--truth", default=str(TRUTH_PATH))
    parser.add_argument("--packet", default=str(PACKET_PATH))
    parser.add_argument("--rater-a", default=str(RATER_A_PATH))
    parser.add_argument("--rater-b", default=str(RATER_B_PATH))
    parser.add_argument("--pack-out", default=str(PACK_OUT))
    parser.add_argument("--sheet-out", default=str(SHEET_OUT))
    parser.add_argument("--check", action="store_true", help="只跑断言，不写文件")
    args = parser.parse_args(argv)

    truth = load_truth(Path(args.truth))
    items = truth["items"]
    labels_a = load_labels(Path(args.rater_a))
    labels_b = load_labels(Path(args.rater_b))
    excerpts = load_packet_excerpts(Path(args.packet))

    ids = [str(item["anonId"]) for item in items]
    missing = [anon_id for anon_id in ids if anon_id not in labels_a or anon_id not in labels_b]
    if missing:
        raise SystemExit(f"答案表缺少 {len(missing)} 条：{missing[:5]}…")
    empty = [anon_id for anon_id in ids if not labels_a[anon_id]["band"] or not labels_b[anon_id]["band"]]
    if empty:
        raise SystemExit(f"答案表仍有空 band（{len(empty)} 条）：{empty[:5]}…")

    document, records = build_document(items, labels_a, labels_b, excerpts)
    sheet_rows = build_sheet_rows(items, labels_a, labels_b)
    blocks = document.split("\n### 仲裁 ")[1:]
    blocks = [block.split("\n## 5. 怎么填")[0] for block in blocks]
    final_assertions(document, blocks, sheet_rows, records)

    if args.check:
        print("断言通过（--check 未写文件）：15 条仲裁材料、表格 15 行空白、无机器预测带/编辑标注泄漏")
    else:
        Path(args.pack_out).write_text(document, encoding="utf-8")
        write_sheet(Path(args.sheet_out), sheet_rows)
        print(
            f"已写出 {Path(args.pack_out).name}（{len(document.splitlines())} 行）"
            f"与 {Path(args.sheet_out).name}（15 行空白）"
        )
    print(f"优先复核 {sum(1 for record in records if record['priority'])} 条 / 边界 {sum(1 for record in records if not record['priority'])} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
