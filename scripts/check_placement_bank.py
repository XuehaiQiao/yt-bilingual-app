#!/usr/bin/env python3
"""定位测题库质量校验（CEFR M2）：Form A/B、锚题一致性、p 值占位。

**报告里的 p 值全部是 null。** 真实 p 值需要 30–50 人 pilot 的作答数据；
本脚本不生成、不猜测、不伪造任何统计量，只把「待测」状态写清楚。同理，
题级 b 是编辑占位（题带中心），不是 IRT 标定结果。

用法::

    cd backend
    venv/bin/python ../scripts/check_placement_bank.py
    venv/bin/python ../scripts/check_placement_bank.py --check       # 只校验
    venv/bin/python ../scripts/check_placement_bank.py --out /tmp/report.json

默认报告写到 ``docs/reports/placement-items-2026-11-17.json``；退出码 0 =
校验通过，1 = 有 issue，2 = 参数/加载错误。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import assessment  # noqa: E402
import placement  # noqa: E402

DEFAULT_OUT = REPO_ROOT / "docs" / "reports" / "placement-items-2026-11-17.json"
WORDLIST_PATH = REPO_ROOT / "content" / "wordlist" / "frequency_bands.v1.json"
FORMS = ("A", "B")
ANCHOR_FIELDS = ("type", "band", "prompt", "options", "answer_index", "b", "anchor")


class BankAuditError(ValueError):
    """题库加载/结构错误（报告不生成）。"""


def _load_wordlist() -> dict | None:
    if not WORDLIST_PATH.exists():
        return None
    try:
        return json.loads(WORDLIST_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _item_row(form: str, item, *, p_value=None) -> dict:
    return {
        "form": form,
        "id": item.id,
        "type": item.type,
        "band": item.band,
        "anchor": bool(item.anchor),
        "answerIndex": item.answer_index,
        "b": item.b,
        "pValue": p_value,
        "parameterStatus": "editorial_uncalibrated" if item.b is not None else None,
    }


def _audit_form(form: str, bank, wordlist: dict | None) -> tuple[dict, list[str], list[str]]:
    """返回 (form 摘要, issues, warnings)。"""
    issues: list[str] = []
    warnings: list[str] = []
    real_vocab = [item for item in bank.vocab if not item.anchor]
    pseudo = list(bank.pseudo)
    reading = list(bank.reading)

    # 题数口径：40 真词（含 10 锚题）+ 4 伪词 = 44 个词汇题槽，再加 20 阅读 = 64。
    if len(bank.vocab) != 40:
        issues.append(f"Form {form}: 真词应为 40，实际 {len(bank.vocab)}")
    if len(pseudo) != 4:
        issues.append(f"Form {form}: pseudo 应为 4，实际 {len(pseudo)}")
    if len(reading) != 20:
        issues.append(f"Form {form}: reading 应为 20，实际 {len(reading)}")
    if len(bank.vocab) + len(pseudo) + len(reading) != 64:
        issues.append(f"Form {form}: 总题数应为 64")
    if len(bank.vocab) + len(pseudo) != 44:
        issues.append(f"Form {form}: 词汇题槽应为 44（40 真词 + 4 伪词）")
    if len(real_vocab) != 30:
        issues.append(f"Form {form}: 非锚真词应为 30（6/带），实际 {len(real_vocab)}")

    # 词汇带覆盖：40 真词 = 每带 8（2 锚 + 6 非锚）；伪词 B1–C1。
    vocab_bands: dict[str, int] = {}
    for item in bank.vocab:
        vocab_bands[item.band] = vocab_bands.get(item.band, 0) + 1
    if set(vocab_bands) != set(placement.CEFR_BANDS):
        issues.append(f"Form {form}: 词汇带未覆盖 A1–C1（{sorted(vocab_bands)}）")
    if any(count != 8 for count in vocab_bands.values()):
        issues.append(f"Form {form}: 每带真词应为 8（2 锚 + 6 非锚），实际 {vocab_bands}")
    non_anchor_bands: dict[str, int] = {}
    for item in real_vocab:
        non_anchor_bands[item.band] = non_anchor_bands.get(item.band, 0) + 1
    if any(count != 6 for count in non_anchor_bands.values()):
        issues.append(f"Form {form}: 每带非锚真词应为 6，实际 {non_anchor_bands}")
    anchor_bands: dict[str, int] = {}
    for item in bank.vocab:
        if item.anchor:
            anchor_bands[item.band] = anchor_bands.get(item.band, 0) + 1
    if len(anchor_bands) != 5 or any(count != 2 for count in anchor_bands.values()):
        issues.append(f"Form {form}: 锚题应按 2/带覆盖 5 带，实际 {anchor_bands}")

    reading_bands: dict[str, int] = {}
    passages: dict[str, list] = {}
    for item in reading:
        reading_bands[item.band] = reading_bands.get(item.band, 0) + 1
        passages.setdefault(item.passage_id or item.id, []).append(item)
    if len(passages) != 4 or any(len(group) != 5 for group in passages.values()):
        issues.append(
            f"Form {form}: 阅读应为 4 篇 × 5 题，实际 "
            f"{ {key: len(value) for key, value in passages.items()} }"
        )
    if set(reading_bands) != {"A2", "B1", "B2", "C1"}:
        issues.append(f"Form {form}: 阅读带应覆盖 A2–C1，实际 {reading_bands}")

    # 选项/答案合法性（loader 已校验一遍；这里再独立检查，防止 loader 回归）。
    option_sets: set[tuple[str, ...]] = set()
    answer_distribution = {str(index): 0 for index in range(4)}
    for item in list(bank.vocab) + list(reading):
        if len(item.options) != 4 or len(set(item.options)) != 4:
            issues.append(f"Form {form}: {item.id} 选项不是 4 个互不重复项")
        if not isinstance(item.answer_index, int) or not 0 <= item.answer_index <= 3:
            issues.append(f"Form {form}: {item.id} answerIndex 非法")
        elif item.answer_index is not None:
            answer_distribution[str(item.answer_index)] += 1
        if tuple(item.options) in option_sets:
            warnings.append(f"Form {form}: {item.id} 与另一题选项集合完全相同")
        option_sets.add(tuple(item.options))
    for item in pseudo:
        if item.answer_index is not None:
            issues.append(f"Form {form}: 伪词 {item.id} 不应有 answerIndex")
        if len(item.options) != 4 or len(set(item.options)) != 4:
            issues.append(f"Form {form}: 伪词 {item.id} 选项非法")
    if any(count == 0 for count in answer_distribution.values()):
        warnings.append(f"Form {form}: answerIndex 分布不均 {answer_distribution}")

    # 伪词不在仓库词表：只做「未收录」的最低检查，不能替代词典人工审校。
    pseudo_not_in_wordlist = None
    if wordlist is not None:
        entries = wordlist.get("entries") or []
        forms_map = wordlist.get("forms") or {}
        entry_words = {str(row[0]).lower() for row in entries if isinstance(row, list)}
        form_words = {str(word).lower() for word in forms_map}
        pseudo_not_in_wordlist = True
        for item in pseudo:
            word = item.prompt.strip().lower()
            if word in entry_words or word in form_words:
                pseudo_not_in_wordlist = False
                issues.append(f"Form {form}: 伪词 {item.id}（{word}）在仓库词表中被收录")
    else:
        warnings.append("仓库词表缺失：未做伪词词典检查（需人工确认）")

    summary = {
        "items": {
            "total": len(bank.vocab) + len(pseudo) + len(reading),
            "vocab": {
                "total": len(bank.vocab),
                "real": len(bank.vocab),
                "nonAnchor": len(real_vocab),
                "pseudo": len(pseudo),
                "slots": len(bank.vocab) + len(pseudo),
                "bands": dict(sorted(vocab_bands.items())),
                "nonAnchorBands": dict(sorted(non_anchor_bands.items())),
            },
            "reading": {
                "total": len(reading),
                "passages": len(passages),
                "questionsPerPassage": {key: len(value) for key, value in passages.items()},
                "bands": dict(sorted(reading_bands.items())),
            },
            "pseudoBands": _counter(item.band for item in pseudo),
        },
        "anchors": {
            "count": len(bank.anchor_ids),
            "ids": list(bank.anchor_ids),
            "bands": dict(sorted(anchor_bands.items())),
        },
        "answerIndexDistribution": answer_distribution,
        "pseudoWordsNotInWordlist": pseudo_not_in_wordlist,
        "parameterStatus": bank.parameter_status,
        "readingCopyright": "自写短文（无第三方版权内容）",
    }
    return summary, issues, warnings


def _counter(values) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[str(value)] = counts.get(str(value), 0) + 1
    return dict(sorted(counts.items()))


def _check_anchors(bank_a, bank_b) -> tuple[dict, list[str], list[str]]:
    issues: list[str] = []
    warnings: list[str] = []
    if bank_a.anchor_ids != bank_b.anchor_ids:
        issues.append("Form A/B 锚题 id 列表不一致")
    a_by = {item.id: item for item in bank_a.vocab if item.anchor}
    b_by = {item.id: item for item in bank_b.vocab if item.anchor}
    if set(a_by) != set(b_by):
        issues.append("Form A/B 锚题集合不一致")
    rows: list[dict] = []
    for anchor_id in bank_a.anchor_ids:
        left = a_by.get(anchor_id)
        right = b_by.get(anchor_id)
        if left is None or right is None:
            issues.append(f"锚题 {anchor_id} 未同时出现在 A/B")
            continue
        for field in ANCHOR_FIELDS:
            if getattr(left, field) != getattr(right, field):
                issues.append(f"锚题 {anchor_id} 的 {field} 在 A/B 不一致")
        rows.append(
            {
                "id": anchor_id,
                "band": left.band,
                "prompt": left.prompt,
                "answerIndex": left.answer_index,
                "b": left.b,
                "identicalAcrossForms": all(
                    getattr(left, field) == getattr(right, field)
                    for field in ANCHOR_FIELDS
                ),
            }
        )
    if any(not row["identicalAcrossForms"] for row in rows):
        warnings.append("锚题存在不一致项（已计入 issues）")
    return (
        {
            "count": len(rows),
            "min": placement.ANCHOR_MIN,
            "max": placement.ANCHOR_MAX,
            "ids": list(bank_a.anchor_ids),
            "bands": _counter(row["band"] for row in rows),
            "identicalAcrossForms": not any(
                not row["identicalAcrossForms"] for row in rows
            ),
            "items": rows,
            "parameterStatus": "editorial_uncalibrated",
            "method": "common_anchor（共享题 + 共享 b；pilot 前 form offset = 0）",
        },
        issues,
        warnings,
    )


def _check_served_papers() -> tuple[dict, list[str], list[str]]:
    issues: list[str] = []
    warnings: list[str] = []
    rows: list[dict] = []
    for form in FORMS:
        for index in range(3):
            session_id = f"p2{form.lower()}-qa-{index}"
            items = placement.sample_items(session_id, version="v2", form=form)
            counts = _counter(item.type for item in items)
            anchors = sum(1 for item in items if item.anchor)
            passages = sorted(
                {item.passage_id for item in items if item.type == "reading"}
            )
            if len(items) != placement.SERVED_TOTAL:
                issues.append(f"Form {form} 样卷题数 {len(items)} != 32")
            if counts != {"vocab": 24, "reading": 5, "pseudo": 3}:
                issues.append(f"Form {form} 样卷题型 {counts} != 24/5/3")
            if anchors != len(placement.load_form_bank(form).anchor_ids):
                issues.append(f"Form {form} 样卷锚题数 {anchors} 与题库锚题数不一致")
            if len(passages) != 4:
                issues.append(f"Form {form} 样卷阅读只覆盖 {len(passages)} 篇短文")
            rows.append(
                {
                    "form": form,
                    "sample": index + 1,
                    "items": len(items),
                    "counts": counts,
                    "anchors": anchors,
                    "readingPassages": passages,
                }
            )
    return (
        {
            "design": {
                "vocab": placement.SERVED_VOCAB,
                "reading": placement.SERVED_READING,
                "pseudo": placement.SERVED_PSEUDO,
                "total": placement.SERVED_TOTAL,
                "durationLimitMs": placement.DURATION_LIMIT_MS,
            },
            "samples": rows,
            "allFormsServed": True,
        },
        issues,
        warnings,
    )


def build_report(*, generated_at: str | None = None) -> dict:
    """构建报告 dict；只读仓库文件，不写盘、不连库、不联网。"""
    try:
        bank_a = placement.load_form_bank("A")
        bank_b = placement.load_form_bank("B")
    except placement.PlacementUnavailable as exc:
        raise BankAuditError(str(exc)) from exc

    issues: list[str] = []
    warnings: list[str] = []
    forms: dict[str, dict] = {}
    for form, bank in (("A", bank_a), ("B", bank_b)):
        summary, form_issues, form_warnings = _audit_form(form, bank, _load_wordlist())
        forms[form] = summary
        issues.extend(form_issues)
        warnings.extend(form_warnings)

    anchors, anchor_issues, anchor_warnings = _check_anchors(bank_a, bank_b)
    issues.extend(anchor_issues)
    warnings.extend(anchor_warnings)

    served, served_issues, served_warnings = _check_served_papers()
    issues.extend(served_issues)
    warnings.extend(served_warnings)

    # 参数提醒：b 若不是带中心，说明可能有人改了题参；报告必须显式标出。
    for form in FORMS:
        bank = placement.load_form_bank(form)
        for item in bank.all_items:
            if item.b is None:
                issues.append(f"Form {form}: {item.id} 缺题级参数 b")
            elif abs(item.b - assessment.BAND_CENTERS[item.band]) > 1e-9:
                warnings.append(
                    f"Form {form}: {item.id} 的 b 偏离带中心 "
                    f"({item.b} vs {assessment.BAND_CENTERS[item.band]})；"
                    "若为标定值请更新 parameterStatus"
                )

    p_items = [
        _item_row(form, item, p_value=None)
        for form, bank in (("A", bank_a), ("B", bank_b))
        for item in bank.all_items
    ]
    report = {
        "schema": "placement-items-report.v1",
        "generatedAt": generated_at
        or _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "reportDate": "2026-11-17",
        "status": "draft_uncalibrated",
        "notice": (
            "草稿，未经 pilot 校准：题级 b 为题带中心/编辑占位，p 值全部 pending；"
            "本报告不构成效度证据，不对外宣称准确率或等级。"
        ),
        "bankVersion": placement.BANK_VERSION_LABELS[placement.FORMS_BANK_VERSION],
        "calibrationVersion": assessment.CALIBRATION_VERSION_V2,
        "forms": forms,
        "anchors": anchors,
        "servedPaper": served,
        "pValues": {
            "status": "pending_pilot",
            "reason": (
                "真实 p 值需要 30–50 人 pilot 的逐题作答；"
                "本期不生成任何统计值，items 里全部为 null。"
            ),
            "items": p_items,
        },
        "equating": {
            "method": "common_anchor",
            "status": "structure_ready_uncalibrated",
            "formOffsets": dict(placement.FORM_OFFSETS),
            "note": (
                "Form A/B 共享 10 道锚题（同题/同 b）；form offset 暂固定 0，"
                "pilot 后按锚题法重估。当前只能说「结构已就位」，不能说「已等值」。"
            ),
        },
        "checks": {
            "passed": not issues,
            "issueCount": len(issues),
            "warningCount": len(warnings),
        },
        "issues": issues,
        "warnings": warnings,
    }
    return report


def write_report(report: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验定位测 Form A/B 题库并写报告")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="报告输出路径")
    parser.add_argument("--check", action="store_true", help="只校验，不写报告")
    args = parser.parse_args(argv)

    try:
        report = build_report()
    except BankAuditError as exc:
        print(f"FAIL: 题库加载失败：{exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI 兜底，不吞堆栈语义
        print(f"FAIL: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    for form in FORMS:
        summary = report["forms"][form]
        print(
            f"Form {form}: {summary['items']['total']} 题 "
            f"({summary['items']['vocab']['real']} 真词 + "
            f"{summary['items']['vocab']['pseudo']} 伪词 = "
            f"{summary['items']['vocab']['slots']} 词汇槽 + "
            f"{summary['items']['reading']['total']} 阅读；"
            f"锚题 {summary['anchors']['count']})"
        )
    print(
        f"锚题一致性：{'OK' if report['anchors']['identicalAcrossForms'] else 'FAIL'}；"
        f"p 值：{report['pValues']['status']}"
    )
    if not args.check:
        out = Path(args.out)
        write_report(report, out)
        print(f"报告：{out}")
    if report["issues"]:
        print(f"FAIL: {len(report['issues'])} 个 issue", file=sys.stderr)
        for issue in report["issues"]:
            print(f"  - {issue}", file=sys.stderr)
        return 1
    if report["warnings"]:
        print(f"WARN: {len(report['warnings'])} 个 warning")
        for warning in report["warnings"]:
            print(f"  - {warning}")
    print("PASS: 题库结构与锚题一致性校验通过（p 值/pilot 未做）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
