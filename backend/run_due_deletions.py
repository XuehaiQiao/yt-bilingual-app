"""到期删除请求的安全执行脚本（M2a / specs/033）。

管理员也可以在 ``POST /api/admin/deletion-requests/{id}/execute`` 手动执行；
本脚本供 cron/运维在「冷静期已到期」时批量执行，**默认 dry-run**，必须显式
``--confirm`` 才会真正删除：

    cd backend
    venv/bin/python run_due_deletions.py                 # 只列出到期请求
    venv/bin/python run_due_deletions.py --confirm       # 执行
    venv/bin/python run_due_deletions.py --confirm --limit 10
    venv/bin/python run_due_deletions.py --cleanup-exports  # 只清理过期 ZIP

执行口径与后台一致：只处理 ``status='pending'`` 且 ``due_at_ms <= now`` 的申请；
执行前服务层会再次校验用户仍为 ``deletion_pending``、最后管理员保护，文件删除
失败会把申请标 ``failed`` 并保留用户行供重试，不会假装成功。
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

import account_export
import account_lifecycle

logger = logging.getLogger("linguatrek.due_deletions")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="执行到期账号删除请求（默认 dry-run，需 --confirm 才删除）"
    )
    parser.add_argument(
        "--confirm", action="store_true", help="真正执行删除；缺省只列出"
    )
    parser.add_argument(
        "--limit", type=int, default=100, help="本次最多处理多少条（默认 100）"
    )
    parser.add_argument(
        "--operator",
        default="system:due-deletions",
        help="写入审计的执行者标识（默认 system:due-deletions）",
    )
    parser.add_argument(
        "--cleanup-exports",
        action="store_true",
        help="先清理过期/僵尸导出临时文件（安全，不需要 --confirm）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.cleanup_exports:
        print(
            json.dumps(
                {"cleanup": account_export.cleanup_exports()}, ensure_ascii=False
            )
        )
    due = account_lifecycle.list_due_deletions(limit=args.limit)
    print(json.dumps({"due": due, "count": len(due)}, ensure_ascii=False))
    if not due:
        return 0
    if not args.confirm:
        print("dry-run：未传 --confirm，不执行任何删除。", file=sys.stderr)
        return 0

    failed = 0
    for item in due:
        try:
            result = account_lifecycle.execute_deletion(
                item["id"],
                args.operator,
                reason="冷静期到期，由 run_due_deletions.py 执行",
                force=False,
            )
            print(
                json.dumps(
                    {
                        "id": item["id"],
                        "status": result.get("status"),
                        "counts": result.get("counts"),
                    },
                    ensure_ascii=False,
                )
            )
        except account_lifecycle.LifecycleError as exc:
            failed += 1
            print(
                json.dumps(
                    {"id": item["id"], "error": exc.code, "detail": str(exc)},
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001 - 脚本按条继续，最后非 0 退出
            failed += 1
            logger.exception("执行删除失败：%s", item["id"])
            print(
                json.dumps(
                    {"id": item["id"], "error": type(exc).__name__, "detail": str(exc)},
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
