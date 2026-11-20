#!/usr/bin/env python3
"""外部巡检：``/healthz`` 连续失败 N 次 → 飞书 P0（M5，specs/035-feishu-alerts）。

为什么不在应用里直接发：``/healthz`` 是探活端点，一次抖动不代表故障。这里由
cron（每 1–5 分钟）在**进程外**探测，连续 N 次失败才告警，并把计数落在
``data/alerts/health_state.json``（重启/跨次运行不丢）；恢复后计数清零。

用法::

    # 安装前手工验证（不写 state、不发消息）
    backend/venv/bin/python scripts/check-alerts.py --dry-run

    # 生产 cron（真实巡检 + 发送；env 见 deploy/alert-check.cron）
    backend/venv/bin/python scripts/check-alerts.py

    # 本地验证 payload/签名，完全不联网
    backend/venv/bin/python scripts/check-alerts.py --self-test

    # 其它事件（如备份失败）从 shell 主动发一条
    ... --event backup_failed --level P1 --summary "备份文件缺失" --key backup

退出码：0 = 健康 / 已处理；2 = 不健康（已按需告警）；1 = 参数/脚本错误。
所有输出是一行 JSON，便于 cron 日志 grep；**不打印 webhook/secret**。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import alerts  # noqa: E402
import config  # noqa: E402

DEFAULT_URL = "http://127.0.0.1:8000/healthz"
DEFAULT_THRESHOLD = 2
DEFAULT_TIMEOUT = 5.0
DEFAULT_DEDUPE_SECONDS = 1800.0
_MAX_BODY_BYTES = 64 * 1024


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------


def fetch_health(url: str, timeout: float) -> dict:
    """GET ``/healthz``；返回 ``{ok, http_status, app_status, details}``，不抛异常。"""
    request = urllib.request.Request(
        url, headers={"Accept": "application/json"}, method="GET"
    )
    status: int | None = None
    body = ""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(response.getcode() or 0)
            body = response.read(_MAX_BODY_BYTES).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        # /healthz degraded 会返回 503：仍是「有应答」，按不健康记录。
        status = int(exc.code)
        try:
            body = exc.read(_MAX_BODY_BYTES).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            body = ""
    except Exception as exc:  # noqa: BLE001 - 断网/超时/连接拒绝
        return {
            "ok": False,
            "http_status": None,
            "app_status": None,
            "details": {"reason": f"request_failed:{type(exc).__name__}"},
        }

    snapshot: dict = {}
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            snapshot = parsed
    except (TypeError, ValueError):
        snapshot = {}

    app_status = snapshot.get("status") if isinstance(snapshot, dict) else None
    db = snapshot.get("db") if isinstance(snapshot.get("db"), dict) else {}
    migrations = db.get("migrations") if isinstance(db.get("migrations"), dict) else {}
    ok = 200 <= int(status or 0) < 300 and app_status == "ok"
    details = {
        "http_status": status,
        "app_status": app_status,
        "db_ok": bool(db.get("ok")),
        "version": snapshot.get("version"),
        "migration_current": migrations.get("current"),
        "migration_head": migrations.get("head"),
        "uptime_seconds": snapshot.get("uptime_seconds"),
    }
    return {
        "ok": ok,
        "http_status": status,
        "app_status": app_status,
        "details": details,
    }


# ---------------------------------------------------------------------------
# 状态（跨 cron 运行保存连续失败次数）
# ---------------------------------------------------------------------------


def default_state_path() -> Path:
    return Path(config.DATA_DIR) / "alerts" / "health_state.json"


def load_state(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path: Path, state: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def evaluate(
    state: dict,
    probe: dict,
    *,
    threshold: int,
    now: float,
    dedupe_seconds: float,
) -> tuple[dict, bool, str]:
    """根据本次探测更新状态；返回 ``(new_state, should_alert, reason)``。"""
    new_state = dict(state or {})
    new_state["last_check_at"] = now
    if probe.get("ok"):
        new_state["consecutive_failures"] = 0
        new_state["last_status"] = "ok"
        return new_state, False, "healthy"

    failures = int(new_state.get("consecutive_failures") or 0) + 1
    new_state["consecutive_failures"] = failures
    new_state["last_status"] = probe.get("app_status") or "unhealthy"
    if failures < max(1, int(threshold)):
        return new_state, False, f"below_threshold:{failures}/{int(threshold)}"
    last_alert = float(new_state.get("last_alert_at") or 0)
    if dedupe_seconds > 0 and last_alert and now - last_alert < dedupe_seconds:
        return new_state, False, "deduped"
    return new_state, True, f"threshold_reached:{failures}"


def build_alert(probe: dict, state: dict) -> tuple[str, dict]:
    details = dict(probe.get("details") or {})
    details["consecutive_failures"] = int(state.get("consecutive_failures") or 0)
    summary = (
        f"/healthz 连续 {details['consecutive_failures']} 次异常"
        f"（http={details.get('http_status')}，status={details.get('app_status')}）"
    )
    return summary, details


def run_check(
    *,
    url: str,
    state_path: Path,
    threshold: int,
    timeout: float,
    dedupe_seconds: float,
    dry_run: bool = False,
    probe_fn=fetch_health,
    notify_fn=alerts.notify,
) -> dict:
    """执行一次巡检；``probe_fn``/``notify_fn`` 可注入，便于离线测试。"""
    probe = probe_fn(url, timeout)
    state = load_state(state_path)
    now = time.time()
    new_state, should_alert, reason = evaluate(
        state, probe, threshold=threshold, now=now, dedupe_seconds=dedupe_seconds
    )
    result: dict = {
        "checked_at": now,
        "ok": bool(probe.get("ok")),
        "reason": reason,
        "consecutive_failures": int(new_state.get("consecutive_failures") or 0),
        "dry_run": bool(dry_run),
        "alert": None,
    }
    if should_alert:
        summary, details = build_alert(probe, new_state)
        if dry_run:
            result["alert"] = {
                "status": "would_send",
                "sent": False,
                "event": "health_unhealthy",
                "level": "P0",
            }
        else:
            alert_result = notify_fn(
                "health_unhealthy",
                "P0",
                summary=summary,
                key="healthz",
                details=details,
                force=True,
                sync=True,
            )
            result["alert"] = alert_result
            if alert_result.get("sent"):
                new_state["last_alert_at"] = now
    if not dry_run:
        save_state(state_path, new_state)
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _self_test() -> int:
    """离线验证 payload 与签名：transport 是内存假函数，不联网。"""
    captured: dict = {}

    def transport(url: str, body: bytes, timeout: float) -> tuple[int, str]:
        captured["payload"] = json.loads(body.decode("utf-8"))
        return 200, '{"code":0,"msg":"success"}'

    manager = alerts.AlertManager(
        enabled=True,
        webhook_url="https://example.invalid/offline-self-test",
        webhook_secret="offline-demo-secret",
        transport=transport,
        async_send=False,
        background_flush=False,
    )
    result = manager.notify(
        "test", "P0", summary="离线自检消息", key="self-test", force=True, sync=True
    )
    payload = captured.get("payload") or {}
    sign_ok = bool(
        payload.get("sign")
        and payload.get("timestamp")
        and payload["sign"] == alerts.gen_sign(payload["timestamp"], "offline-demo-secret")
    )
    print(
        json.dumps(
            {
                "self_test": True,
                "status": result.get("status"),
                "sent": result.get("sent"),
                "msg_type": payload.get("msg_type"),
                "level": result.get("level"),
                "has_sign": bool(payload.get("sign")),
                "sign_recomputable": sign_ok,
                "note": "transport 是内存假函数，未联网；不打印 webhook/secret",
            },
            ensure_ascii=False,
        )
    )
    return 0 if (result.get("sent") and sign_ok) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="语途 /healthz 巡检 + 飞书告警（M5）",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help=f"默认 {DEFAULT_URL}")
    parser.add_argument(
        "--state-file",
        default=str(default_state_path()),
        help="连续失败计数文件（默认 $DATA_DIR/alerts/health_state.json）",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        help=f"连续失败多少次发 P0（默认 {DEFAULT_THRESHOLD}）",
    )
    parser.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT, help="单次探测超时秒数"
    )
    parser.add_argument(
        "--dedupe-seconds",
        type=float,
        default=DEFAULT_DEDUPE_SECONDS,
        help=f"同一故障重复告警间隔（默认 {int(DEFAULT_DEDUPE_SECONDS)} 秒）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只打印，不发送/不写 state")
    parser.add_argument("--self-test", action="store_true", help="离线验证 payload/签名")
    parser.add_argument("--event", help="改发一条指定事件（如 backup_failed），跳过 /healthz 探测")
    parser.add_argument("--level", default="P1", help="配合 --event 使用，默认 P1")
    parser.add_argument("--summary", default="", help="配合 --event 使用")
    parser.add_argument("--key", default="", help="配合 --event 使用（去重键）")
    args = parser.parse_args(argv)

    if args.self_test:
        return _self_test()

    if args.event:
        result = alerts.notify(
            args.event,
            args.level,
            summary=args.summary or args.event,
            key=args.key,
            force=True,
            sync=True,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("sent") else 1

    threshold = max(1, int(args.threshold))
    result = run_check(
        url=args.url,
        state_path=Path(args.state_file),
        threshold=threshold,
        timeout=max(0.5, float(args.timeout)),
        dedupe_seconds=max(0.0, float(args.dedupe_seconds)),
        dry_run=bool(args.dry_run),
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
