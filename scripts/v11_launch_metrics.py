#!/usr/bin/env python3
"""v1.1 灰度/上线观测门槛：从访问日志算 P95 / 5xx / 429 / 402（只读）。

为什么单独一个脚本：应用每请求写一行 JSON 访问日志（``backend/observability.py``，
``event=http_request``、``path``、``status``、``duration_ms``、``time``），但**没有**
HTTP 延迟/错误率的聚合 API。灰度放量前要回答"现在 P95 多少、失败率多少、429/402
有没有激增"，用这个脚本直接对日志算，不改业务代码、不查库。

用法：

    # 1) 生产：把 journald 里最近 60 分钟日志喂进来
    journalctl -u lingua-nova -o cat --since '60 min ago' \
      | python3 scripts/v11_launch_metrics.py --stdin --since-minutes 60

    # 2) 从文件读（可多次 --log）
    python3 scripts/v11_launch_metrics.py --log /srv/ln/logs/app.log --since-minutes 30

    # 3) 带门槛（不达标 → 退出码 1，可挂进发布脚本）
    python3 scripts/v11_launch_metrics.py --stdin \
      --max-p95-ms 2500 --max-5xx-ratio 0.01 --max-429-ratio 0.02 --max-402-ratio 0.01

统计口径：

- 只统计 ``event=http_request`` 的行；``/health``、``/healthz`` 单独计数（探活
  503 是"降级"语义，不算用户 5xx），不进入延迟/错误率分母；
- P50/P95/P99 用最近秩法（nearest-rank），样本量 <20 时只作参考（``p95_sample_ok``）;
- 429 = 限流（登录/注册/反馈等），402 = 余额不足（billing），按"每千请求"给
  比率，便于和阈值比较；
- 读不到日志/没有访问行时：退出码 0 但输出 ``samples=0``，不伪造数字。

退出码：0 = 达标或无门槛；1 = 有门槛未通过；2 = 参数/输入错误。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timedelta, timezone

HEALTH_PATHS = ("/health", "/healthz")


def die(msg: str, code: int = 2) -> "None":
    print("[metrics] 错误：%s" % msg, file=sys.stderr)
    raise SystemExit(code)


def log(msg: str) -> None:
    print("[metrics] %s" % msg)


def parse_time(text):
    if not text or not isinstance(text, str):
        return None
    value = text.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def percentile(sorted_values, pct: float):
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    rank = int(math.ceil(pct / 100.0 * len(sorted_values)))
    rank = min(max(rank, 1), len(sorted_values))
    return float(sorted_values[rank - 1])


def iter_lines(args):
    if args.stdin:
        for line in sys.stdin:
            yield line
    for path in args.log:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    yield line
        except OSError as exc:
            die("读不到日志文件：%s（%s）" % (path, exc))


def main(argv: "list[str]") -> int:
    parser = argparse.ArgumentParser(description="访问日志 → P95/5xx/429/402 门槛")
    parser.add_argument("--log", action="append", default=[], help="访问日志文件（可重复）")
    parser.add_argument("--stdin", action="store_true", help="从标准输入读日志行")
    parser.add_argument("--since-minutes", type=float, default=0.0,
                        help="只统计最近 N 分钟（依据日志 time 字段；0=全部）")
    parser.add_argument("--max-p95-ms", type=float, default=0.0, help="P95 延迟门槛（毫秒）")
    parser.add_argument("--max-5xx-ratio", type=float, default=0.0, help="5xx 比率门槛（0–1）")
    parser.add_argument("--max-429-ratio", type=float, default=0.0,
                        help="429 比率门槛（每请求，0–1）")
    parser.add_argument("--max-402-ratio", type=float, default=0.0,
                        help="402 比率门槛（每请求，0–1）")
    parser.add_argument("--json", action="store_true", help="只输出一行 JSON")
    args = parser.parse_args(argv)

    if not args.stdin and not args.log:
        die("需要 --log 或 --stdin（至少一个）")
    if args.stdin and hasattr(sys.stdin, "isatty") and sys.stdin.isatty():
        die("--stdin 需要管道输入，例如 journalctl ... | python3 本脚本 --stdin")

    cutoff = None
    if args.since_minutes > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.since_minutes)

    durations = []
    statuses = {}
    by_path = {}
    paths_5xx = {}
    health_requests = 0
    bad_lines = 0
    parsed = 0
    skipped_old = 0

    for line in iter_lines(args):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except ValueError:
            bad_lines += 1
            continue
        if not isinstance(row, dict) or row.get("event") != "http_request":
            continue
        parsed += 1
        moment = parse_time(row.get("time"))
        if cutoff is not None and moment is not None and moment < cutoff:
            skipped_old += 1
            continue
        path = str(row.get("path") or "?")
        status = int(row.get("status") or 0)
        if path in HEALTH_PATHS:
            health_requests += 1
            continue
        try:
            duration = float(row.get("duration_ms") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        durations.append(duration)
        statuses[status] = statuses.get(status, 0) + 1
        bucket = by_path.setdefault(path, {"count": 0, "durations": [], "errors": 0})
        bucket["count"] += 1
        bucket["durations"].append(duration)
        if status >= 500:
            bucket["errors"] += 1
            paths_5xx[path] = paths_5xx.get(path, 0) + 1

    total = len(durations)
    durations.sort()
    p50 = percentile(durations, 50)
    p95 = percentile(durations, 95)
    p99 = percentile(durations, 99)
    p_max = max(durations) if durations else None

    def ratio(count):
        return (float(count) / total) if total else 0.0

    s2xx = sum(c for s, c in statuses.items() if 200 <= s < 300)
    s3xx = sum(c for s, c in statuses.items() if 300 <= s < 400)
    s4xx = sum(c for s, c in statuses.items() if 400 <= s < 500)
    s5xx = sum(c for s, c in statuses.items() if s >= 500)

    slow_paths = []
    for path, bucket in by_path.items():
        ordered = sorted(bucket["durations"])
        slow_paths.append((percentile(ordered, 95), path, bucket["count"]))
    slow_paths.sort(reverse=True)

    result = {
        "samples": total,
        "health_requests": health_requests,
        "skipped_old": skipped_old,
        "parsed_lines": parsed,
        "bad_lines": bad_lines,
        "latency_ms": {
            "p50": round(p50, 1) if p50 is not None else None,
            "p95": round(p95, 1) if p95 is not None else None,
            "p99": round(p99, 1) if p99 is not None else None,
            "max": round(p_max, 1) if p_max is not None else None,
        },
        "p95_sample_ok": total >= 20,
        "status": {"2xx": s2xx, "3xx": s3xx, "4xx": s4xx, "5xx": s5xx},
        "ratios": {
            "5xx": round(ratio(s5xx), 5),
            "429": round(ratio(statuses.get(429, 0)), 5),
            "402": round(ratio(statuses.get(402, 0)), 5),
        },
        "status_429": statuses.get(429, 0),
        "status_402": statuses.get(402, 0),
        "top_5xx_paths": sorted(
            ({"path": p, "count": c} for p, c in paths_5xx.items()),
            key=lambda item: item["count"], reverse=True,
        )[:5],
        "slowest_paths_p95": [
            {"path": p, "p95_ms": round(v, 1), "count": c}
            for v, p, c in slow_paths[:5]
        ],
    }

    failures = []

    def gate(label, actual, limit, ratio_like=False):
        if limit <= 0 or actual is None:
            return
        if ratio_like:
            if actual > limit:
                failures.append("%s=%s > 门槛 %s" % (label, actual, limit))
        elif actual > limit:
            failures.append("%s=%s > 门槛 %s" % (label, actual, limit))

    if total:
        gate("P95", result["latency_ms"]["p95"], args.max_p95_ms)
        gate("5xx 比率", result["ratios"]["5xx"], args.max_5xx_ratio, True)
        gate("429 比率", result["ratios"]["429"], args.max_429_ratio, True)
        gate("402 比率", result["ratios"]["402"], args.max_402_ratio, True)

    result["gate"] = {"ok": not failures, "failures": failures}
    result["options"] = {
        "since_minutes": args.since_minutes,
        "max_p95_ms": args.max_p95_ms,
        "max_5xx_ratio": args.max_5xx_ratio,
        "max_429_ratio": args.max_429_ratio,
        "max_402_ratio": args.max_402_ratio,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        lat = result["latency_ms"]
        window = ("最近 %s 分钟" % args.since_minutes) if args.since_minutes > 0 else "全部"
        print("[metrics] 窗口：%s；解析 %s 行，计入 %s 个请求（跳过 %s 个探活）"
              % (window, parsed, total, health_requests))
        if total:
            print("[metrics] 延迟：P50=%sms  P95=%sms  P99=%sms  max=%sms%s"
                  % (lat["p50"], lat["p95"], lat["p99"], lat["max"],
                     "" if result["p95_sample_ok"] else "（样本<20，仅供参考）"))
            print("[metrics] 状态：2xx=%s 3xx=%s 4xx=%s 5xx=%s；5xx=%s%%，429=%s 次（%s%%），402=%s 次（%s%%）"
                  % (s2xx, s3xx, s4xx, s5xx,
                     round(result["ratios"]["5xx"] * 100, 2),
                     result["status_429"], round(result["ratios"]["429"] * 100, 2),
                     result["status_402"], round(result["ratios"]["402"] * 100, 2)))
            if result["top_5xx_paths"]:
                print("[metrics] 5xx 最多的路径：%s"
                      % ", ".join("%s×%s" % (i["path"], i["count"])
                                  for i in result["top_5xx_paths"]))
            if slow_paths:
                print("[metrics] 最慢路径（P95）：%s"
                      % ", ".join("%s %sms×%s" % (i["path"], i["p95_ms"], i["count"])
                                  for i in result["slowest_paths_p95"]))
        else:
            print("[metrics] 没有可统计的访问日志行（samples=0）；不判定门槛")
        if failures:
            print("[metrics] 门槛：FAIL — %s" % "；".join(failures))
            return 1
        if any(x > 0 for x in (args.max_p95_ms, args.max_5xx_ratio,
                               args.max_429_ratio, args.max_402_ratio)) and total:
            print("[metrics] 门槛：PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:  # pragma: no cover
        raise SystemExit(130)
