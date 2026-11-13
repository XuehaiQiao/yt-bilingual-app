"""当前请求的数据根目录：按登录用户隔离，未登录时回落到旧目录。

会话中间件（见 main.py）在每个请求里把当前用户 id 写进 ContextVar
`current_user_id`。所有「写用户数据」的模块都必须通过本模块取路径，
不要再直接引用 `config.HISTORY_DIR`：

- 有登录用户：`<USER_DATA_DIR>/<user_id>/history/...`（默认 data/users/<id>/）
- 无登录用户：回落到 `config.HISTORY_DIR`（保持旧数据 / 测试 / 脚本兼容）

`dictionary_cache_file()` 也按用户隔离（放在该用户的 history/ 下）：释义缓存
与视频缓存使用同一套目录规则，避免一个用户的坏缓存影响另一个用户；单词释义
本身不敏感，代价只是同词在不同用户间各生成一次（缓存很小，可接受）。
"""
import os
from contextvars import ContextVar

import config

# 当前请求的登录用户 id；中间件在每个请求开始时 set，请求结束时 reset。
# FastAPI 的同步端点在线程池里执行，anyio 会复制当前 context，所以这里设的
# 值在同步端点里同样可见。
current_user_id: ContextVar[str | None] = ContextVar("ln_current_user_id", default=None)


def active_user_id() -> str | None:
    """当前请求的登录用户 id；未登录返回 None。"""
    return current_user_id.get()


def user_data_dir(user_id: str) -> str:
    """某个用户的数据根目录（不含请求上下文，供测试/运维使用）。"""
    return os.path.join(config.USER_DATA_DIR, user_id)


def user_history_dir(user_id: str) -> str:
    """某个用户的视频/剧集缓存目录。"""
    return os.path.join(user_data_dir(user_id), "history")


def _ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def _user_root() -> str:
    """当前用户的数据根；未登录回落到旧 HISTORY_DIR。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(user_data_dir(user_id))
    return _ensure_dir(config.HISTORY_DIR)


def history_dir() -> str:
    """视频/本地剧集缓存目录（按用户隔离，未登录回落 HISTORY_DIR）。"""
    user_id = current_user_id.get()
    if user_id:
        return _ensure_dir(user_history_dir(user_id))
    return _ensure_dir(config.HISTORY_DIR)


def favorites_file() -> str:
    """收藏 JSON 文件路径（按用户隔离）。"""
    return os.path.join(_user_root(), "favorites.json")


def subscriptions_file() -> str:
    """频道订阅 JSON 文件路径（按用户隔离）。"""
    return os.path.join(_user_root(), "subscriptions.json")


def dictionary_cache_file() -> str:
    """词典释义缓存路径（按用户隔离，位于该用户的 history/ 下）。"""
    return os.path.join(history_dir(), "dictionary_cache.json")
