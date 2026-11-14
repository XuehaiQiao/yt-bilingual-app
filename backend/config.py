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
