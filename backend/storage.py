"""当前请求的数据根目录：按登录用户隔离，未登录时回落到旧目录。

会话中间件（见 main.py）在每个请求里把当前用户 id 写进 ContextVar
`current_user_id`。所有「写用户数据」的模块都必须通过本模块取路径，
不要再直接引用 `config.HISTORY_DIR`：

- 有登录用户：`<USER_DATA_DIR>/<user_id>/history/...`（默认 data/users/<id>/）
- 无登录用户：回落到 `config.HISTORY_DIR`（保持旧数据 / 测试 / 脚本兼容）

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
import languages

# 当前请求的登录用户 id；中间件在每个请求开始时 set，请求结束时 reset。
# FastAPI 的同步端点在线程池里执行，anyio 会复制当前 context，所以这里设的
# 值在同步端点里同样可见。
current_user_id: ContextVar[str | None] = ContextVar("ln_current_user_id", default=None)


def active_user_id() -> str | None:
    """当前请求的登录用户 id；未登录返回 None。"""
    return current_user_id.get()


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
    """当前用户的 history 根目录（zh-CN 兼容位）。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(os.path.join(user_data_dir(user_id), "history"))
    return _ensure_dir(config.HISTORY_DIR)


def _user_root() -> str:
    """当前用户的数据根；未登录回落到旧 HISTORY_DIR。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(user_data_dir(user_id))
    return _ensure_dir(config.HISTORY_DIR)


def history_dir(target_lang: str | None = None) -> str:
    """视频/本地剧集缓存目录（按用户 + 目标语言隔离）。

    ``zh-CN``（缺省）返回旧根目录；其他语言返回 ``<root>/<code>/`` 并建目录。
    """
    return _language_dir(_history_root(), target_lang)


def favorites_file() -> str:
    """收藏 JSON 文件路径（按用户隔离；不按语言分文件）。"""
    return os.path.join(_user_root(), "favorites.json")


def subscriptions_file() -> str:
    """频道订阅 JSON 文件路径（按用户隔离；不按语言分文件）。"""
    return os.path.join(_user_root(), "subscriptions.json")


def dictionary_cache_file(target_lang: str | None = None) -> str:
    """词典释义缓存路径（按用户 + 目标语言隔离，位于该语言 history 下）。"""
    return os.path.join(history_dir(target_lang), "dictionary_cache.json")
