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

# 能力定位测题库（M4，见 placement.py / specs/016）：vocab.json / reading.json /
# pseudo.json 只读静态文件，随仓库分发；测试可指向 tmp 副本验证题库校验。
PLACEMENT_DIR = os.environ.get(
    "PLACEMENT_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "placement"),
)

# 定位测题库版本（M2）：v1 = 仓库原有 39 题（默认，旧流程不变）；v2 =
# content/placement/forms/form-{a,b}/ 两套 64 题（锚题等值 + rasch.eap.v2）。
# 只影响**新开始**的会话；会话 id 前缀记录版本，升级前开始的旧会话仍按 v1
# 提交。可选值：v1 / legacy / 1 / v2 / forms / 2（大小写不敏感）。
PLACEMENT_BANK_VERSION = os.environ.get("PLACEMENT_BANK_VERSION", "v1")

# 能力档案内容（M1 CEFR 标定，见 ability.py / specs/025）：can_do.json 与
# self_assess.json 只读静态文件，随仓库分发；测试可指向 tmp 副本验证校验/503。
ABILITY_DIR = os.environ.get(
    "ABILITY_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "ability"),
)

# 考试练习题库（V2，见 exam.py / specs/022）：content/exam/cet4.json 只读静态
# 文件，随仓库分发；测试可指向 tmp 副本验证题库校验/503。
EXAM_DIR = os.environ.get(
    "EXAM_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "exam"),
)

# 课程 MVP 课程包（specs/029，见 course.py / routes_course.py）：
# content/course/*.json 只读静态文件，随仓库分发；一课一个 JSON。
# 测试可指向 tmp 副本验证 schema 校验/503，不碰仓库内容。
COURSE_DIR = os.environ.get(
    "COURSE_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "course"),
)

# 人工精选推荐池（V1 规则推荐，见 recommend.py / specs/018）：只读静态文件，
# 随仓库分发；测试可指向 tmp 副本验证内容闸门与回退。
CURATED_CONTENT_PATH = os.environ.get(
    "CURATED_CONTENT_PATH",
    os.path.join(_BACKEND_DIR, "..", "content", "curated.json"),
)

# 官方博客（V1，见 routes_blog.py / specs/020）：content/blog/*.md 直接随仓库
# 分发，无数据库/后台 CMS；测试可指向 tmp 目录验证 front matter/渲染/404。
BLOG_DIR = os.environ.get(
    "BLOG_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "blog"),
)

# 本地免费资源库（见 routes_library.py）：content/library/ 下的视频字幕与原创文章
# 只读静态文件，随仓库分发；无数据库、无 LLM。测试可指向 tmp 副本验证 404/503。
LIBRARY_DIR = os.environ.get(
    "LIBRARY_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "library"),
)

# 公版书系列阅读库（见 books.py / routes_books.py）：只读 books.json 与本地
# 中译文 JSON；英文原文每次请求从公版源抓取，**不落库、不落盘**。测试可指向
# tmp 副本验证 404/503/对齐。
BOOKS_DIR = os.environ.get(
    "BOOKS_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "books"),
)
# 自建英语频表（M2 内容难度，见 difficulty.py / scripts/build_wordlist.py）：
# content/wordlist/frequency_bands.v1.json 随仓库分发，许可 CC BY-SA 4.0；
# 运行期只读这一份词→频带映射，不读 CEFR-J/Octanove 等仅研究用途词表。
WORDLIST_PATH = os.environ.get(
    "WORDLIST_PATH",
    os.path.join(_BACKEND_DIR, "..", "content", "wordlist", "frequency_bands.v1.json"),
)

# 单词本词表（V1，见 vocabulary.py / routes_vocabulary.py / scripts/build_word_lists.py）：
# content/wordlists/ 下的 exam-bands.v1.json（GRE/CET4/CET6，ECDICT tag）
# 与 lexicon.v1.json（词→音标/首行中文释义）随仓库分发；CEFR A1–C1 仍从上面
# 的 WORDLIST_PATH 派生，不复制第二份。测试可指向 tmp 副本验证 503/404。
VOCABULARY_DIR = os.environ.get(
    "VOCABULARY_DIR",
    os.path.join(_BACKEND_DIR, "..", "content", "wordlists"),
)

# curated 视频的英文字幕构建期缓存（见 scripts/backfill_content_difficulty.py）：
# data/ 已 gitignore，不入库；只存字幕正文供离线难度计算，运行期不联网。
CURATED_SUBTITLES_DIR = os.environ.get(
    "CURATED_SUBTITLES_DIR",
    os.path.join(_BACKEND_DIR, "..", "data", "curated-subtitles"),
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

# --- 后台管理员（M1 ⑥ 止血台，见 routes_admin.py / specs/021-admin） ---
# ADMIN_EMAILS：逗号分隔的管理员邮箱，大小写不敏感；默认空 = 没有管理员。
# 只做「是否管理员」的布尔判断，不做独立 role 表/2FA/审计日志（计划书
# M1 ⑦ 残余项，已登记运行手册）。**不新增迁移**：身份完全由环境变量决定。
def _email_set_env(name: str) -> frozenset[str]:
    """读逗号分隔的邮箱集合；去空白、统一小写，非法空项忽略。"""
    raw = os.environ.get(name, "")
    return frozenset(
        item.strip().lower() for item in raw.split(",") if item.strip()
    )


ADMIN_EMAILS = _email_set_env("ADMIN_EMAILS")


def is_admin_email(email: str | None) -> bool:
    """邮箱是否在管理员名单里（大小写不敏感；空名单 → 永远 False）。"""
    if not email or not ADMIN_EMAILS:
        return False
    return email.strip().lower() in ADMIN_EMAILS

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
    # 前端难度轴现在直接展示 CEFR A1–C2；内部 id 保持旧值只为兼容已保存的设置。
    "liftoff": "CEFR A1 (~1,500-2,500 words). Highlight everything beyond the most basic everyday words.",
    "orbit": "CEFR A2 (~3,000-4,000 words). Highlight words beyond common everyday expressions.",
    "moonwalk": "CEFR B1 (~5,000-6,000 words). Highlight lower-frequency words, phrasal verbs and common idioms.",
    "interstellar": "CEFR B2 (~8,000-10,000 words). Highlight genuinely advanced or idiomatic usage.",
    "deep-space": "CEFR C1 (~12,000-15,000 words). Highlight only rare words, subtle idioms and cultural references.",
    "supernova": "CEFR C2 (~20,000+ words, near-native). Only the rarest idioms, slang or specialist jargon.",
    # Legacy ids from earlier releases
    "cet4": "CEFR B1 (~4,500-5,000 words). Highlight words above this level.",
    "cet6": "CEFR B2 (~6,000-8,000 words). Highlight words above this level.",
    "kaoyan": "CEFR B2+ (~8,000-10,000 words). Highlight low-frequency words, idioms and phrasal verbs.",
    "ielts": "CEFR C1 (~12,000 words). Only highlight genuinely advanced or idiomatic usage.",
    "advanced": "CEFR C2 (near-native). Only highlight rare idioms, slang, or cultural references.",
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
# M3 理解题：每用户每日「生成一个 lesson 的题目」次数（缓存命中不占额度）。
AI_DAILY_QUOTA_QUIZ = _int_env("AI_DAILY_QUOTA_QUIZ", 30)
# V1 读文章：每用户每日翻译批次数（1 批 = 默认 10 段；已有译文/失败重试只算缺失段）。
AI_DAILY_QUOTA_READING_BATCHES = _int_env("AI_DAILY_QUOTA_READING_BATCHES", 60)
# AI 教学分析（高亮/习语/文化点，specs/028）：每用户每日「生成一份内容分析」
# 次数。缓存命中（同 content_hash + level + target_lang）不占额度、零模型调用。
AI_DAILY_QUOTA_ANALYSIS = _int_env("AI_DAILY_QUOTA_ANALYSIS", 30)

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
#   discover      /api/discover，按登录用户
#   admin         /api/admin/*，按登录用户（后台止血台，30 次/分钟）
# 公版书源站抓取：响应体上限、超时与进程内缓存 TTL（秒）。正常请求**每次都
# 抓取**；缓存只在源站故障时用于降级，**绝不落盘**；见 books.py。
MAX_BOOK_SOURCE_BYTES = _int_env("MAX_BOOK_SOURCE_BYTES", 2 * 1024 * 1024)
BOOKS_SOURCE_TIMEOUT_SECONDS = _int_env("BOOKS_SOURCE_TIMEOUT_SECONDS", 20)
BOOKS_SOURCE_CACHE_SECONDS = _int_env("BOOKS_SOURCE_CACHE_SECONDS", 300)
# 用户导入公版书（Gutenberg / Standard Ebooks）：整书纯文本上限、单章上限；
# 原文每次实时抓取、不落库（见 book_import.py）。导入本身按用户 10 次/天。
MAX_IMPORT_BOOK_BYTES = _int_env("MAX_IMPORT_BOOK_BYTES", 8 * 1024 * 1024)
MAX_IMPORT_CHAPTER_BYTES = _int_env("MAX_IMPORT_CHAPTER_BYTES", 200 * 1024)
RATE_LIMIT_BOOK_IMPORT_PER_DAY = _int_env("RATE_LIMIT_BOOK_IMPORT_PER_DAY", 10)
# 内置公版书库按需翻译（见 book_translation.py）：公开/游客可用，但每 IP
# 每天最多翻 N 章（0 = 关闭）。命中全局缓存不占名额；一章的大小与总时长
# 另有硬上限，防止一次请求把模型账单/HTTP 连接拖爆。
RATE_LIMIT_BOOK_TRANSLATE_PER_DAY = _int_env(
    "RATE_LIMIT_BOOK_TRANSLATE_PER_DAY", 20
)
MAX_BOOK_TRANSLATE_CHARS = _int_env("MAX_BOOK_TRANSLATE_CHARS", 120_000)
MAX_BOOK_TRANSLATE_PARAGRAPHS = _int_env(
    "MAX_BOOK_TRANSLATE_PARAGRAPHS", 300
)
# 浮点秒（测试可设 0.05）；超时前已成功的批次会落库，重试只补缺失段。
BOOK_TRANSLATE_TIMEOUT_SECONDS = _float_env("BOOK_TRANSLATE_TIMEOUT_SECONDS", 180.0)

RATE_LIMIT_AUTH_PER_MINUTE = _int_env("RATE_LIMIT_AUTH_PER_MINUTE", 10)
RATE_LIMIT_ESTIMATE_COST_PER_MINUTE = _int_env("RATE_LIMIT_ESTIMATE_COST_PER_MINUTE", 20)
RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE = _int_env("RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE", 6)
RATE_LIMIT_DEFINE_PER_MINUTE = _int_env("RATE_LIMIT_DEFINE_PER_MINUTE", 60)
# 后台止血台（M1 ⑥）：只读聚合也要限速，避免一次刷新/脚本循环把 SQLite 打满。
RATE_LIMIT_ADMIN_PER_MINUTE = _int_env("RATE_LIMIT_ADMIN_PER_MINUTE", 30)
# 内容发现（V1）：一次请求会做 2–3 次网络搜索 + 字幕探测 + 2 次 LLM，
# 按用户限 5 次/分钟，挡住误刷模型额度与 YouTube 反爬。
RATE_LIMIT_DISCOVER_PER_MINUTE = _int_env("RATE_LIMIT_DISCOVER_PER_MINUTE", 5)
# 读文章（V1）：导入会真实抓取任意用户 URL（受 SSRF 校验与 2MB 上限约束），
# 按用户限 10 次/分钟；翻译另受 AI 日配额，不在这里按分钟卡。
RATE_LIMIT_READING_PER_MINUTE = _int_env("RATE_LIMIT_READING_PER_MINUTE", 10)
# 公版书（公开只读）：每章都要真实抓取公版源，按 IP 限 30 次/分钟，避免把
# 源站当成免费 CDN。列表/详情不触发抓取，但同桶计数（实现简单、口径保守）。
RATE_LIMIT_BOOKS_PER_MINUTE = _int_env("RATE_LIMIT_BOOKS_PER_MINUTE", 30)
# 学习事件上报（M5 watch + M2 #7 行为埋点）：前端批量/节流上报，一次请求
# 最多 50 条；120 次/分钟足够正常播放节奏，同时挡住脚本刷事件表。
RATE_LIMIT_EVENTS_PER_MINUTE = _int_env("RATE_LIMIT_EVENTS_PER_MINUTE", 120)

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
# 游客事件上报用更紧的桶（按 ln_guest sha256 计数）。
RATE_LIMIT_GUEST_EVENTS_PER_MINUTE = _int_env(
    "RATE_LIMIT_GUEST_EVENTS_PER_MINUTE", 60
)
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


# --- 读文章（V1 用户需求 #3，见 reading.py / routes_reading.py / specs/019）---
# URL 抓取：10 秒超时、最多 2MB、重定向 ≤3；只允许 http/https，解析 IP 后
# 拒绝私网/回环/链路本地/云元数据地址（SSRF 防护，详见 reading.py 文件头）。
READING_FETCH_TIMEOUT_SECONDS = _float_env("READING_FETCH_TIMEOUT_SECONDS", 10.0)
READING_MAX_FETCH_BYTES = _int_env("READING_MAX_FETCH_BYTES", 2 * 1024 * 1024)
READING_MAX_REDIRECTS = _int_env("READING_MAX_REDIRECTS", 3)
# 正文上限：最多 200 段、单段 4000 字符；粘贴正文整体上限 2MB 字符。
READING_MAX_PARAGRAPHS = _int_env("READING_MAX_PARAGRAPHS", 200)
READING_MAX_PARAGRAPH_CHARS = _int_env("READING_MAX_PARAGRAPH_CHARS", 4000)
READING_MAX_TEXT_CHARS = _int_env("READING_MAX_TEXT_CHARS", 2_000_000)
# 每批送模型翻译的段数；1 段 ≈ 1 个输入项，批次太大容易超时/掉段。
READING_TRANSLATE_BATCH_SIZE = _int_env("READING_TRANSLATE_BATCH_SIZE", 10)


# --- 内容发现（V1 主题搜索，见 discover.py / routes_discover.py / specs/017）---
# 探索阶段只读 YouTube 公开元数据与字幕轨道列表：不下载视频/字幕正文，结果落
# discover_queries 表做 24h 缓存与审计（不存字幕正文）。
DISCOVER_RESULTS_PER_QUERY = _int_env("DISCOVER_RESULTS_PER_QUERY", 8)
DISCOVER_MAX_QUERIES = _int_env("DISCOVER_MAX_QUERIES", 3)
DISCOVER_POOL_LIMIT = _int_env("DISCOVER_POOL_LIMIT", 10)
DISCOVER_SEARCH_CONCURRENCY = _int_env("DISCOVER_SEARCH_CONCURRENCY", 3)
DISCOVER_CAPTION_CONCURRENCY = _int_env("DISCOVER_CAPTION_CONCURRENCY", 4)
DISCOVER_MIN_DURATION_SECONDS = _int_env("DISCOVER_MIN_DURATION_SECONDS", 90)
DISCOVER_MAX_DURATION_SECONDS = _int_env("DISCOVER_MAX_DURATION_SECONDS", 5400)
DISCOVER_CACHE_HOURS = _int_env("DISCOVER_CACHE_HOURS", 24)
# 单次请求总预算（秒）；LLM 意图 6s、搜索 8s、字幕 2s/个、重排 8s 都在此预算内。
DISCOVER_TOTAL_SECONDS = _float_env("DISCOVER_TOTAL_SECONDS", 20.0)
DISCOVER_INTENT_TIMEOUT_SECONDS = _float_env("DISCOVER_INTENT_TIMEOUT_SECONDS", 6.0)
DISCOVER_SEARCH_TIMEOUT_SECONDS = _float_env("DISCOVER_SEARCH_TIMEOUT_SECONDS", 8.0)
DISCOVER_CAPTION_TIMEOUT_SECONDS = _float_env("DISCOVER_CAPTION_TIMEOUT_SECONDS", 2.0)
DISCOVER_RERANK_TIMEOUT_SECONDS = _float_env("DISCOVER_RERANK_TIMEOUT_SECONDS", 8.0)
