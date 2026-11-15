"""环境与配置：路径、安全开关、模型目录、词汇水平。

所有模块都从这里取配置；load_dotenv 在首次 import 时执行，
保证 GEMINI_API_KEY 等在任何 Gemini 调用之前就已加载。
"""
import os
from dotenv import load_dotenv

# Load .env file (for GEMINI_API_KEY etc.)
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

# --- 数据目录（都可用环境变量覆盖） ---
# HISTORY_DIR 是「无登录用户」时的回落目录（旧数据 / 测试 / 脚本兼容）。
# 登录用户的数据由 storage.py 写到 USER_DATA_DIR/<user_id>/ 下。
HISTORY_DIR = os.environ.get("HISTORY_DIR", os.path.join(_BACKEND_DIR, "..", "history"))
os.makedirs(HISTORY_DIR, exist_ok=True)

SUBTITLES_DIR = os.environ.get("SUBTITLES_DIR", os.path.join(_BACKEND_DIR, "..", "subtitles"))

SENTENCES_DIR = os.environ.get(
    "SENTENCES_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "sentences"),
)

# --- 用户体系数据（SQLite + 每用户目录） ---
# DATA_DIR 默认仓库根的 data/（已 gitignore）。AUTH_DB_PATH 可单独覆盖到别处；
# USER_DATA_DIR 是每个登录用户的数据根目录（其下再分 history/ 等）。
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(_BACKEND_DIR, "..", "data"))
AUTH_DB_PATH = os.environ.get("AUTH_DB_PATH", os.path.join(DATA_DIR, "app.db"))
USER_DATA_DIR = os.environ.get("USER_DATA_DIR", os.path.join(DATA_DIR, "users"))

# 游客态（M1 ⑧，见 guest.py）：游客目录 = GUEST_DATA_DIR/<sha256(ln_guest)>。
# 不建表、不新增迁移；目录名就是游客身份，与其他游客/登录用户完全隔离。
GUEST_DATA_DIR = os.environ.get("GUEST_DATA_DIR", os.path.join(DATA_DIR, "guests"))

# --- Security configuration ---
# CORS_ORIGINS: comma-separated allowed origins. Defaults to "*" for local
# use; ALWAYS set this when deploying publicly.
_cors_env = os.environ.get("CORS_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _cors_env.split(",") if o.strip()] or ["*"]

# API_AUTH_KEY: when set, every /api request must carry a matching X-API-Key
# header. This is an *additional* deployment gate on top of user sessions.
# 注意：它会连 /api/auth/* 一起拦——浏览器界面登录也会被挡。公网多用户
# 浏览器部署不要设；只有移动端/内部客户端（不跑浏览器 UI）才考虑。
API_AUTH_KEY = os.environ.get("API_AUTH_KEY", "")

# BROWSER_UI：是否计划提供浏览器界面（默认开）。设 0/false 表示纯移动端/内部
# 客户端部署，此时 API_AUTH_KEY 不会与登录冲突，也不再打印启动警告。
BROWSER_UI = os.environ.get("BROWSER_UI", "1").strip().lower() not in (
    "0", "false", "no", "off",
)

# Session cookie hardening. Secure must stay off for plain-HTTP local use;
# set COOKIE_SECURE=1 (HTTPS) when deploying publicly.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes", "on")

# 30 days, matching the Set-Cookie Max-Age below.
SESSION_MAX_AGE = 30 * 24 * 60 * 60

# --- 学习事件日志（learning_events，见 events.py） ---
# pseudonym_id = HMAC-SHA256(EVENTS_PSEUDONYM_SALT, user_id)。生产必须设置该环境变量；
# 未设置时退回开发默认盐并告警（可被枚举反推，仅限本地/测试）。逐用户盐表与删除权
# 口径（D-10 / 计划书 §8.4）定稿后，事件表会按表级矩阵迁移到只存假名。
EVENTS_PSEUDONYM_SALT = os.environ.get("EVENTS_PSEUDONYM_SALT", "")

# --- SSE 心跳间隔 ---
# 反向代理（Nginx 60s / Cloudflare 100s）会掐断长时间无输出的 SSE 流。
# 流内每 SSE_HEARTBEAT_SECONDS 秒发一行 `: ping` 注释行；默认 15s，
# 可用 SSE_HEARTBEAT_INTERVAL（秒，>0）覆盖。
def _positive_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0
    if value <= 0:
        print(f"⚠️  {name}={raw!r} 无效，使用默认值 {default:g}s。")
        return default
    return value


SSE_HEARTBEAT_SECONDS = _positive_float_env("SSE_HEARTBEAT_INTERVAL", 15.0)

if ALLOWED_ORIGINS == ["*"] and not API_AUTH_KEY:
    print("⚠️  CORS allows every origin and no API key is set — fine locally "
          "(user sessions are still required); set CORS_ORIGINS before "
          "deploying publicly.")
if API_AUTH_KEY and BROWSER_UI:
    print("⚠️  API_AUTH_KEY 已设置：它会拦截所有 /api 请求（含 /api/auth/*），"
          "浏览器多用户部署请勿设置（登录会被 401）。仅移动端/内部客户端场景保留；"
          "确认不需要浏览器界面时设 BROWSER_UI=0 可关闭本提示。")

# --- Learner level -> description used to calibrate which words get highlighted.
# UI shows metaphors only; the vocabulary sizes live here for the prompt.
VOCAB_LEVELS = {
    "liftoff": "~4,000-word vocabulary (CEFR A2-B1). Highlight anything beyond everyday conversational basics.",
    "orbit": "~6,000-word vocabulary (CEFR B1+). Highlight words beyond common conversational English.",
    "moonwalk": "~8,000-word vocabulary (CEFR B2). Highlight lower-frequency words, idioms and phrasal verbs.",
    "interstellar": "~12,000-word vocabulary (CEFR C1). Highlight genuinely advanced or idiomatic usage only.",
    "deep-space": "~16,000-word vocabulary (CEFR C1+). Highlight only rare words, subtle idioms, cultural references.",
    "supernova": "~20,000+ word vocabulary (near-native, CEFR C2). Only the rarest idioms, slang or specialist jargon.",
    # Legacy ids from earlier releases
    "cet4": "~4,500-word vocabulary (CEFR B1). Highlight words above this level.",
    "cet6": "~6,000-word vocabulary (CEFR B2). Highlight words above this level.",
    "kaoyan": "~8,000-word vocabulary (CEFR B2+). Highlight low-frequency words, idioms and phrasal verbs.",
    "ielts": "~12,000-word vocabulary (CEFR C1). Only highlight genuinely advanced or idiomatic usage.",
    "advanced": "near-native (CEFR C2). Only highlight rare idioms, slang, or cultural references.",
}

# --- Real, selectable models. Prices are USD per 1M tokens (approximate,
# check the provider's pricing page for current numbers); None = 未知，
# 前端会显示"待定"，不要凭印象填数字。
# 字段：
#   kind          google = 官方 SDK；openai_compatible = <base_url>/chat/completions
#   model_id      真正发给厂商的模型名（目录键是前端/请求里用的 id）
#   api_key_env   该模型需要的密钥环境变量
#   batch_pause   批与批之间的停顿（秒），按各家限流调
#
# provider = Google 的三档 Gemini **仅适合海外部署**：中国大陆无法直连
# api 且存在合规问题，大陆商用请不要配 GEMINI_API_KEY，默认模型用 DeepSeek。
MODEL_CATALOG = {
    "gemini-2.5-flash": {
        "name": "Gemini 2.5 Flash", "provider": "Google",
        "kind": "google", "model_id": "gemini-2.5-flash",
        "api_key_env": "GEMINI_API_KEY", "batch_pause": 4,
        "in": 0.30, "out": 2.50, "quotaInfo": "Overseas only · balanced quality & speed",
    },
    # 2.5 Flash-Lite 已对新用户下线（404: no longer available to new users），
    # 换成官方报错里指定的 3.5 Flash-Lite。3.5 的价目还没有可靠来源，
    # 这里留 None（成本一栏显示"待定"），不编数字，等官方价格确认后再填。
    "gemini-3.5-flash-lite": {
        "name": "Gemini 3.5 Flash-Lite", "provider": "Google",
        "kind": "google", "model_id": "gemini-3.5-flash-lite",
        "api_key_env": "GEMINI_API_KEY", "batch_pause": 4,
        "in": None, "out": None, "quotaInfo": "Overseas only · cheapest · great for long videos",
    },
    # 2.5 Pro 同样已对新用户下线（404），官方指向 3.1 Pro (preview)。
    # 预览模型在免费额度下容易 429，价格同样没有可靠来源，故留 None。
    "gemini-3.1-pro-preview": {
        "name": "Gemini 3.1 Pro (preview)", "provider": "Google",
        "kind": "google", "model_id": "gemini-3.1-pro-preview",
        "api_key_env": "GEMINI_API_KEY", "batch_pause": 5,
        "in": None, "out": None, "quotaInfo": "Overseas only · highest quality · slower (preview)",
    },
    # DeepSeek 的 API 与 OpenAI 协议兼容，换 base_url 就能接。
    # 价格同样没有可核实的来源，留 None；批间隔按 1s 走（官方无 15 RPM 限制）。
    # 大陆首发商用的默认模型就是它：api.deepseek.com 国内可直连。
    "deepseek-chat": {
        "name": "DeepSeek-V4.1-Flash", "provider": "DeepSeek",
        "kind": "openai_compatible", "model_id": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
        "api_key_env": "DEEPSEEK_API_KEY", "batch_pause": 1,
        "in": None, "out": None, "quotaInfo": "Default · domestic (CN) · strong Chinese",
    },
    # Qwen（阿里）走 OpenAI 兼容协议；国际站/大陆站端点不同，**不在代码里写死**，
    # 由 QWEN_BASE_URL 提供（缺失时该模型视为不可用、在路线里自动跳过）。
    # 价格没有可核实来源，保持 None（前端显示「待定」），不编数字。
    "qwen-flash": {
        "name": "Qwen Flash", "provider": "Alibaba",
        "kind": "openai_compatible", "model_id": "qwen-flash",
        "base_url_env": "QWEN_BASE_URL",
        "api_key_env": "QWEN_API_KEY", "batch_pause": 1,
        "in": None, "out": None,
        "quotaInfo": "Default · fast & cheap · verify region",
    },
    "qwen-plus": {
        "name": "Qwen Plus", "provider": "Alibaba",
        "kind": "openai_compatible", "model_id": "qwen-plus",
        "base_url_env": "QWEN_BASE_URL",
        "api_key_env": "QWEN_API_KEY", "batch_pause": 1,
        "in": None, "out": None,
        "quotaInfo": "Overseas / mainland endpoints differ · verify region",
    },
}

# --- 默认模型 ---
# 产品在中国大陆首发商用：Google Gemini 在大陆不可用/不合规，默认模型改用
# 国内可直连的 DeepSeek；Gemini 三档保留在 MODEL_CATALOG 里作海外可选项。
# 环境变量 DEFAULT_MODEL 可覆盖（海外部署改回 Gemini 不必动代码），但值必须
# 是 MODEL_CATALOG 里存在的 id，否则回落 deepseek-chat、只打一条警告不中断启动。
DEFAULT_MODEL_FALLBACK = "deepseek-chat"


def _default_model_from_env() -> str:
    """读 `DEFAULT_MODEL` 环境变量；缺省或非法时用 `DEFAULT_MODEL_FALLBACK`。"""
    raw = os.environ.get("DEFAULT_MODEL", "").strip()
    if not raw:
        return DEFAULT_MODEL_FALLBACK
    if raw in MODEL_CATALOG:
        return raw
    print(f"⚠️  DEFAULT_MODEL={raw!r} 不在 MODEL_CATALOG 中，回落到 {DEFAULT_MODEL_FALLBACK}。")
    return DEFAULT_MODEL_FALLBACK


DEFAULT_MODEL = _default_model_from_env()


def resolve_model(model: str | None) -> str:
    return model if model in MODEL_CATALOG else DEFAULT_MODEL


# --- 目标语言模型路线（specs/012-i18n-multilingual §5.5）--- 只增不改。
#
# 每种目标语言一条「按顺序尝试」的候选链：路线只在**选择默认模型**时生效，
# 不改变 010 的「不偷偷故障转移」——运行中某个模型失败仍按批重试/标未翻译。
# 环境变量逗号分隔、可覆盖；未知/已下线的 id 跳过并告警（不中断启动）。
# 大陆部署不配 GEMINI_API_KEY 时 Gemini 自动跳过，路线落到 Qwen/DeepSeek；
# 这里**不把 Gemini 写进任何降级链**（降级链见 ai/quota.py，另按地域过滤）。
DEFAULT_MODEL_ZH_CN_FALLBACK = "deepseek-chat"
DEFAULT_MODEL_VI_VN_FALLBACK = "qwen-flash"


def _model_route_from_env(name: str, default: list[str]) -> list[str]:
    """读 ``MODEL_ROUTE_*``（逗号分隔）；缺失用默认值，未知 id 跳过并告警。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return list(default)
    ids = [item.strip() for item in raw.split(",") if item.strip()]
    unknown = [item for item in ids if item not in MODEL_CATALOG]
    if unknown:
        print(f"⚠️  {name} 含不在 MODEL_CATALOG 的模型 id {unknown}，已跳过。")
    route = [item for item in ids if item in MODEL_CATALOG]
    if not route:
        print(f"⚠️  {name} 没有可用模型 id，回落到默认路线 {default}。")
        return list(default)
    return route


TARGET_LANG_MODEL_ROUTES: dict[str, list[str]] = {
    # 中文：默认 DeepSeek（大陆可直连）；Gemini 仅作为海外部署的可选后续候选。
    "zh-CN": _model_route_from_env(
        "MODEL_ROUTE_ZH_CN", ["deepseek-chat", "gemini-2.5-flash"]
    ),
    # 越南语：Qwen Flash 默认（负责人 2026-11-15）→ Qwen Plus → DeepSeek → Gemini。
    # 站点：阿里云百炼国内站（该 Key 只在 dashscope.aliyuncs.com 有效）。
    "vi-VN": _model_route_from_env(
        "MODEL_ROUTE_VI_VN",
        ["qwen-flash", "qwen-plus", "deepseek-chat", "gemini-2.5-flash"],
    ),
}


def _lang_default_model_from_env(name: str, fallback: str) -> str:
    """按语言的默认模型（``DEFAULT_MODEL_<LANG>``）；非法值告警并回落。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    if raw in MODEL_CATALOG:
        return raw
    print(f"⚠️  {name}={raw!r} 不在 MODEL_CATALOG 中，回落到 {fallback}。")
    return fallback


# 某语言的首选模型；解析模型时「已配置 Key 且可用」才真正生效（见 llm.py）。
DEFAULT_MODEL_ZH_CN = _lang_default_model_from_env(
    "DEFAULT_MODEL_ZH_CN", DEFAULT_MODEL_ZH_CN_FALLBACK
)
DEFAULT_MODEL_VI_VN = _lang_default_model_from_env(
    "DEFAULT_MODEL_VI_VN", DEFAULT_MODEL_VI_VN_FALLBACK
)
DEFAULT_MODEL_BY_LANG = {
    "zh-CN": DEFAULT_MODEL_ZH_CN,
    "vi-VN": DEFAULT_MODEL_VI_VN,
}


def model_route_for(target_lang: str | None) -> list[str]:
    """某目标语言的模型路线（过滤掉已不在目录里的 id）；未知语言用中文路线。"""
    code = target_lang if target_lang in TARGET_LANG_MODEL_ROUTES else "zh-CN"
    return [mid for mid in TARGET_LANG_MODEL_ROUTES[code] if mid in MODEL_CATALOG]


def default_model_for_target(target_lang: str | None) -> str:
    """某目标语言的首选模型 id（未校验 Key 可用性；不可用时由 llm.py 回落）。"""
    code = target_lang if target_lang in DEFAULT_MODEL_BY_LANG else "zh-CN"
    return DEFAULT_MODEL_BY_LANG[code]


# --- 可观测性（M1c）--- 只增不改，避免与并行任务冲突。
#
# APP_VERSION：/healthz 的 version 字段。优先环境变量（发布时注入 commit/tag），
# 其次已安装的包元数据，最后是开发占位值。不凭印象写产品版本号。
def _detect_app_version() -> str:
    explicit = os.environ.get("APP_VERSION", "").strip()
    if explicit:
        return explicit
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("linguatrek")
        except PackageNotFoundError:
            pass
    except Exception:
        pass
    return "0.0.0-dev"


APP_VERSION = _detect_app_version()

# LOG_LEVEL：应用日志级别（DEBUG/INFO/WARNING/ERROR/CRITICAL），默认 INFO。
# 非法值回落 INFO 并打印一次警告，不中断启动。
_LOG_LEVELS = ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
if LOG_LEVEL not in _LOG_LEVELS:
    print(f"⚠️  LOG_LEVEL={LOG_LEVEL!r} 无效，使用默认值 INFO。")
    LOG_LEVEL = "INFO"

# LOG_JSON：访问/异常日志是否输出一行一个 JSON（默认开）。设 0/false 时输出
# 人类可读的纯文本，便于本地排查。
LOG_JSON = os.environ.get("LOG_JSON", "1").strip().lower() not in (
    "0", "false", "no", "off",
)


# --- AI 成本账本与三层配额（M1b，见 backend/ai/）--- 只增不改，避免与并行任务冲突。
#
# 账本默认开启；离线脚本/测试可设 AI_USAGE_LOGGING=0 关掉 llm.py 里的 usage hook。
AI_USAGE_LOGGING = os.environ.get("AI_USAGE_LOGGING", "1").strip().lower() not in (
    "0", "false", "no", "off",
)

# 「日」的边界时区：面向大陆用户，默认 Asia/Shanghai（0 点重置）；配额与账本的
# usage_date 都按它派生。非法时区回落 UTC 并由 ai/ledger.py 告警一次。
AI_QUOTA_TIMEZONE = os.environ.get("AI_QUOTA_TIMEZONE", "Asia/Shanghai").strip() or "Asia/Shanghai"


def _int_env(name: str, default: int) -> int:
    """读非负整数环境变量；缺失/非法/负数回落默认值并打印一次警告。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0:
        print(f"⚠️  {name}={raw!r} 无效，使用默认值 {default}。")
        return default
    return value


def _float_env(name: str, default: float) -> float:
    """读非负浮点环境变量；缺失/非法/负数回落默认值并打印一次警告。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = -1.0
    if value < 0:
        print(f"⚠️  {name}={raw!r} 无效，使用默认值 {default:g}。")
        return default
    return value


# 免费额度（每日，0 = 关闭该功能）。翻译按「批」计：1 批 ≤20 个字幕块 ≈ 2 分钟
# 视频，60 批 ≈ 120 分钟；本地剧集同理，单独一行便于运营区分功能成本。
AI_DAILY_QUOTA_TRANSLATE_BATCHES = _int_env("AI_DAILY_QUOTA_TRANSLATE_BATCHES", 60)
AI_DAILY_QUOTA_SUMMARY = _int_env("AI_DAILY_QUOTA_SUMMARY", 10)
AI_DAILY_QUOTA_DEFINE = _int_env("AI_DAILY_QUOTA_DEFINE", 200)
AI_DAILY_QUOTA_LOCAL_SHOW_BATCHES = _int_env("AI_DAILY_QUOTA_LOCAL_SHOW_BATCHES", 60)

# 第二、三层预算（美元/日；0 = 不启用该层硬闸）。默认值是保守占位，运营按
# 实际成本目标调；检查依据是 ai_usage 当日 SUM，不是前端估价。
AI_DAILY_BUDGET_USER_USD = _float_env("AI_DAILY_BUDGET_USER_USD", 1.0)
AI_DAILY_BUDGET_GLOBAL_USD = _float_env("AI_DAILY_BUDGET_GLOBAL_USD", 20.0)

# 降级链地域口径：auto（默认，按 DEFAULT_MODEL 判断）/ cn（排除 Google）/ global。
# 大陆默认模型是 deepseek-chat → auto 即 cn，Gemini 不会进入默认降级链。
AI_MODEL_REGION = os.environ.get("AI_MODEL_REGION", "auto").strip().lower() or "auto"
if AI_MODEL_REGION not in ("auto", "cn", "global"):
    print(f"⚠️  AI_MODEL_REGION={AI_MODEL_REGION!r} 无效，使用 auto。")
    AI_MODEL_REGION = "auto"


# --- 安全最小集（M1 ⑦，见 backend/ratelimit.py / llm.py / routes_videos.py）---
#
# 限速（进程内固定窗口，单进程实现；多 worker 部署时每个进程独立计数）：
# 每分钟请求数，0 = 关闭该桶。桶口径见 ratelimit.bucket_for()：
#   auth          /api/auth/signup、/api/auth/login，按 IP
#   estimate      /api/estimate-cost，按登录用户
#   process_video /api/process-video、/api/process-video-stream，按登录用户
#   define        /api/define，按登录用户
RATE_LIMIT_AUTH_PER_MINUTE = _int_env("RATE_LIMIT_AUTH_PER_MINUTE", 10)
RATE_LIMIT_ESTIMATE_COST_PER_MINUTE = _int_env("RATE_LIMIT_ESTIMATE_COST_PER_MINUTE", 20)
RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE = _int_env("RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE", 6)
RATE_LIMIT_DEFINE_PER_MINUTE = _int_env("RATE_LIMIT_DEFINE_PER_MINUTE", 60)

# 游客态（M1 ⑧）：同样的桶，游客用更紧的上限（按 ln_guest 的 sha256 计数）。
# 0 = 关闭该桶。总试译上限 GUEST_MAX_TRANSLATED_VIDEOS 是**累计**口径（不是每分钟）：
# 游客目录里已有 N 个视频/剧集缓存后，新的翻译请求返回 403 并提示登录；
# 已缓存内容的再次观看/补译不受影响。
RATE_LIMIT_GUEST_ESTIMATE_COST_PER_MINUTE = _int_env(
    "RATE_LIMIT_GUEST_ESTIMATE_COST_PER_MINUTE", 10
)
RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE = _int_env(
    "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 2
)
RATE_LIMIT_GUEST_DEFINE_PER_MINUTE = _int_env("RATE_LIMIT_GUEST_DEFINE_PER_MINUTE", 20)
GUEST_MAX_TRANSLATED_VIDEOS = _int_env("GUEST_MAX_TRANSLATED_VIDEOS", 1)

# 全局 LLM 并发闸：同一时刻最多允许多少个 provider 调用（0 = 不限）。
# 包住 llm.generate_json/generate_text 的异步入口；避免一次涌进过多长请求把
# 线程池/厂商限流打爆。
LLM_MAX_CONCURRENCY = _int_env("LLM_MAX_CONCURRENCY", 4)

# 估价→确认处理之间的预取缓存（metadata + transcript）容量与 TTL：
# 超容量淘汰最久未用（LRU）；0 = 关闭该缓存（不占内存，确认时重新抓取）。
PREFETCH_CACHE_MAX_ENTRIES = _int_env("PREFETCH_CACHE_MAX_ENTRIES", 200)
PREFETCH_CACHE_TTL_SECONDS = _int_env("PREFETCH_CACHE_TTL_SECONDS", 600)

# --- 登录失败锁定（M1 ⑦ 残余项，见 backend/auth_lockout.py）---
# 同一账号或同一 IP「连续」失败达到阈值 → 锁定 N 分钟；锁定期间即使密码
# 正确也返回 429 + Retry-After（与全局限速同一契约）。阈值/分钟任一为 0
# 表示关闭该机制。计数只放进程内存，进程重启即清空（多 worker 各算各的）。
AUTH_LOCK_THRESHOLD = _int_env("AUTH_LOCK_THRESHOLD", 5)
AUTH_LOCK_MINUTES = _int_env("AUTH_LOCK_MINUTES", 15)

# --- 抓取边界（M1 ⑦ 残余项，见 backend/transcripts.py / routes_videos.py）---
# YouTube 字幕与 yt-dlp 的网络超时（秒）。0 = 不设超时（不建议）。
# 实现口径：requests 的 connect/read timeout + yt-dlp 的 socket_timeout，
# 不是严格的「整个请求总时限」。
FETCH_TIMEOUT_SECONDS = _float_env("FETCH_TIMEOUT_SECONDS", 15.0)
# 单条字幕最多块数；超出返回 400（0 = 不限）。
MAX_TRANSCRIPT_BLOCKS = _int_env("MAX_TRANSCRIPT_BLOCKS", 5000)
# 字幕响应体 / 无字幕视频音频下载的单次上限（字节）；超出返回 400 / 跳过下载。
MAX_FETCH_BYTES = _int_env("MAX_FETCH_BYTES", 5 * 1024 * 1024)
# 频道视频列表「单频道」最多返回条数（硬上限）；当前 yt-dlp 仍只取最近 5 条。
MAX_CHANNEL_VIDEOS = _int_env("MAX_CHANNEL_VIDEOS", 200)
