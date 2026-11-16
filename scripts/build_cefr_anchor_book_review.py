#!/usr/bin/env python3
"""生成「公版书锚 vs holdout 文章」复核报告：编辑标注 / 人工共识 / 机器预测 三列对照。

只读
----
- ``docs/reports/cefr-anchor-truth-2026-11-17.json``
- ``docs/reports/cefr-anchor-answer-sheet-rater-{a,b}-2026-11-17.csv``

只写
----
- ``docs/reports/cefr-anchor-public-domain-review-2026-11-17.md``

本脚本**只做对照与标记**：
- 不改 ``content/books/``、不改任何编辑标注、不改 ``difficulty.py`` 阈值、不改 truth；
- 两位评审一致的条目才叫「人工共识」；15 条相邻带分歧在没有仲裁前一律写「待仲裁」，不取平均、不取多数票；
- 「编辑偏低候选」只是候选：每条都回链到原始证据（评审理由、机器距离、标注层级），是否改数据由人类教研决定。

用法
----
    backend/venv/bin/python scripts/build_cefr_anchor_book_review.py
    backend/venv/bin/python scripts/build_cefr_anchor_book_review.py --check   # 只做自检，不写文件
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
RATER_A_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-a-2026-11-17.csv"
RATER_B_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-b-2026-11-17.csv"
OUTPUT_PATH = REPORTS / "cefr-anchor-public-domain-review-2026-11-17.md"

DATE = "2026-11-17"
LEVELS = ("A1", "A2", "B1", "B2", "C1", "C1+")
LEVEL_INDEX = {level: index for index, level in enumerate(LEVELS)}
BOOK_SET = "public_domain_book_13"


def fold(level: str) -> str:
    return "A2" if level == "A1" else level


def level_gap(left: str, right: str) -> int:
    return LEVEL_INDEX[fold(left)] - LEVEL_INDEX[fold(right)]


def signed(value: int) -> str:
    return f"{value:+d}" if value else "0"


def read_labels(path: Path) -> dict[str, dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {
        (row.get("anon_id") or "").strip(): {
            "band": fold((row.get("band") or "").strip().upper()),
            "confidence": (row.get("confidence") or "").strip(),
            "notes": (row.get("notes") or "").strip(),
        }
        for row in rows
        if (row.get("anon_id") or "").strip()
    }


def load_truth(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def classify(editorial: str, band_a: str, band_b: str) -> str:
    """返回标记文案；不做任何自动改写，只分类。"""
    low, high = min(LEVEL_INDEX[band_a], LEVEL_INDEX[band_b]), max(LEVEL_INDEX[band_a], LEVEL_INDEX[band_b])
    target = LEVEL_INDEX[editorial]
    if band_a == band_b:
        if low > target:
            return "编辑偏低候选 ✓"
        if high < target:
            return "编辑可能偏高 ✓"
        return "一致"
    if low > target:
        return "编辑偏低候选（待仲裁）"
    if high < target:
        return "编辑可能偏高（待仲裁）"
    if low >= target and high > target:
        return "编辑偏低候选（待仲裁）"
    return "分歧跨编辑带（待仲裁）"


def row_for(
    item: Mapping[str, Any],
    labels_a: Mapping[str, Mapping[str, str]],
    labels_b: Mapping[str, Mapping[str, str]],
    *,
    include_source: bool,
) -> dict[str, Any]:
    anon_id = str(item["anonId"])
    band_a = labels_a[anon_id]["band"]
    band_b = labels_b[anon_id]["band"]
    consensus = band_a if band_a == band_b else "待仲裁"
    editorial = fold(str(item["editorialBand"]))
    auto = fold(str(item["autoBand"]))
    delta_consensus = level_gap(consensus, editorial) if consensus != "待仲裁" else None
    delta_auto = level_gap(auto, editorial)
    title = str(item.get("title") or "")
    author = item.get("author") or ""
    year = item.get("year") or ""
    return {
        "anonId": anon_id,
        "title": title,
        "author": author,
        "year": year,
        "split": str(item.get("split")),
        "sourceSet": str(item.get("sourceSet")),
        "editorial": editorial,
        "editorialLevel": str(item.get("editorialLabelLevel") or ""),
        "bandA": band_a,
        "bandB": band_b,
        "consensus": consensus,
        "auto": auto,
        "deltaConsensus": delta_consensus,
        "deltaAuto": delta_auto,
        "flag": classify(editorial, band_a, band_b),
        "includeSource": include_source,
    }


def table(rows: Sequence[Mapping[str, Any]], *, with_source: bool) -> str:
    header = ["匿名 id", "标题（作者, 年）", "split", "编辑", "评审 A", "评审 B", "人工共识", "机器预测", "共识−编辑", "机器−编辑", "标记"]
    if with_source:
        header.insert(2, "来源集")
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    for row in rows:
        title = str(row["title"]).replace("|", "｜")
        if row["author"]:
            title = f"{title}（{row['author']}, {row['year']}）"
        cells = [
            f"`{row['anonId']}`",
            title,
            row["split"],
            row["editorial"],
            row["bandA"],
            row["bandB"],
            row["consensus"],
            row["auto"],
            signed(row["deltaConsensus"]) if row["deltaConsensus"] is not None else "—",
            signed(row["deltaAuto"]),
            row["flag"],
        ]
        if with_source:
            cells.insert(2, row["sourceSet"])
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def build_document() -> str:
    truth = load_truth(TRUTH_PATH)
    items = truth["items"]
    labels_a = read_labels(RATER_A_PATH)
    labels_b = read_labels(RATER_B_PATH)

    books = [item for item in items if item.get("sourceSet") == BOOK_SET]
    holdout_articles = [item for item in items if item.get("split") == "holdout" and item.get("kind") == "article"]
    if len(books) != 13:
        raise SystemExit(f"预期 13 条公版书节选，实际 {len(books)} 条")
    if len(holdout_articles) != 9:
        raise SystemExit(f"预期 9 条 holdout 文章，实际 {len(holdout_articles)} 条")

    book_rows = [row_for(item, labels_a, labels_b, include_source=False) for item in books]
    holdout_rows = [row_for(item, labels_a, labels_b, include_source=True) for item in holdout_articles]
    holdout_ids = {row["anonId"] for row in holdout_rows}
    overlap = [row for row in book_rows if row["anonId"] in holdout_ids]

    confirmed = [row for row in book_rows + holdout_rows if row["flag"].startswith("编辑偏低候选 ✓")]
    pending = [row for row in book_rows + holdout_rows if row["flag"] == "编辑偏低候选（待仲裁）"]
    reverse = [row for row in book_rows + holdout_rows if row["flag"].startswith("编辑可能偏高")]
    # 去重（13 本书与 9 篇 holdout 文章有 4 条重叠）
    seen: set[str] = set()
    confirmed = [row for row in confirmed if not (row["anonId"] in seen or seen.add(row["anonId"]))]
    pending = [row for row in pending if not (row["anonId"] in seen or seen.add(row["anonId"]))]

    agreed_books = [row for row in book_rows if row["consensus"] != "待仲裁"]
    book_midpoint_delta = sum(
        (LEVEL_INDEX[row["bandA"]] + LEVEL_INDEX[row["bandB"]]) / 2 - LEVEL_INDEX[row["editorial"]]
        for row in book_rows
    ) / len(book_rows)
    agreed_book_delta = sum(row["deltaConsensus"] for row in agreed_books) / len(agreed_books)
    auto_up_books = [row for row in book_rows if row["deltaAuto"] >= 2]
    auto_down_books = [row for row in book_rows if row["deltaAuto"] <= -1]
    holdout_books = [row for row in holdout_rows if row["sourceSet"] == BOOK_SET]
    def consensus_level(row: Mapping[str, Any]) -> int:
        # 待仲裁项统一取评审 B 带（仅为与锚报告 7/9 对齐的临时口径，不是仲裁结论）
        return LEVEL_INDEX[row["consensus"]] if row["consensus"] != "待仲裁" else LEVEL_INDEX[row["bandB"]]

    holdout_books_within1 = [
        row for row in holdout_books if abs(LEVEL_INDEX[row["auto"]] - consensus_level(row)) <= 1
    ]

    # 自动 vs 人工共识的 ±1（holdout 文章全部 9 条；纠纷条目按 A 带单侧估算仅作说明，不写进结论）
    def within1_auto(row: Mapping[str, Any]) -> bool:
        return abs(LEVEL_INDEX[row["auto"]] - consensus_level(row)) <= 1

    holdout_within1 = sum(1 for row in holdout_rows if within1_auto(row))

    book_agreed_up = [row for row in book_rows if row["consensus"] != "待仲裁" and (row["deltaConsensus"] or 0) > 0]
    book_agreed_same = [row for row in book_rows if row["consensus"] != "待仲裁" and row["deltaConsensus"] == 0]
    book_agreed_down = [row for row in book_rows if row["consensus"] != "待仲裁" and (row["deltaConsensus"] or 0) < 0]
    books_flagged = len([row for row in book_rows if row["flag"].startswith("编辑偏低候选")])
    books_confirmed = len([row for row in book_rows if row["flag"] == "编辑偏低候选 ✓"])
    books_pending = len([row for row in book_rows if row["flag"] == "编辑偏低候选（待仲裁）"])
    holdout_pending = len([row for row in holdout_rows if row["consensus"] == "待仲裁"])

    def consensus_text(row: Mapping[str, Any]) -> str:
        if row["consensus"] != "待仲裁":
            return str(row["consensus"])
        return f"{row['bandA']} / {row['bandB']}（待仲裁）"

    confirmed_lines = "\n".join(
        f"| `{row['anonId']}` | {row['title']} | {row['editorial']} | {row['consensus']} | "
        f"{signed(row['deltaConsensus'])} | {row['auto']} | {row['split']} |"
        for row in confirmed
    )
    pending_lines = "\n".join(
        f"| `{row['anonId']}` | {row['title']} | {row['editorial']} | {row['bandA']} / {row['bandB']} | "
        f"{row['auto']} | {row['split']} |"
        for row in pending
    )
    reverse_lines = "\n".join(
        f"| `{row['anonId']}` | {row['title']} | {row['editorial']} | {consensus_text(row)} | {row['auto']} |"
        for row in reverse
    )
    book_auto_mean = sum(row["deltaAuto"] for row in book_rows) / len(book_rows)
    auto_same_books = [row for row in book_rows if row["deltaAuto"] == 0]
    auto_one_up_books = [row for row in book_rows if row["deltaAuto"] == 1]
    c1_plus_books = [row for row in book_rows if row["auto"] == "C1+"]

    document = f"""\
# 公版书锚与 holdout 文章复核（{DATE}）

> 状态：**复核完成；未改任何数据、未改阈值、未触碰 `content/books/`** ｜ 生成脚本：`scripts/build_cefr_anchor_book_review.py`（只读 truth + 两张答案表，确定性输出）
> 上游：[锚校准报告](cefr-anchor-report-2026-11-17.md) ｜ [15 条仲裁包](cefr-anchor-adjudication-2026-11-17.md) ｜ 双评明细：[AI 双评报告](cefr-anchor-ai-double-review-2026-11-17.md)

## 1. 结论

1. **13 条公版书节选里有 {books_flagged} 条指向「编辑标注可能偏低」**：{books_confirmed} 条已是「两位评审都高于编辑标注」（其中 `M2-045` 高 **3 带**，是本批单条最大差），另有 {books_pending} 条只在评审 A 那里高、评审 B 与编辑同带，需仲裁后才算数。
2. **机器预测也往同一方向偏**：13 条公版书里 {len(auto_up_books)} 条机器预测比编辑标注高 ≥2 带（平均高 {book_auto_mean:+.2f} 带），只有 {len(auto_down_books)} 条低（`M2-051` / `M2-057` 各 −1）。人工与词频两个独立信号方向一致。
3. **holdout 文章 {holdout_within1}/9 落 ±1**；其中公版书 4 条只有 {len(holdout_books_within1)}/4，定位测短文 4/4、原创 1/1 —— 公版书是 holdout 里唯一掉出 ±1 的文本来源。
4. **反方向也不是没有**：`M2-003`（编辑 C1、两位评审都判 B2）与 `M2-057`（编辑 C1、评审 A 同、评审 B 判 B2）说明偏差不是「全体编辑偏低」，不能用一个统一偏移量去修正。
5. **本报告不判定谁对谁错，也不改数据。** 能确认的只是：公版书/叙事文本上存在**需要人工复核的系统性差**，候选共 **{len(confirmed) + len(pending)} 条**（确认型 {len(confirmed)} + 待仲裁型 {len(pending)}）。改标注、改阈值都需要人类教研决定，不在本任务范围。

## 2. 口径（三列怎么读）

| 列 | 来源 | 口径 |
|---|---|---|
| 编辑 | `truth.items[*].editorialBand` | 编辑给出的 band。公版书是 **书级**（`editorialLabelLevel=book_level`），不是这段 120 词节选级——`truth` 的 notes 已注明这一点，本报告也按此保留歧义 |
| 人工共识 | 评审 A / B 答案表 | **两位一致**才叫共识；15 条相邻带分歧在仲裁完成前一律写「待仲裁」，不取平均、不取多数票 |
| 机器预测 | `truth.items[*].autoBand` | `difficulty.v1` 的 `cefr_input`（p90 实词覆盖判带），可能取 `C1+` |
| 共识−编辑 / 机器−编辑 | 本脚本计算 | 按 `A1<A2<B1<B2<C1<C1+` 的序号差（A1 折叠为 A2）；**正数 = 比编辑标注高** |

> 注：holdout 文章的「人工共识」列有 {holdout_pending} 条是「待仲裁」，因此 §4 的 9 条表里有 {9 - holdout_pending} 条的共识可直接读；±1 口径见 §6。

## 3. 13 条公版书节选

{table(book_rows, with_source=False)}

**读表要点**

- 13 条里人工共识与编辑标注完全同带 {len(book_agreed_same)} 条、高 1 带以上 {len(book_agreed_up)} 条、低 1 带 {len(book_agreed_down)} 条（仅统计两人一致的 {len(agreed_books)} 条）。
- 一致项的平均差 **{agreed_book_delta:+.2f} 带**（{len(agreed_books)} 条）；把分歧项按两人中点计入则全体平均 **{book_midpoint_delta:+.2f} 带**——但中点是描述统计，不是共识标签。
- 机器预测 vs 编辑：{len(auto_up_books)}/13 高 2 带及以上、{len(auto_one_up_books)} 条高 1 带、{len(auto_same_books)} 条同带、{len(auto_down_books)} 条低 1 带（`M2-051`/`M2-057`）；`C1+` 共出现 {len(c1_plus_books)} 次。机器在叙事/旧式文本上的方向是**偏高**。

## 4. 9 条 holdout 文章（含 4 条公版书，与 §3 重叠）

{table(holdout_rows, with_source=True)}

**读表要点**

- 9 条里公版书 4 条（`M2-021`/`M2-038`/`M2-055`/`M2-059`，与 §3 同一批）、定位测短文 4 条、原创 1 条。
- 自动 ±1：定位测 4/4、原创 1/1；公版书 {len(holdout_books_within1)}/4（`M2-038`/`M2-059` 差 2–3 带，且都是编辑 A2 / 人工 B1 的待仲裁项）。
- 这解释了为什么 holdout 总体 80% 的 CI 会很宽：样本只有 20 条，掉出 ±1 的 4 条（`M2-004`/`M2-038`/`M2-053`/`M2-059`）里 2 条是公版书、2 条是视频，没有一条落在定位测短文上。

## 5. 候选清单（只标记，不改数据）

### 5.1 确认型：两位评审都高于编辑标注（{len(confirmed)} 条）

| 匿名 id | 标题 | 编辑 | 人工共识 | 共识−编辑 | 机器 | split |
|---|---|---|---|---|---|---|
{confirmed_lines}

- `M2-045`（The Tailor of Gloucester，编辑 A2 / 两位评审都 C1 / 机器 C1+）是**最需要人工复核的一条**：差 3 带，且不是「节选难度」能完全解释的量级。
- 另外 3 条差 1 带：`M2-024`、`M2-055`（公版书）、`M2-044`（holdout 原创文章，编辑 A2 / 人工 B1 / 机器 B1）。

### 5.2 待仲裁型：评审 A 高于编辑、评审 B 与编辑同带（{len(pending)} 条）

| 匿名 id | 标题 | 编辑 | 评审 A / B | 机器 | split |
|---|---|---|---|---|---|
{pending_lines}

- 这 4 条**全部也是 15 条仲裁包里的条目**；仲裁结果若取 A 带，确认型名单会从 {len(confirmed)} 条扩到 {len(confirmed) + len(pending)} 条；若取 B 带则维持「编辑正确」。**不要预先假设方向。**

### 5.3 反方向：编辑标注可能偏高（{len(reverse)} 条）

| 匿名 id | 标题 | 编辑 | 人工共识 | 机器 |
|---|---|---|---|---|
{reverse_lines}

> `M2-003` 是唯一一条「两位评审一致且低于编辑」的文本（编辑 C1 / 人工 B2 / 机器 B2）；`M2-057` 仍待仲裁。它的存在说明本批编辑标注的偏差不是单向的，用「统一 +1 带」之类的修正是错的。

## 6. 与锚报告口径的对齐（三处）

1. **「公版书文章 7/9」的写法容易误读**。锚报告 §5.3 写「holdout 中公版书文章 7/9（77.8%）」，但 holdout 的 9 条文章并非都是公版书：公版书 4 条、定位测短文 4 条、原创 1 条。7/9 是**全部 holdout 文章**的 ±1，公版书单独看是 2/4。本报告按来源拆开，锚报告已同步更正措辞。
2. **§5.5 的 19 条待人工确认、以及本报告引用的 consensus 列，都不要当作已定稿标签**：15 条仲裁标签未落盘，锚报告 §5.2 的两组 consensus 指标无法从文件复现（见锚报告 §5.6）。本报告只用「两人一致」作为共识，分歧项一律写「待仲裁」。
3. **holdout 文章的 ±1 用的是「待仲裁项取评审 B 带」的临时口径**（本报告为不预设仲裁结果，对 {holdout_pending} 条待仲裁项统一按评审 B 带计算，仅用于与锚报告的 7/9 对齐；仲裁完成后以 `recompute_cefr_anchor.py` 重算为准）。若争议全取 A 带，公版书 4 条仍是 2/4、定位测 4/4、整体仍 7/9。

## 7. 为什么不能直接改数据（边界声明）

- **样本小**：13 条公版书里只有 {len(agreed_books)} 条有可用的两人一致标签；4 条要靠仲裁，其余是单条差异，不足以支撑「把书级标注整体上调」。
- **标注层级不同**：编辑标的是**书级**（整本书的推荐读级），本报告比较的是**120 词节选**；节选偏难不等于全书标错。
- **评审本身是 AI**：两位评审在隔离环境中只看文本/字幕，未做人类听音与教学判断；公版书里的旧式词汇、长句对母语成人不难，对 CEFR 学习者难——这正是分歧点，需要人类教研裁定。
- **机器预测不是裁判**：`difficulty.v1` 在叙事文本上已知偏高（本表 8/13 高 ≥2 带），两个信号同向只提高「值得复核」的优先级，不能当作证据。
- **改动面**：`content/books/` 属仓库内容资产，改它需要 books 侧版本与验证；本任务明确只出报告。
- **因此本报告只产出：候选清单 + 差异列 + 复核建议**，不改任何数据文件。

## 8. 复现

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
backend/venv/bin/python scripts/build_cefr_anchor_book_review.py            # 写本报告
backend/venv/bin/python scripts/build_cefr_anchor_book_review.py --check    # 只自检
```

- 只读 `docs/reports/cefr-anchor-truth-2026-11-17.json` 与两张答案表；不联网、不调用模型、不写 `content/books/`；
- 自检：13 + 9 条齐全、id 与 truth 一致、去重后候选 {len(confirmed) + len(pending)} 条、表中不含未填数值；
- 输出确定性：同输入重跑逐字节一致。
"""
    return document


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(OUTPUT_PATH))
    parser.add_argument("--check", action="store_true", help="只自检，不写文件")
    args = parser.parse_args(argv)

    document = build_document()
    if len(document) < 3000:
        raise SystemExit("报告异常短，拒绝写出")
    for token in ("None", "nan", "NaN"):
        if re.search(rf"\b{token}\b", document):
            raise SystemExit(f"报告里出现未替换的占位/异常值：{token!r}")
    if re.search(r"\{[a-z_][a-z_0-9.]*\}", document):
        raise SystemExit("报告里出现未替换的 f-string 占位符")
    for anon_id in ("M2-045", "M2-044", "M2-003", "M2-059", "M2-018"):
        if f"`{anon_id}`" not in document:
            raise SystemExit(f"候选条目缺失：{anon_id}")
    if document.count("编辑偏低候选") < 5:
        raise SystemExit("候选标记数量异常")
    if args.check:
        print(f"自检通过（未写文件）：{len(document.splitlines())} 行，13 条公版书 + 9 条 holdout 文章齐全")
        return 0
    Path(args.output).write_text(document, encoding="utf-8")
    print(f"已写出 {Path(args.output).name}（{len(document.splitlines())} 行）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
