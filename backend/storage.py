"""当前请求的数据根目录：按登录用户 / 游客隔离，未登录时回落到旧目录。

会话中间件（见 main.py）在每个请求里把当前身份写进 ContextVar：

- 登录用户：`current_user_id` → `<USER_DATA_DIR>/<user_id>/`
- 游客（无会话但有 `ln_guest`）：`current_guest_hash` → `<GUEST_DATA_DIR>/<sha256>/`
- 两者都没有（脚本/测试直接调用）：回落到 `config.HISTORY_DIR`（保持旧数据兼容）

游客目录布局与用户目录完全一致（`history/`、`favorites.json`、
`subscriptions.json`），所以认领时只需按键合并，不需要第二套路径规则。
所有「写用户数据」的模块都必须通过本模块取路径，不要再直接引用
`config.HISTORY_DIR`。

语言维度（specs/012 §5.4）：逻辑键 = `(target_lang, 资源文件名)`，落盘 =
`history/<target_lang>/<文件>`；**zh-CN 兼容映射到 history/ 根目录**，所以旧
数据/旧客户端/回滚后的旧代码都还能读到中文缓存。其他语言落在
`history/<code>/` 子目录，旧代码只扫根目录，天然不会把越南语当中文展示。

`dictionary_cache_file(target_lang)` 也按用户 + 语言隔离：释义缓存与视频缓存
使用同一套目录规则，避免一个用户的坏缓存影响另一个用户，也避免中越释义互相
命中；单词释义本身不敏感，代价只是同词在不同用户/语言间各生成一次（缓存很小，
可接受）。

目标语言参数一律经 `languages.resolve_target_lang()` 规范化；这里再拒绝一次
未知代码，**绝不把用户输入直接当目录名**（防路径穿越）。
"""
import os
from contextvars import ContextVar

import config
import guest
import languages

# 当前请求的登录用户 id；中间件在每个请求开始时 set，请求结束时 reset。
# FastAPI 的同步端点在线程池里执行，anyio 会复制当前 context，所以这里设的
# 值在同步端点里同样可见。
current_user_id: ContextVar[str | None] = ContextVar("ln_current_user_id", default=None)

# 当前请求的游客身份（sha256，不是 Cookie 原文）；登录用户与非 API 请求为 None。
current_guest_hash: ContextVar[str | None] = ContextVar(
    "ln_current_guest_hash", default=None
)


def active_user_id() -> str | None:
    """当前请求的登录用户 id；未登录/游客返回 None。"""
    return current_user_id.get()


def active_guest_hash() -> str | None:
    """当前请求的游客身份（sha256）；登录用户返回 None。"""
    return current_guest_hash.get()


def active_identity() -> str | None:
    """配额/账本归属：登录用户 id，否则游客 `guest:<sha256>`，都没有为 None。

    游客用量因此仍计入账本与全站日预算，不会被「匿名」绕过；它不是数据库
    主键，也不会出现在任何面向用户的字段里。
    """
    user_id = current_user_id.get()
    if user_id:
        return user_id
    guest_hash = current_guest_hash.get()
    if guest_hash:
        return guest.guest_id(guest_hash)
    return None


def _canonical_lang(target_lang: str | None) -> str:
    """目标语言 → canonical code；缺省 zh-CN，非法代码抛 ValueError。"""
    if target_lang is None or (isinstance(target_lang, str) and not target_lang.strip()):
        return languages.DEFAULT_TARGET_LANG
    code = languages.normalize_code(target_lang)
    if code is None:
        # 内部调用错误：宁可显式报错，也不要写到错误的语言目录。
        raise ValueError(f"不支持的目标语言：{target_lang!r}")
    return code


def _ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def _language_dir(root: str, target_lang: str | None) -> str:
    """语言目录 helper：zh-CN 用 root 本身，其他语言用 root/<code>/。"""
    lang = _canonical_lang(target_lang)
    if lang == languages.DEFAULT_TARGET_LANG:
        return _ensure_dir(root)
    return _ensure_dir(os.path.join(root, lang))


def user_data_dir(user_id: str) -> str:
    """某个用户的数据根目录（不含请求上下文，供测试/运维使用）。"""
    return os.path.join(config.USER_DATA_DIR, user_id)


def user_history_dir(user_id: str, target_lang: str | None = None) -> str:
    """某个用户的视频/剧集缓存目录（可按目标语言分子目录）。"""
    return _language_dir(os.path.join(user_data_dir(user_id), "history"), target_lang)


def _history_root() -> str:
    """当前身份（用户/游客）的 history 根目录（zh-CN 兼容位）。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(os.path.join(user_data_dir(user_id), "history"))
    guest_hash = current_guest_hash.get()
    if guest_hash:
        return _ensure_dir(guest.guest_history_dir(guest_hash, create=True))
    return _ensure_dir(config.HISTORY_DIR)


def _user_root() -> str:
    """当前身份（用户/游客）的数据根；都没有时回落到旧 HISTORY_DIR。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(user_data_dir(user_id))
    guest_hash = current_guest_hash.get()
    if guest_hash:
        return _ensure_dir(guest.guest_dir(guest_hash, create=True))
    return _ensure_dir(config.HISTORY_DIR)


def history_dir(target_lang: str | None = None) -> str:
    """视频/本地剧集缓存目录（按用户 + 目标语言隔离）。

    ``zh-CN``（缺省）返回旧根目录；其他语言返回 ``<root>/<code>/`` 并建目录。
    """
    return _language_dir(_history_root(), target_lang)


def favorites_file() -> str:
    """收藏 JSON 文件路径（按用户/游客隔离；不按语言分文件）。"""
    return os.path.join(_user_root(), "favorites.json")


def favorites_tombstones_file() -> str:
    """收藏删除墓碑（tombstone）文件路径（按用户/游客隔离）。

    M1 ④ 按条 API 的删除不再只靠「文件里没有这条」表达：删除时在旁路文件记
    ``{favorite_id: deleted_at_ms}``，供 ``GET /api/favorites?since=`` 做增量同
    步。文件格式是普通 JSON 对象，旧代码/回滚后的旧版本不会读它，互不影响。
    """
    return os.path.join(_user_root(), "favorites_tombstones.json")


def subscriptions_file() -> str:
    """频道订阅 JSON 文件路径（按用户/游客隔离；不按语言分文件）。"""
    return os.path.join(_user_root(), "subscriptions.json")


def dictionary_cache_file(target_lang: str | None = None) -> str:
    """词典释义缓存路径（按用户 + 目标语言隔离，位于该语言 history 下）。"""
    return os.path.join(history_dir(target_lang), "dictionary_cache.json")
