"""游客态（M1 ⑧，计划书 §7.5 / §13.2）：隔离目录 + 随机 Cookie + 幂等认领。

设计约束（与「不新增迁移」对齐）：

- **不建表**：游客身份就是 `sha256(ln_guest)`，目录名即身份；
- `ln_guest` 是 32 字节随机 token（`secrets.token_urlsafe(32)`），httpOnly、
  SameSite=Lax、Path=/、30 天；服务端**只存 sha256**，原始 token 不落盘、
  不进日志、前端 JS 读不到（不可导出）；
- 游客数据根 = `data/guests/<sha256>/`，目录结构与该用户目录一致：
  `history/`（按目标语言分子目录）、`favorites.json`、`subscriptions.json`。
  不同游客的目录互不可见；路径只接受 64 位小写十六进制哈希，绝不把
  Cookie 原文直接拼进路径（防路径穿越）；
- **认领**：登录后把游客目录合并到用户目录，用户数据优先。去重口径：
  视频缓存同 `videoId`（跨语言分目录分别比对）、收藏同 `id` 或同内容指纹；
  订阅按稳定键（id/url/channel 等）去重。合并成功后删除游客目录并清 Cookie；
  重复调用幂等（游客目录已不存在 → 返回 claimed=false、计数全 0）；
- 游客是「匿名临时租户」：清理浏览器 Cookie / 无痕窗口会得到新的空游客，
  这是 Cookie 方案的已知边界；成本侧由更紧限速 + 每游客配额 + 全站日预算
  兜底（见 ratelimit.py / ai/quota.py）。
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import threading

import config
import languages

logger = logging.getLogger("linguatrek.guest")

COOKIE_NAME = "ln_guest"

# 32 字节熵 → token_urlsafe 43 个字符；Cookie 值必须严格匹配该形状。
TOKEN_BYTES = 32
MAX_AGE_SECONDS = int(config.SESSION_MAX_AGE)  # 30 天，与会话 Cookie 一致

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_GUEST_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# 游客根目录下这些文件不是「视频缓存」：认领时分别合并或忽略。
_HISTORY_META_FILES = {
    "dictionary_cache.json",
    "favorites.json",
    "subscriptions.json",
}
_GUEST_FAVORITES_FILE = "favorites.json"
_GUEST_SUBSCRIPTIONS_FILE = "subscriptions.json"

# 认领是「搬一次」的临界区：同一进程内串行化，避免两次点击同时搬同一目录。
_claim_lock = threading.Lock()


class GuestLimitError(Exception):
    """游客累计试译达到上限（路由层转 403，提示登录）。"""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(
            f"游客最多只能试译 {limit} 个视频，登录后可继续翻译并永久保存进度。"
        )


class GuestClaimError(RuntimeError):
    """认领过程中有文件操作失败；游客目录保留，允许重试（合并是幂等的）。"""


# ---------------------------------------------------------------------------
# token / 身份
# ---------------------------------------------------------------------------

def new_token() -> str:
    """生成新的游客 token（32 字节随机；只出现在 Set-Cookie 里）。"""
    return secrets.token_urlsafe(TOKEN_BYTES)


def is_valid_token(token: object) -> bool:
    """Cookie 值是否是服务端签发的形状（43 位 urlsafe）。

    只做形状校验：伪造/手写的合法形状 token 只会得到一个**新的空游客目录**，
    不可能读到别的游客或登录用户的数据。非法形状一律视为没有 Cookie，
    中间件会重新下发，避免把任意字符串当目录名。
    """
    return isinstance(token, str) and bool(_TOKEN_RE.fullmatch(token))


def hash_token(token: str) -> str:
    """游客 token → 落盘身份（sha256 十六进制串，库/文件里只存这个）。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def is_valid_guest_hash(value: object) -> bool:
    return isinstance(value, str) and bool(_GUEST_HASH_RE.fullmatch(value))


def guest_id(guest_hash: str) -> str:
    """请求上下文里的「身份」：用于配额/账本归属，不是数据库主键。

    `guest:` 前缀保证不会与登录用户的 uuid hex 冲突；账本/配额表把游客用量
    当作一个匿名租户记账，因此同样计入全站日预算（不能被匿名无限刷）。
    """
    return f"guest:{guest_hash}"


def parse_guest_id(identity: object) -> str | None:
    """`guest:<hash>` → hash；不是游客身份返回 None。"""
    if not isinstance(identity, str) or not identity.startswith("guest:"):
        return None
    value = identity[len("guest:"):]
    return value if is_valid_guest_hash(value) else None


# ---------------------------------------------------------------------------
# 目录（路径校验的唯一入口）
# ---------------------------------------------------------------------------

def guests_root() -> str:
    """游客根目录 `data/guests/`（可由 GUEST_DATA_DIR 覆盖；不存在则建）。"""
    root = getattr(config, "GUEST_DATA_DIR", None) or os.path.join(
        config.DATA_DIR, "guests"
    )
    os.makedirs(root, exist_ok=True)
    return root


def _contained(path: str) -> str:
    """确认路径确实落在游客根目录下（防符号链接/拼接穿越）。"""
    root = os.path.realpath(guests_root())
    real = os.path.realpath(path)
    if real != root and not real.startswith(root + os.sep):
        raise ValueError("非法游客目录路径。")
    return real


def guest_dir(guest_hash: str, *, create: bool = False) -> str:
    """某个游客的数据根目录；非法哈希抛 ValueError（绝不拼进路径）。"""
    if not is_valid_guest_hash(guest_hash):
        raise ValueError("非法游客标识。")
    path = os.path.join(guests_root(), guest_hash)
    if create:
        os.makedirs(path, exist_ok=True)
    return _contained(path)


def guest_history_dir(guest_hash: str, *, create: bool = False) -> str:
    return os.path.join(guest_dir(guest_hash, create=create), "history")


def guest_exists(guest_hash: str) -> bool:
    try:
        return os.path.isdir(guest_dir(guest_hash))
    except ValueError:
        return False


def guest_size(guest_hash: str) -> int:
    """游客目录占用的文件数（运维/测试用；不存在返回 0）。"""
    try:
        root = guest_dir(guest_hash)
    except ValueError:
        return 0
    if not os.path.isdir(root):
        return 0
    count = 0
    for _dirpath, _dirnames, filenames in os.walk(root):
        count += len(filenames)
    return count


# ---------------------------------------------------------------------------
# Cookie
# ---------------------------------------------------------------------------

def set_guest_cookie(response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=MAX_AGE_SECONDS,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_guest_cookie(response) -> None:
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
    )


# ---------------------------------------------------------------------------
# 游客累计试译上限
# ---------------------------------------------------------------------------

def _history_video_files(history_root: str):
    """遍历游客 history 下的视频缓存文件（根目录 + 受支持的语言子目录）。"""
    if not os.path.isdir(history_root):
        return
    for entry in os.scandir(history_root):
        if entry.is_file():
            if entry.name.endswith(".json") and entry.name not in _HISTORY_META_FILES:
                yield entry.path
            continue
        if not entry.is_dir():
            continue
        code = languages.normalize_code(entry.name)
        if code is None or code == languages.DEFAULT_TARGET_LANG:
            continue  # 未知目录不参与计数
        for sub in os.scandir(entry.path):
            if (
                sub.is_file()
                and sub.name.endswith(".json")
                and sub.name not in _HISTORY_META_FILES
            ):
                yield sub.path


def _has_video_id(path: str) -> bool:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(payload, dict) and isinstance(payload.get("videoId"), str)


def count_translated_videos(guest_hash: str) -> int:
    """游客已落盘的视频/剧集数（有 videoId 的缓存文件；本地剧集同样计入）。"""
    try:
        history_root = guest_history_dir(guest_hash)
    except ValueError:
        return 0
    return sum(1 for path in _history_video_files(history_root) if _has_video_id(path))


def ensure_can_translate(guest_hash: str | None) -> None:
    """游客累计试译上限检查；登录用户（None）永远放行。

    只拦**新的翻译**：路由在命中已有缓存后会先返回，不会走到这里，所以
    「已试译的那个视频」刷新/补译仍然可用。
    """
    if not guest_hash:
        return
    try:
        limit = int(getattr(config, "GUEST_MAX_TRANSLATED_VIDEOS", 1) or 0)
    except (TypeError, ValueError):
        limit = 1
    if limit <= 0:
        return
    if count_translated_videos(guest_hash) >= limit:
        raise GuestLimitError(limit)


# ---------------------------------------------------------------------------
# 认领：游客目录 → 用户目录
# ---------------------------------------------------------------------------

def _empty_result() -> dict:
    return {
        "claimed": False,
        "merged": {"history": 0, "favorites": 0, "subscriptions": 0},
        "skipped": {"history": 0, "favorites": 0, "subscriptions": 0},
        "guestFiles": 0,
    }


def _atomic_write_json(path: str, data) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    temp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def _iter_history_entries(history_root: str):
    """(绝对路径, 相对路径)；只接受根目录与受支持语言的一层子目录。"""
    if not os.path.isdir(history_root):
        return
    for entry in os.scandir(history_root):
        if entry.is_file():
            yield entry.path, entry.name
            continue
        if not entry.is_dir():
            continue
        code = languages.normalize_code(entry.name)
        if code is None or code == languages.DEFAULT_TARGET_LANG:
            continue
        for sub in os.scandir(entry.path):
            if sub.is_file():
                yield sub.path, os.path.join(entry.name, sub.name)


def _collect_destination_video_ids(user_history_root: str) -> set[str]:
    video_ids: set[str] = set()
    for path, _rel in _iter_history_entries(user_history_root):
        if os.path.basename(path) in _HISTORY_META_FILES:
            continue
        data = _read_json(path, None)
        if isinstance(data, dict) and isinstance(data.get("videoId"), str):
            video_ids.add(data["videoId"])
    return video_ids


def _merge_dictionary_cache(source: str, destination: str) -> int:
    """释义缓存按词条并集合并，用户已有词条优先（不覆盖用户缓存）。"""
    incoming = _read_json(source, {})
    if not isinstance(incoming, dict) or not incoming:
        return 0
    existing = _read_json(destination, {})
    if not isinstance(existing, dict):
        existing = {}
    added = 0
    for key, value in incoming.items():
        if key not in existing:
            existing[key] = value
            added += 1
    if added:
        _atomic_write_json(destination, existing)
    return added


def _merge_history(
    guest_root: str, user_root: str, merged: dict, skipped: dict, errors: list[str]
) -> None:
    source_root = os.path.join(guest_root, "history")
    if not os.path.isdir(source_root):
        return
    destination_root = os.path.join(user_root, "history")
    os.makedirs(destination_root, exist_ok=True)
    known_video_ids = _collect_destination_video_ids(destination_root)

    for source_path, rel in _iter_history_entries(source_root):
        name = os.path.basename(source_path)
        destination_path = os.path.join(destination_root, rel)
        if name in _HISTORY_META_FILES:
            # 释义缓存是「按词」的纯缓存：并集合并，用户已有值优先。
            if name == "dictionary_cache.json":
                try:
                    _merge_dictionary_cache(source_path, destination_path)
                except OSError as exc:  # 缓存合并不值得让整次认领失败
                    logger.warning("游客释义缓存合并失败：%s", exc)
            continue

        data = _read_json(source_path, None)
        video_id = data.get("videoId") if isinstance(data, dict) else None
        if not isinstance(video_id, str) or not video_id:
            skipped["history"] += 1
            continue
        if os.path.exists(destination_path):
            skipped["history"] += 1
            continue
        if video_id in known_video_ids:
            # 同一个视频在用户目录里已有译文：用户数据优先，不覆盖。
            skipped["history"] += 1
            continue
        temp_path = (
            f"{destination_path}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            os.makedirs(os.path.dirname(destination_path), exist_ok=True)
            # 先复制到临时文件再原子替换：中途失败不会留下半截缓存，
            # 重试时也不会被「目标已存在」误判成用户数据优先。
            shutil.copy2(source_path, temp_path)
            os.replace(temp_path, destination_path)
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.unlink(temp_path)
            errors.append(f"history/{rel}: {exc}")
            continue
        known_video_ids.add(video_id)
        merged["history"] += 1


def _merge_favorites(
    guest_root: str, user_root: str, merged: dict, skipped: dict
) -> None:
    source = os.path.join(guest_root, _GUEST_FAVORITES_FILE)
    if not os.path.isfile(source):
        return
    # 延迟导入：复用按条收藏 API 的同一套归一化/指纹/文件锁，避免两套去重口径。
    import routes_user

    destination = os.path.join(user_root, _GUEST_FAVORITES_FILE)
    incoming = routes_user._load_favorites_unlocked(source)
    if not isinstance(incoming, list) or not incoming:
        return
    with routes_user._favorites_file_lock(destination):
        existing = routes_user._with_missing_ids(
            routes_user._load_favorites_unlocked(destination)
        )
        existing_ids = {
            item.get("id")
            for item in existing
            if isinstance(item, dict) and item.get("id")
        }
        existing_fingerprints = set()
        for item in existing:
            if not routes_user._looks_like_favorite(item):
                continue
            try:
                existing_fingerprints.add(routes_user._favorite_fingerprint(item))
            except (TypeError, ValueError, KeyError):
                continue

        added = []
        for item in routes_user._with_missing_ids(incoming):
            if not routes_user._looks_like_favorite(item):
                skipped["favorites"] += 1
                continue
            item_id = item.get("id")
            if item_id and item_id in existing_ids:
                skipped["favorites"] += 1
                continue
            try:
                fingerprint = routes_user._favorite_fingerprint(item)
            except (TypeError, ValueError, KeyError):
                skipped["favorites"] += 1
                continue
            if fingerprint in existing_fingerprints:
                skipped["favorites"] += 1
                continue
            existing.append(item)
            if item_id:
                existing_ids.add(item_id)
            existing_fingerprints.add(fingerprint)
            added.append(item)
        if added:
            routes_user._write_favorites_unlocked(destination, existing)
    merged["favorites"] += len(added)


def _subscription_key(item) -> str:
    if isinstance(item, dict):
        for field in ("id", "channel_url", "url", "channelId", "channel"):
            value = item.get(field)
            if isinstance(value, str) and value.strip():
                return f"{field}:{value.strip()}"
    try:
        return "json:" + json.dumps(item, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return f"repr:{item!r}"


def _merge_subscriptions(
    guest_root: str, user_root: str, merged: dict, skipped: dict
) -> None:
    source = os.path.join(guest_root, _GUEST_SUBSCRIPTIONS_FILE)
    if not os.path.isfile(source):
        return
    incoming = _read_json(source, [])
    if not isinstance(incoming, list) or not incoming:
        return
    destination = os.path.join(user_root, _GUEST_SUBSCRIPTIONS_FILE)
    existing = _read_json(destination, [])
    if not isinstance(existing, list):
        existing = []
    seen = {_subscription_key(item) for item in existing}
    added = []
    for item in incoming:
        key = _subscription_key(item)
        if key in seen:
            skipped["subscriptions"] += 1
            continue
        existing.append(item)
        seen.add(key)
        added.append(item)
    if added:
        _atomic_write_json(destination, existing)
    merged["subscriptions"] += len(added)


def claim_guest_data(guest_hash: str, user_id: str) -> dict:
    """把游客数据合并到用户目录；幂等。返回计数，不碰 HTTP/Cookie。

    - 游客目录不存在（已认领 / 从未写入）→ claimed=False、计数全 0；
    - 用户数据优先：同 videoId 缓存、同 id/指纹收藏、同订阅键都跳过；
    - 所有文件操作成功后才删除游客目录；失败抛 GuestClaimError，目录保留，
      重试安全（合并本身按上述键去重）。
    """
    if not is_valid_guest_hash(guest_hash):
        raise ValueError("非法游客标识。")
    if not isinstance(user_id, str) or not _USER_ID_RE.fullmatch(user_id):
        raise ValueError("非法用户标识。")

    result = _empty_result()
    with _claim_lock:
        try:
            source_root = guest_dir(guest_hash)
        except ValueError as exc:  # pragma: no cover - 上面已校验
            raise GuestClaimError(str(exc)) from exc
        if not os.path.isdir(source_root):
            return result

        result["guestFiles"] = guest_size(guest_hash)
        # 延迟导入避免 storage ↔ guest 顶层循环（storage 需要 guest 计算目录）。
        import storage

        user_root = storage.user_data_dir(user_id)
        errors: list[str] = []
        try:
            os.makedirs(user_root, exist_ok=True)
            _merge_history(source_root, user_root, result["merged"], result["skipped"], errors)
            _merge_favorites(source_root, user_root, result["merged"], result["skipped"])
            _merge_subscriptions(
                source_root, user_root, result["merged"], result["skipped"]
            )
        except Exception as exc:  # noqa: BLE001 - 任何失败都保留游客目录以便重试
            errors.append(str(exc))

        if errors:
            logger.warning(
                "游客认领未完成（目录保留以便重试）：guest=%s user=%s errors=%s",
                guest_hash,
                user_id,
                errors[:3],
            )
            raise GuestClaimError("；".join(errors[:3]))

        # 合并成功：删除游客目录 + 清 Cookie 由路由负责；失败也回滚不了（已复制），
        # 但重试会按键去重，不会产生重复数据。
        try:
            if os.path.islink(source_root):
                os.unlink(source_root)
            else:
                shutil.rmtree(source_root)
        except OSError as exc:
            logger.warning("游客目录删除失败（认领计数已完成）：%s", exc)
            raise GuestClaimError(f"游客目录删除失败：{exc}") from exc

        result["claimed"] = True
        return result
