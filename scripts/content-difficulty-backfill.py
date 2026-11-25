#!/usr/bin/env python3
"""内容分级只读对比（P2-46）——**不写库、不回填、不改缓存**。

回答「同一文章本地 B1 / 线上 B2 来自哪一层」。只读三处：

1. ``content/library/{videos,articles}/*.json`` + ``content/curated.json``
   （编辑级 ``level``）；
2. 本地 ``content_difficulty``（算法级 ``cefr_input``，由回填脚本写入）；
3. 可选 ``--api-base`` 的线上 ``GET /api/content/difficulty/batch``（只读 HTTP）。

报告默认写 ``data/reports/content-difficulty-audit.json``（已 gitignore）。
真正写库的幂等回填仍是 ``scripts/backfill_content_difficulty.py``；本脚本是
回填前的闸门：先确认差异，再决定是否回填、在哪些环境回填。

用法（仓库根目录）：

    backend/venv/bin/python scripts/content-difficulty-backfill.py
    backend/venv/bin/python scripts/content-difficulty-backfill.py \\
        --api-base https://linguatrekai.online

退出码：0 = 本地覆盖完整且（指定线上时）展示等级一致；1 = 有差异/缺行；
2 = 环境或线上接口不可用。两者都不写库。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import content_difficulty  # noqa: E402

DEFAULT_REPORT = ROOT / "data" / "reports" / "content-difficulty-audit.json"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="只读对比内容编辑级与算法级（不写库）"
    )
    parser.add_argument(
        "--api-base",
        default=None,
        help="线上地址（如 https://linguatrekai.online）；省略则只对比本地",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_REPORT,
        help=f"报告输出路径（默认 {DEFAULT_REPORT.relative_to(ROOT)}）",
    )
    parser.add_argument(
        "--timeout", type=float, default=content_difficulty.DEFAULT_TIMEOUT
    )
    parser.add_argument(
        "--limit", type=int, default=10, help="打印不一致条目的上限（默认 10）"
    )
    return parser.parse_args(argv)


def _divergence(report: dict) -> list[str]:
    """需要人工决策的差异（缺行 / 展示不一致 / 线上接口错误）。"""
    summary = report.get("summary") or {}
    local = summary.get("local") or {}
    problems: list[str] = []
    if local.get("editorialMissing"):
        problems.append(f"本地编辑级缺失 {local['editorialMissing']} 条")
    if local.get("legacyUnexpected"):
        problems.append(
            f"本地 content_difficulty 缺行 {local['legacyUnexpected']} 条"
        )
    remote = summary.get("remote")
    if remote is not None:
        if remote.get("error"):
            problems.append(f"线上接口不可用：{remote['error']}")
        if remote.get("missing"):
            problems.append(f"线上返回缺失 {remote['missing']} 条")
        if remote.get("displayMismatch"):
            problems.append(f"本地/线上展示等级不一致 {remote['displayMismatch']} 条")
        if remote.get("editorialDrift"):
            problems.append(f"线上编辑级与本地不同 {remote['editorialDrift']} 条")
    return problems


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = content_difficulty.build_report(
            args.api_base, timeout=args.timeout
        )
    except content_difficulty.AuditUnavailable as exc:
        print(f"环境不可用：{exc}", file=sys.stderr)
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(content_difficulty.format_summary(report))
    mismatches = report.get("mismatches") or []
    if mismatches:
        print(f"\n展示不一致（前 {args.limit} 条）：")
        for item in mismatches[: args.limit]:
            print(
                f" - {item['kind']}:{item['ref']} 本地 {item['localDisplay']}"
                f"（computed {item['computedLevel']} / 编辑 {item['editorialLevel']}）"
                f" vs 线上 {item['remoteDisplay']}"
            )
    problems = _divergence(report)
    if problems:
        print("\n差异：")
        for problem in problems:
            print(f" - {problem}")
        print("\n提示：先确认差异再回填；本脚本未写任何数据库或缓存。")
    elif report.get("summary", {}).get("remote") is not None:
        print("\n本地覆盖完整，两端展示等级一致。")
    else:
        print("\n本地覆盖完整（未指定 --api-base，未做线上对比）。")
    print(f"报告已写入：{args.out}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
