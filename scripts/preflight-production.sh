#!/usr/bin/env bash
# =============================================================================
# 语途（LinguaTrek）生产上线只读预检 —— linguatrekai.online
#
# 只做读取类检查：DNS、TCP 端口、HTTPS、健康检查、安全头、www 跳转、
# G1 Basic Auth 是否生效。不会 SSH、不会写服务器文件、不会执行部署/重启，
# 也不会修改 DNS/证书/应用数据。
#
# 用法：
#   ./scripts/preflight-production.sh
#   ./scripts/preflight-production.sh --domain linguatrekai.online \
#       --expected-ip 43.245.199.136
#   # G1 已开启 Basic Auth 时，用 600 权限的 netrc 文件验证 200：
#   ./scripts/preflight-production.sh --netrc "$HOME/.ln-g1.netrc"
#
# 不联网/无法解析时明确失败（退出码 1）；只有警告时退出码 0。
# 依赖：bash、curl；dig 优先，否则 getent 或 python3；nc 可选（仅端口探测）。
# =============================================================================
set -uo pipefail

DOMAIN="${DOMAIN:-linguatrekai.online}"
EXPECTED_IP="${EXPECTED_IP:-43.245.199.136}"
TIMEOUT="${PREFLIGHT_TIMEOUT:-10}"
NETRC="${PREFLIGHT_NETRC:-}"
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
  --netrc <文件>         600 权限的 curl netrc（验证 G1 Basic Auth 后的 200）
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
	--netrc)
		[ $# -ge 2 ] || die_usage "--netrc 需要参数"
		NETRC="$2"
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
if [ -n "$NETRC" ] && [ ! -f "$NETRC" ]; then
	printf 'FAIL  找不到 netrc 文件：%s\n' "$NETRC" >&2
	exit 1
fi
if [ -n "$NETRC" ]; then
	NETRC_MODE="$(stat -c '%a' "$NETRC" 2>/dev/null || stat -f '%Lp' "$NETRC" 2>/dev/null || true)"
	case "$NETRC_MODE" in
	400 | 600) ;;
	'') warn "无法读取 netrc 权限；请确认不是组/其他用户可读" ;;
	*) warn "netrc 权限为 $NETRC_MODE，建议 chmod 600（里面是网关密码）" ;;
	esac
fi

# 只把 netrc 用于 curl；不会打印文件内容。
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
	if [ -n "$NETRC" ]; then
		curl_site --netrc-file "$NETRC" --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" "$@"
	else
		curl_site --connect-timeout "$TIMEOUT" --max-time "$TIMEOUT" "$@"
	fi
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

# ---- 3) HTTPS 首页 / G1 Basic Auth ----
ROOT_HEADERS="$(fetch_headers "https://$DOMAIN/")"
ROOT_CODE="$(header_code "$ROOT_HEADERS")"
if [ -z "$ROOT_CODE" ] || [ "$ROOT_CODE" = "000" ]; then
	fail "https://$DOMAIN/ 不可达（检查 DNS、证书、80/443、Caddy 是否运行）"
elif [ "$ROOT_CODE" = "401" ]; then
	pass "G1 网关生效：未带凭据访问首页返回 401"
	if header_has "www-authenticate" "$ROOT_HEADERS"; then
		pass "401 响应包含 WWW-Authenticate"
	else
		warn "401 响应没有 WWW-Authenticate 头（浏览器可能不会弹窗）"
	fi
elif [ "$ROOT_CODE" = "200" ]; then
	if [ -n "$NETRC" ]; then
		pass "带 netrc 凭据访问首页返回 200"
	else
		warn "未带凭据访问首页返回 200：G1 Basic Auth 可能未生效；若已切 G2 可忽略"
	fi
elif [ "$ROOT_CODE" = "502" ] || [ "$ROOT_CODE" = "503" ] || [ "$ROOT_CODE" = "504" ]; then
	fail "首页返回 $ROOT_CODE（Caddy 到了，但后端/反代异常）"
else
	warn "首页返回 $ROOT_CODE（按实际 G1/G2 配置判断）"
fi

if [ -n "$NETRC" ]; then
	API_CODE="$(http_code "https://$DOMAIN/api/models")"
	if [ "$API_CODE" = "200" ]; then
		pass "带 netrc 凭据访问 /api/models 返回 200"
	elif [ "$API_CODE" = "401" ]; then
		fail "带 netrc 凭据仍返回 401：netrc 用户名/密码或 Caddy 账号不匹配"
	else
		fail "/api/models 返回 $API_CODE（期望 200）"
	fi
else
	API_CODE="$(http_code "https://$DOMAIN/api/models")"
	if [ "$API_CODE" = "401" ]; then
		pass "G1 网关生效：未带凭据访问 /api/models 返回 401"
	elif [ "$API_CODE" = "200" ]; then
		warn "未带凭据访问 /api/models 返回 200：G1 Basic Auth 可能未生效；若已切 G2 可忽略"
	else
		fail "/api/models 返回 $API_CODE（期望 401；若已切 G2 则期望 200）"
	fi
fi

# ---- 4) 健康检查必须绕过 Basic Auth ----
HEALTH_HEADERS="$(fetch_headers "https://$DOMAIN/healthz")"
HEALTH_CODE="$(header_code "$HEALTH_HEADERS")"
if [ "$HEALTH_CODE" = "200" ]; then
	pass "未带凭据访问 /healthz 返回 200（健康检查未被 Basic Auth 挡住）"
elif [ "$HEALTH_CODE" = "401" ]; then
	fail "/healthz 返回 401：Basic Auth 错误地挡住了健康检查"
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
	pass "未带凭据访问 /health 返回 200"
else
	fail "/health 未返回 200（被 Basic Auth 挡住或后端异常）"
fi

# ---- 5) 安全头（首页 401/200 都应带） ----
if [ -n "$ROOT_HEADERS" ]; then
	for name in Strict-Transport-Security Content-Security-Policy X-Content-Type-Options Referrer-Policy Permissions-Policy; do
		if header_has "$name" "$ROOT_HEADERS"; then
			pass "首页响应包含 $name"
		else
			fail "首页响应缺少 $name"
		fi
	done
	if header_has "Server" "$ROOT_HEADERS"; then
		warn "首页响应仍带 Server 头（Caddy 在 401 上可能补回；低风险，不阻塞）"
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

# ---- 7) 结论 ----
printf '\n===== 结果：PASS=%d WARN=%d FAIL=%d =====\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
	printf '存在失败项：先修复，不要把当前状态当作可上线。\n'
	exit 1
fi
printf '未发现阻塞项；WARN 项请人工确认后再上线。\n'
exit 0
