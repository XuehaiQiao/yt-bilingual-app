#!/usr/bin/env bash
# =============================================================================
# 语途（LinguaTrek）生产上线只读预检 —— linguatrekai.online
#
# 只做读取类检查：DNS、TCP 端口、HTTPS、健康检查、安全头、www 跳转、注册闸门。
# 不会 SSH、不会写服务器文件、不会执行部署/重启，也不会修改 DNS/证书/应用数据。
# 唯一的 POST 是「故意不带邀请码」的注册探测：服务端在写库前拒绝（403
# invite_required），不会创建账号。2026-11-20 起网关已移除，访问控制只有邀请码。
#
# 用法：
#   ./scripts/preflight-production.sh
#   ./scripts/preflight-production.sh --domain linguatrekai.online \
#       --expected-ip 43.245.199.136
#
# 不联网/无法解析时明确失败（退出码 1）；只有警告时退出码 0。
# 依赖：bash、curl；dig 优先，否则 getent 或 python3；nc 可选（仅端口探测）。
# =============================================================================
set -uo pipefail

DOMAIN="${DOMAIN:-linguatrekai.online}"
EXPECTED_IP="${EXPECTED_IP:-43.245.199.136}"
TIMEOUT="${PREFLIGHT_TIMEOUT:-10}"
# 本机 resolver 返回代理 fake-IP 时，HTTPS 检查用 --resolve 直连 EXPECTED_IP，
# 避免把“本机代理接管 DNS”误判成源站故障；公网 DNS 仍单独检查。
USE_RESOLVE=0

PASS=0
WARN=0
FAIL=0

usage() {
	cat <<'EOF'
生产上线只读预检（linguatrekai.online）

选项：
  --domain <域名>        默认 linguatrekai.online
  --expected-ip <IPv4>   默认 43.245.199.136（VPS 地址）
  --timeout <秒>         单次网络请求超时，默认 10
  -h, --help             显示本帮助

退出码：0 = 无失败（可有警告）；1 = 有失败（含离线/不可达）；2 = 参数错误。
EOF
}

pass() {
	PASS=$((PASS + 1))
	printf 'PASS  %s\n' "$*"
}

warn() {
	WARN=$((WARN + 1))
	printf 'WARN  %s\n' "$*"
}

fail() {
	FAIL=$((FAIL + 1))
	printf 'FAIL  %s\n' "$*"
}

die_usage() {
	printf '参数错误：%s\n' "$*" >&2
	usage >&2
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--domain)
		[ $# -ge 2 ] || die_usage "--domain 需要参数"
		DOMAIN="$2"
		shift 2
		;;
	--expected-ip)
		[ $# -ge 2 ] || die_usage "--expected-ip 需要参数"
		EXPECTED_IP="$2"
		shift 2
		;;
	--timeout)
		[ $# -ge 2 ] || die_usage "--timeout 需要参数"
		TIMEOUT="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die_usage "未知参数：$1"
		;;
	esac
done

case "$DOMAIN" in
'' | *[!A-Za-z0-9.-]* | .* | *..* | *.)
	die_usage "域名格式不合法：$DOMAIN"
	;;
esac
case "$EXPECTED_IP" in
'' | *[!0-9.]*)
	die_usage "IP 格式不合法：$EXPECTED_IP"
	;;
esac
case "$TIMEOUT" in
'' | *[!0-9]*)
	die_usage "超时必须是整数秒：$TIMEOUT"
	;;
esac

if ! command -v curl >/dev/null 2>&1; then
	printf 'FAIL  本机缺少 curl，无法执行只读预检\n' >&2
	exit 1
fi

curl_site() {
	if [ "$USE_RESOLVE" -eq 1 ]; then
		# 443 固定用 --resolve：仍校验证书与 Host/SNI，只是绕过本机 fake-IP。
		curl --resolve "$DOMAIN:443:$EXPECTED_IP" \
			--resolve "www.$DOMAIN:443:$EXPECTED_IP" "$@"
	else
		curl "$@"
	fi
}

curl_ro() {
	curl_site --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" "$@"
}

http_code() {
	# $1 = URL；其它参数透传给 curl。输出 HTTP 状态码（失败时为 000）。
	curl_ro -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true
}

fetch_headers() {
	# $1 = URL；其它参数透传给 curl。输出响应头（失败时为空）。
	curl_ro -sS -D - -o /dev/null "$@" 2>/dev/null || true
}

header_code() {
	# 从 curl -D - 的输出中取状态码。
	printf '%s\n' "$1" | awk 'NR==1 {print $2; exit}'
}

header_has() {
	# $1 = 头名（不区分大小写）；$2 = 响应头文本。
	printf '%s\n' "$2" | grep -qi "^$1:"
}

resolve_a() {
	# $1 = 主机名；$2 = 可选 DNS 服务器。输出 IPv4（每行一个）。
	host="$1"
	server="${2:-}"
	if command -v dig >/dev/null 2>&1; then
		if [ -n "$server" ]; then
			dig +short A "$host" "@$server" +time=3 +tries=1 2>/dev/null
		else
			dig +short A "$host" +time=3 +tries=1 2>/dev/null
		fi
	elif command -v getent >/dev/null 2>&1; then
		getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u
	elif command -v python3 >/dev/null 2>&1; then
		python3 - "$host" <<'PY' 2>/dev/null
import socket
import sys
try:
    for item in socket.getaddrinfo(sys.argv[1], 443, socket.AF_INET, socket.SOCK_STREAM):
        print(item[4][0])
except OSError:
    pass
PY
	else
		return 1
	fi
}

port_open() {
	# $1 = 主机；$2 = 端口。仅做 TCP 连接，不发业务请求。
	host="$1"
	port="$2"
	if command -v nc >/dev/null 2>&1; then
		nc -z -w 3 "$host" "$port" >/dev/null 2>&1
		return $?
	fi
	if command -v timeout >/dev/null 2>&1; then
		timeout 5 bash -c "</dev/tcp/$host/$port" >/dev/null 2>&1
		return $?
	fi
	# 没有 nc/timeout 时不冒充成功。
	return 127
}

printf '===== 只读预检：https://%s/（期望 IP %s）=====\n' "$DOMAIN" "$EXPECTED_IP"

# ---- 1) DNS ----
PUBLIC_A="$(resolve_a "$DOMAIN" "1.1.1.1")"
if [ -z "$PUBLIC_A" ]; then
	fail "无法通过 1.1.1.1 解析 $DOMAIN（离线、DNS 被拦截或记录不存在）"
elif printf '%s\n' "$PUBLIC_A" | grep -Fxq "$EXPECTED_IP"; then
	pass "公网 DNS（1.1.1.1）：$DOMAIN -> $EXPECTED_IP"
else
	fail "公网 DNS（1.1.1.1）未指向 $EXPECTED_IP，当前：$(printf '%s ' $PUBLIC_A)"
fi

PUBLIC_WWW="$(resolve_a "www.$DOMAIN" "1.1.1.1")"
if [ -z "$PUBLIC_WWW" ]; then
	fail "无法通过 1.1.1.1 解析 www.$DOMAIN（缺少 A/AAAA 或 CNAME）"
elif printf '%s\n' "$PUBLIC_WWW" | grep -Fxq "$EXPECTED_IP"; then
	pass "公网 DNS（1.1.1.1）：www.$DOMAIN -> $EXPECTED_IP"
else
	fail "公网 DNS（1.1.1.1）www.$DOMAIN 未指向 $EXPECTED_IP，当前：$(printf '%s ' $PUBLIC_WWW)"
fi

LOCAL_A="$(resolve_a "$DOMAIN")"
case "$LOCAL_A" in
*198.18.* | *198.19.*)
	warn "本机 resolver 返回 198.18/198.19（常见于代理 fake-IP），不代表 DNS 未生效；以上方 1.1.1.1 结果为准"
	USE_RESOLVE=1
	;;
'')
	warn "本机 resolver 没有返回 $DOMAIN 的地址（可能仍在缓存/被代理接管）"
	USE_RESOLVE=1
	;;
*)
	if printf '%s\n' "$LOCAL_A" | grep -Fxq "$EXPECTED_IP"; then
		pass "本机 resolver：$DOMAIN -> $EXPECTED_IP"
	else
		warn "本机 resolver 与公网结果不同（本机：$(printf '%s ' $LOCAL_A)）；以公网/目标网络复核为准"
		USE_RESOLVE=1
	fi
	;;
esac
if [ "$USE_RESOLVE" -eq 1 ]; then
	warn "HTTPS 检查改用 --resolve 直连 $EXPECTED_IP（仍校验 SNI/证书）；浏览器侧请另用目标网络复核本机 DNS"
fi

# ---- 2) TCP 端口 ----
for port in 80 443; do
	if port_open "$EXPECTED_IP" "$port"; then
		pass "TCP $EXPECTED_IP:$port 可连接"
	elif [ $? -eq 127 ]; then
		warn "本机缺少 nc/timeout，跳过 TCP $port 探测"
	else
		fail "TCP $EXPECTED_IP:$port 不可连接（防火墙/安全组/服务未启动）"
	fi
done
if port_open "$EXPECTED_IP" 22; then
	pass "TCP $EXPECTED_IP:22 可连接（SSH；未尝试登录）"
elif [ $? -eq 127 ]; then
	warn "本机缺少 nc/timeout，跳过 TCP 22 探测"
else
	warn "TCP $EXPECTED_IP:22 不可连接；若 SSH 使用其他端口或已限制来源，可忽略"
fi

# ---- 3) HTTPS 首页必须 200（无认证层） ----
ROOT_HEADERS="$(fetch_headers "https://$DOMAIN/")"
ROOT_CODE="$(header_code "$ROOT_HEADERS")"
if [ -z "$ROOT_CODE" ] || [ "$ROOT_CODE" = "000" ]; then
	fail "https://$DOMAIN/ 不可达（检查 DNS、证书、80/443、Caddy 是否运行）"
elif [ "$ROOT_CODE" = "200" ]; then
	pass "首页不需要任何凭据即返回 200"
elif [ "$ROOT_CODE" = "401" ] || [ "$ROOT_CODE" = "403" ]; then
	fail "首页返回 $ROOT_CODE：Caddy 层仍在做认证（网关已于 2026-11-20 移除，检查 Caddyfile）"
elif [ "$ROOT_CODE" = "502" ] || [ "$ROOT_CODE" = "503" ] || [ "$ROOT_CODE" = "504" ]; then
	fail "首页返回 $ROOT_CODE（Caddy 到了，但后端/反代异常）"
else
	fail "首页返回 $ROOT_CODE（期望 200）"
fi

# ---- 4) 健康检查 ----
HEALTH_HEADERS="$(fetch_headers "https://$DOMAIN/healthz")"
HEALTH_CODE="$(header_code "$HEALTH_HEADERS")"
if [ "$HEALTH_CODE" = "200" ]; then
	pass "访问 /healthz 返回 200"
elif [ -z "$HEALTH_CODE" ] || [ "$HEALTH_CODE" = "000" ]; then
	fail "https://$DOMAIN/healthz 不可达"
else
	fail "/healthz 返回 $HEALTH_CODE（期望 200）"
fi

HEALTH_BODY="$(curl_ro -sS "https://$DOMAIN/healthz" 2>/dev/null || true)"
if [ "$HEALTH_CODE" = "200" ]; then
	HEALTH_OK=0
	MIGRATION=""
	if command -v python3 >/dev/null 2>&1; then
		if MIGRATION="$(printf '%s' "$HEALTH_BODY" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if data.get("status") != "ok":
    sys.exit(1)
db = data.get("db") or {}
if db.get("ok") is not True:
    sys.exit(1)
migrations = db.get("migrations") or {}
print(migrations.get("current") or "")
' 2>/dev/null)"; then
			HEALTH_OK=1
		fi
	else
		case "$HEALTH_BODY" in
		*'"status":"ok"'*) HEALTH_OK=1 ;;
		esac
	fi
	if [ "$HEALTH_OK" -eq 1 ]; then
		pass "健康检查 JSON：status=ok、db.ok=true${MIGRATION:+，迁移=$MIGRATION}"
	else
		fail "健康检查 JSON 不是 status=ok / db.ok=true：$(printf '%s' "$HEALTH_BODY" | head -c 300)"
	fi
fi
if [ "$(http_code "https://$DOMAIN/health")" = "200" ]; then
	pass "访问 /health 返回 200"
else
	fail "/health 未返回 200（后端异常）"
fi

# ---- 5) 安全头（首页 200 应带） ----
if [ -n "$ROOT_HEADERS" ]; then
	for name in Strict-Transport-Security Content-Security-Policy X-Content-Type-Options Referrer-Policy Permissions-Policy; do
		if header_has "$name" "$ROOT_HEADERS"; then
			pass "首页响应包含 $name"
		else
			fail "首页响应缺少 $name"
		fi
	done
	if header_has "Server" "$ROOT_HEADERS"; then
		warn "首页响应仍带 Server 头（低风险，不阻塞）"
	fi
fi

# ---- 6) www 301 ----
WWW_HEADERS="$(fetch_headers "https://www.$DOMAIN/")"
WWW_CODE="$(header_code "$WWW_HEADERS")"
if [ "$WWW_CODE" = "301" ] || [ "$WWW_CODE" = "308" ]; then
	WWW_LOCATION="$(printf '%s\n' "$WWW_HEADERS" | awk 'tolower($0) ~ /^location:/ {sub(/^[^:]*:[[:space:]]*/, ""); print; exit}' | tr -d '\r')"
	case "$WWW_LOCATION" in
	"https://$DOMAIN/" | "https://$DOMAIN" | "https://$DOMAIN/"*)
		pass "www 跳转到主域：$WWW_CODE $WWW_LOCATION"
		;;
	*)
		fail "www 跳转目标不是 https://$DOMAIN/：$WWW_LOCATION"
		;;
	esac
elif [ -z "$WWW_CODE" ] || [ "$WWW_CODE" = "000" ]; then
	fail "https://www.$DOMAIN/ 不可达（www 证书/DNS/跳转配置异常）"
else
	fail "https://www.$DOMAIN/ 返回 $WWW_CODE（期望 301）"
fi

# ---- 7) 注册闸门：G1 只邀请制，公开注册必须关闭 ----
REG_BODY="$(curl_ro -sS "https://$DOMAIN/api/auth/registration" 2>/dev/null || true)"
if [ -z "$REG_BODY" ]; then
	fail "无法读取 /api/auth/registration"
else
	REG_OPEN=""
	if command -v python3 >/dev/null 2>&1; then
		REG_OPEN="$(printf '%s' "$REG_BODY" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
value = data.get("registrationOpen")
if not isinstance(value, bool):
    sys.exit(1)
print("true" if value else "false")
' 2>/dev/null || true)"
	fi
	if [ -z "$REG_OPEN" ]; then
		case "$REG_BODY" in
		*'"registrationOpen":false'*) REG_OPEN="false" ;;
		*'"registrationOpen":true'*) REG_OPEN="true" ;;
		*) REG_OPEN="" ;;
		esac
	fi
	case "$REG_OPEN" in
	false)
		pass "/api/auth/registration：registrationOpen=false"
		;;
	true)
		fail "/api/auth/registration：公开注册已打开（G1 内测应保持 registrationOpen=false）"
		;;
	*)
		fail "/api/auth/registration 无法解析 registrationOpen：$(printf '%s' "$REG_BODY" | head -c 200)"
		;;
	esac
fi

# 无邀请码注册必须被拒；服务端在写库前返回 403，不会创建账号。
SIGNUP_TS="$(date +%s)"
SIGNUP_JSON="$(printf '{"email":"preflight-noinvite-%s@example.invalid","password":"Preflight-NoInvite-%s","username":"preflight"}' "$SIGNUP_TS" "$SIGNUP_TS")"
SIGNUP_RAW="$(curl_ro -sS -w '\nHTTPCODE:%{http_code}' \
	-X POST -H 'Content-Type: application/json' -d "$SIGNUP_JSON" \
	"https://$DOMAIN/api/auth/signup" 2>/dev/null || true)"
SIGNUP_CODE="$(printf '%s\n' "$SIGNUP_RAW" | awk -F: '/^HTTPCODE:/ {print $2}' | tail -1)"
SIGNUP_BODY="$(printf '%s\n' "$SIGNUP_RAW" | sed '/^HTTPCODE:/d')"
if [ "$SIGNUP_CODE" = "403" ] && printf '%s' "$SIGNUP_BODY" | grep -q '"code":"invite_required"'; then
	pass "无邀请码注册被拒：403 invite_required"
elif [ "$SIGNUP_CODE" = "201" ] || [ "$SIGNUP_CODE" = "200" ]; then
	fail "无邀请码注册竟然返回 $SIGNUP_CODE：邀请闸门失效，立即排查"
else
	fail "无邀请码注册返回 $SIGNUP_CODE（期望 403 invite_required）：$(printf '%s' "$SIGNUP_BODY" | head -c 200)"
fi

# ---- 8) 结论 ----
printf '\n===== 结果：PASS=%d WARN=%d FAIL=%d =====\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
	printf '存在失败项：先修复，不要把当前状态当作可上线。\n'
	exit 1
fi
printf '未发现阻塞项；WARN 项请人工确认后再上线。\n'
exit 0
