"""目标语言注册表：校验、规范化（NFC）、prompt 语言名与展示名。

规格见 ``specs/012-i18n-multilingual/spec.md`` §5.1 / §5.3 / §5.6 / §5.9。

设计约定：

- **纯函数、无 IO**：这里只做语言代码与名称的字典，不读写目录/数据库；
  路径由 ``storage.py`` 派生，prompt 由 ``translate.py`` / ``routes_user.py``
  取这里的名称。任何调用点都**不得**再硬编码 "Chinese" 或把用户输入直接
  当目录名。
- **缺省 = zh-CN**：所有请求参数都是可选的；省略时按中文处理，旧客户端
  行为零变化。
- **非法 = ``UnsupportedLanguage``**：路由层转成 HTTP 400；注册表之外的
  代码**永远不要**静默接受未知代码去拼路径（防路径穿越）。
- **NFC**：越南语有预组合/组合字符两种写法，``normalize()`` 统一成 NFC 后
  再做子串比较（高亮校验、缓存键都依赖它）。
"""
from __future__ import annotations

import unicodedata

# 默认目标语言；也是 ``history/`` 根目录的兼容语言（见 storage.py）。
DEFAULT_TARGET_LANG = "zh-CN"

# 学习/源语言目前固定英语（规格 §5.7「学习语言固定英语」）。
SOURCE_LANG = "en"

# 注册表：新增语言只在这里加一项 + 在 config.TARGET_LANG_MODEL_ROUTES 加路线。
# 字段说明：
#   prompt_name     prompt 里用的英文语言名（"Simplified Chinese"）
#   english_name    英文名（日志/展示兜底）
#   native_name     语言自称（语言选择器用）
#   display_names   在某种 UI 语言下怎么称呼它（键 = UI 语言）
#   local_dictionary 是否允许查本地 ECDICT（只有中文静态词典）
LANGUAGES: dict[str, dict] = {
    "zh-CN": {
        "code": "zh-CN",
        "english_name": "Simplified Chinese",
        "prompt_name": "Simplified Chinese",
        "native_name": "中文（简体）",
        "display_names": {
            "zh-CN": "中文（简体）",
            "vi-VN": "Tiếng Trung (Giản thể)",
        },
        "local_dictionary": True,
    },
    "vi-VN": {
        "code": "vi-VN",
        "english_name": "Vietnamese",
        "prompt_name": "Vietnamese",
        "native_name": "Tiếng Việt",
        "display_names": {
            "zh-CN": "越南语",
            "vi-VN": "Tiếng Việt",
        },
        "local_dictionary": False,
    },
}

# 宽松别名：接受 zh / zh-cn / vi / vi-vn 等写法（大小写、下划线不敏感）。
_ALIASES = {
    "zh": "zh-CN",
    "zh-cn": "zh-CN",
    "zh_cn": "zh-CN",
    "zh-hans": "zh-CN",
    "vi": "vi-VN",
    "vi-vn": "vi-VN",
    "vi_vn": "vi-VN",
}


class UnsupportedLanguage(ValueError):
    """不在注册表里的目标语言代码（HTTP 语义 400）。"""

    code = "unsupported_language"

    def __init__(self, value) -> None:
        self.value = value
        super().__init__(f"不支持的语言代码：{value}")


def normalize(text: str) -> str:
    """NFC 归一化（越南语组合字符与预组合字符视为同一串）。"""
    return unicodedata.normalize("NFC", text if isinstance(text, str) else str(text))


def normalize_code(raw: str | None) -> str | None:
    """把请求里的语言代码规范成注册表里的 canonical code。

    - ``None`` / 空串：返回 ``None``（调用方自行决定是否套默认值）；
    - 合法代码/别名：返回 ``zh-CN`` / ``vi-VN``；
    - 非法代码：返回 ``None``，**不抛异常**（供读取旧缓存这类「宽容」场景）；
      请求参数校验请用 :func:`resolve_target_lang`（非法抛异常）。
    """
    if raw is None:
        return None
    value = normalize(str(raw)).strip()
    if not value:
        return None
    if value in LANGUAGES:
        return value
    return _ALIASES.get(value.lower().replace("_", "-")) or _ALIASES.get(value.lower())


def is_supported(raw: str | None) -> bool:
    """是否是受支持的目标语言（缺省/空串不算）。"""
    return normalize_code(raw) is not None


def resolve_target_lang(raw: str | None) -> str:
    """请求参数 → canonical 语言代码；缺省为 ``zh-CN``，非法抛异常。"""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return DEFAULT_TARGET_LANG
    code = normalize_code(raw)
    if code is None:
        raise UnsupportedLanguage(raw)
    return code


def language_profile(raw: str | None) -> dict:
    """语言档案（prompt 名/展示名/本地词典开关）；非法代码抛异常。"""
    return LANGUAGES[resolve_target_lang(raw)]


def prompt_name(raw: str | None) -> str:
    """prompt 里用的英文语言名（替代硬编码 "Chinese"）。"""
    return language_profile(raw)["prompt_name"]


def language_display_name(raw: str | None, ui_lang: str | None = None) -> str:
    """目标语言的展示名；按 UI 语言本地化，未知语言原样返回代码。"""
    code = normalize_code(raw)
    if code is None:
        return str(raw or "")
    profile = LANGUAGES[code]
    ui = normalize_code(ui_lang) or DEFAULT_TARGET_LANG
    return (
        profile["display_names"].get(ui)
        or profile["native_name"]
        or profile["english_name"]
    )


def uses_local_dictionary(raw: str | None) -> bool:
    """是否允许查本地 ECDICT：只有 zh-CN 为 True（越南语 LLM-only）。"""
    return bool(language_profile(raw)["local_dictionary"])


def supported_target_langs() -> list[str]:
    """受支持的目标语言代码（默认语言排第一）。"""
    return [DEFAULT_TARGET_LANG] + [
        code for code in LANGUAGES if code != DEFAULT_TARGET_LANG
    ]


def supported_languages() -> list[dict]:
    """``GET /api/languages`` 形状的只读清单（不含 Key/价格）。"""
    return [
        {
            "code": code,
            "nativeName": profile["native_name"],
            "englishName": profile["english_name"],
            "displayNames": dict(profile["display_names"]),
            "localDictionary": profile["local_dictionary"],
        }
        for code, profile in LANGUAGES.items()
    ]
