"""反馈/纠错服务层（v1.1 P0 / P2-39，specs/048）。

数据表是 migration ``0033_v1_1_launch`` 建好的 ``feedback``（API 是唯一写入方）。
表结构（0033 已合并，**本模块不加列、不改表**）：

``id / user_id / request_id / category / message / contact / status /
created_at_ms / resolved_at_ms / admin_note``

口径：

- ``user_id`` 可空：登录用户记 id，游客记 NULL。0033 故意不建外键——账号硬删除
  后历史反馈保留，删除流程也不会被悬空约束卡住；
- ``category`` 白名单是后端唯一真源（前端提交未知分类 → 400，而不是静默落库）；
- ``message``（别名 ``description``）去首尾空白后 **5–2000** 字符：与前端
  ``FEEDBACK_DESCRIPTION_MIN``/``MAX`` 同一口径（前端注释也写明「后端同样拒绝」），
  避免「前端拦住、其它客户端能提交 1 字废话」的两套底线；
- ``status`` 白名单（:data:`STATUSES`）：``open`` / ``in_progress`` / ``resolved`` /
  ``closed``；新建固定 ``open``；
- ``resolved_at_ms``：**从非终态进入终态**（resolved/closed）时写当前毫秒；退回
  open/in_progress 时清空；终态之间互转保留首次进入终态的时间（用于衡量处理时长）；
- ``request_id``：前端一次提交的稳定 id；请求体没给时由路由回落到中间件的
  request_id，本模块只做长度截断（128）。**不建唯一约束**、不做去重：重复提交
  保留两行，靠同一个 request_id 归组排查（与 0033 的索引口径一致）；
- 0033 表里**没有 page 列**：来源页属于诊断信息，路由用
  :func:`normalize_page` 校验/截断后写进结构化日志，不落库（要落库需另加迁移）；
- 表缺失（未跑迁移）→ :class:`FeedbackUnavailable`（路由 503）。反馈是**写路径**，
  静默丢弃用户的反馈比报错更糟，所以这里不 fail-open，也不在运行时建表。

所有写入走 ``auth_db.connect()``（与账号库同库、同连接约定），读列表用同一个
连接（只做只读查询，SQLite 上开销可忽略）。
"""
from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any

import auth_db

logger = logging.getLogger("linguatrek.feedback")

#: 可提交的反馈分类（与前端 ``FEEDBACK_CATEGORIES`` 一致）。翻译/分析纠错归
#: ``content``，不单列分类：新增分类必须同时改这里与前端枚举，否则 400。
CATEGORIES: tuple[str, ...] = ("bug", "feature", "content", "other")

#: 处理状态白名单（顺序即管理台建议的流转顺序）。
STATUSES: tuple[str, ...] = ("open", "in_progress", "resolved", "closed")

#: 新建反馈的状态（0033 的 server_default 也是 open）。
DEFAULT_STATUS = "open"

#: 终态：进入时写 ``resolved_at_ms``，离开时清空。
TERMINAL_STATUSES: tuple[str, ...] = ("resolved", "closed")

MESSAGE_MIN = 5
MESSAGE_MAX = 2000
CONTACT_MAX = 200
PAGE_MAX = 300
REQUEST_ID_MAX = 128
ADMIN_NOTE_MAX = 2000

#: 管理台列表默认/最大条数。
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200

#: 缺表时的统一提示（与其它迁移缺失报错同风格）。
_MISSING_TABLE_HINT = "（先运行 `cd backend && venv/bin/python -m alembic upgrade head`）"


class FeedbackError(Exception):
    """反馈域的基类异常（路由按子类映射 HTTP 状态）。"""


class InvalidFeedback(FeedbackError):
    """请求内容不合法 → 400。"""


class FeedbackUnavailable(FeedbackError):
    """反馈表不可用（未迁移/写库失败）→ 503。"""


class FeedbackNotFound(FeedbackError):
    """指定的反馈 id 不存在 → 404。"""


def now_ms() -> int:
    """当前毫秒时间戳（模块级，便于测试替换）。"""
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# 校验 / 规范化
# ---------------------------------------------------------------------------

def validate_category(value: object) -> str:
    """分类必须在白名单里；大小写与首尾空白被规范化，未知分类 400。"""
    if not isinstance(value, str):
        raise InvalidFeedback(
            f"category 必须是字符串，可选：{'、'.join(CATEGORIES)}。"
        )
    name = value.strip().lower()
    if name not in CATEGORIES:
        raise InvalidFeedback(
            f"不支持的反馈分类：{value!r}（可选：{'、'.join(CATEGORIES)}）。"
        )
    return name


def validate_status(value: object) -> str:
    """状态必须在白名单里（管理端 PATCH 用）。"""
    if not isinstance(value, str):
        raise InvalidFeedback(
            f"status 必须是字符串，可选：{'、'.join(STATUSES)}。"
        )
    name = value.strip().lower()
    if name not in STATUSES:
        raise InvalidFeedback(
            f"不支持的处理状态：{value!r}（可选：{'、'.join(STATUSES)}）。"
        )
    return name


def validate_message(value: object) -> str:
    """描述正文：去首尾空白后 5–2000 字符；非字符串直接 400。"""
    if not isinstance(value, str):
        raise InvalidFeedback("feedback 描述必须是字符串（message / description）。")
    text = value.strip()
    if len(text) < MESSAGE_MIN:
        raise InvalidFeedback(
            f"反馈内容至少 {MESSAGE_MIN} 个字，请补充具体现象后再提交。"
        )
    if len(text) > MESSAGE_MAX:
        raise InvalidFeedback(f"反馈内容最多 {MESSAGE_MAX} 字，请精简后再提交。")
    return text


def normalize_contact(value: object) -> str | None:
    """可选联系方式（邮箱/微信/Telegram 等）：去空白、空串按未填、上限 200。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFeedback("contact 必须是字符串。")
    text = value.strip()
    if not text:
        return None
    if len(text) > CONTACT_MAX:
        raise InvalidFeedback(f"联系方式最多 {CONTACT_MAX} 字符。")
    return text


def normalize_admin_note(value: object) -> str | None:
    """管理员备注：``None``/空串 = 清空；上限 2000。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFeedback("adminNote 必须是字符串或 null。")
    text = value.strip()
    if not text:
        return None
    if len(text) > ADMIN_NOTE_MAX:
        raise InvalidFeedback(f"处理备注最多 {ADMIN_NOTE_MAX} 字。")
    return text


def normalize_page(value: object) -> str | None:
    """来源页（诊断字段）：去空白、空串按未填、超长**截断**到 300。

    page 是机器上下文，不是用户正文——超长只截断不 400，避免因为前端路由
    变长把整个反馈提交打回。0033 没有 page 列，路由把它写进日志。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFeedback("page 必须是字符串。")
    return value.strip()[:PAGE_MAX] or None


def normalize_request_id(value: object) -> str | None:
    """相关 id：去空白、空串按未填、超长截断到 128。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFeedback("requestId 必须是字符串。")
    return value.strip()[:REQUEST_ID_MAX] or None


def _clamp_limit(limit: object) -> int:
    try:
        value = int(limit)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_LIST_LIMIT
    return max(1, min(value, MAX_LIST_LIMIT))


# ---------------------------------------------------------------------------
# 连接 / 序列化
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    """写/读统一的连接（``auth_db.connect`` 负责目录与旧库兼容建表）。"""
    return auth_db.connect()


def _is_missing_feedback_table(exc: sqlite3.Error) -> bool:
    return "no such table" in str(exc).lower()


def _unavailable(exc: sqlite3.Error) -> FeedbackUnavailable:
    return FeedbackUnavailable(f"反馈表不可用：{exc}{_MISSING_TABLE_HINT}")


def _serialize(row: sqlite3.Row) -> dict:
    """表行 → API 形状（camelCase；不含任何账号敏感字段）。"""
    return {
        "id": int(row["id"]),
        "userId": row["user_id"],
        "requestId": row["request_id"],
        "category": row["category"],
        "message": row["message"],
        "contact": row["contact"],
        "status": row["status"],
        "createdAt": row["created_at_ms"],
        "resolvedAt": row["resolved_at_ms"],
        "adminNote": row["admin_note"],
    }


# ---------------------------------------------------------------------------
# 写入 / 读取
# ---------------------------------------------------------------------------

def create(
    *,
    user_id: str | None,
    category: object,
    message: object,
    request_id: object = None,
    contact: object = None,
) -> dict:
    """新建一条反馈：返回落库后的行（含 id/status/requestId）。

    校验失败抛 :class:`InvalidFeedback`；未迁移抛 :class:`FeedbackUnavailable`。
    ``user_id`` 为空表示游客提交（0033 允许 NULL，不做外键校验）。
    """
    clean_category = validate_category(category)
    clean_message = validate_message(message)
    clean_contact = normalize_contact(contact)
    clean_request_id = normalize_request_id(request_id)
    created_at = now_ms()

    conn = _connect()
    try:
        cursor = conn.execute(
            "INSERT INTO feedback "
            "(user_id, request_id, category, message, contact, status, "
            "created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                clean_request_id,
                clean_category,
                clean_message,
                clean_contact,
                DEFAULT_STATUS,
                created_at,
            ),
        )
        feedback_id = int(cursor.lastrowid)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (feedback_id,)
        ).fetchone()
    except sqlite3.Error as exc:
        if _is_missing_feedback_table(exc):
            raise _unavailable(exc) from exc
        raise FeedbackUnavailable(f"写入反馈失败：{exc}") from exc
    finally:
        conn.close()
    if row is None:  # pragma: no cover - 同一连接内刚写入，不该读不到
        raise FeedbackUnavailable("写入反馈后回读失败。")
    return _serialize(row)


def list_recent(status: object = None, limit: object = DEFAULT_LIST_LIMIT) -> dict:
    """管理台列表：最近优先；``status=None``（或 ``all``）不过滤。

    返回 ``{items:[…], total, limit, status}``。``total`` 是**过滤后**的总数
    （管理台分页/未读计数用），不是本次返回条数。
    """
    if status is None or (isinstance(status, str) and status.strip().lower() in ("", "all")):
        clean_status: str | None = None
    else:
        clean_status = validate_status(status)
    resolved_limit = _clamp_limit(limit)

    where = ""
    params: list[Any] = []
    if clean_status is not None:
        where = " WHERE status = ?"
        params.append(clean_status)

    conn = _connect()
    try:
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM feedback{where}", tuple(params)
            ).fetchone()[0]
            or 0
        )
        rows = conn.execute(
            f"SELECT * FROM feedback{where} ORDER BY created_at_ms DESC, id DESC "
            "LIMIT ?",
            (*params, resolved_limit),
        ).fetchall()
    except sqlite3.Error as exc:
        if _is_missing_feedback_table(exc):
            raise _unavailable(exc) from exc
        raise FeedbackUnavailable(f"读取反馈失败：{exc}") from exc
    finally:
        conn.close()
    return {
        "items": [_serialize(row) for row in rows],
        "total": total,
        "limit": resolved_limit,
        "status": clean_status,
    }


def get(feedback_id: int) -> dict:
    """按 id 取一条（管理端/测试用）；不存在抛 :class:`FeedbackNotFound`。"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (int(feedback_id),)
        ).fetchone()
    except sqlite3.Error as exc:
        raise _unavailable(exc) from exc
    finally:
        conn.close()
    if row is None:
        raise FeedbackNotFound(f"反馈不存在：{feedback_id}")
    return _serialize(row)


def update(
    feedback_id: int,
    *,
    status: object = None,
    admin_note: object = None,
    has_status: bool = False,
    has_admin_note: bool = False,
) -> dict:
    """管理员更新状态/备注（至少一项）；返回 ``{feedback, changes}``。

    ``has_status`` / ``has_admin_note`` 区分「字段未提供」与「显式传 null」：
    ``adminNote: null`` 表示清空备注，未提供则保持原值。404 用
    :class:`FeedbackNotFound`，校验失败 :class:`InvalidFeedback`。
    """
    if not has_status and not has_admin_note:
        raise InvalidFeedback("请至少提供 status 或 adminNote。")
    clean_status = validate_status(status) if has_status else None
    clean_note = (
        normalize_admin_note(admin_note) if has_admin_note else None
    )

    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (int(feedback_id),)
        ).fetchone()
        if row is None:
            raise FeedbackNotFound(f"反馈不存在：{feedback_id}")

        previous_status = row["status"]
        new_status = clean_status if clean_status is not None else previous_status
        new_note = clean_note if has_admin_note else row["admin_note"]
        resolved_at = row["resolved_at_ms"]
        if new_status in TERMINAL_STATUSES:
            # 只在「非终态 → 终态」时记时间；终态之间互转保留首次处理时间。
            if previous_status not in TERMINAL_STATUSES:
                resolved_at = now_ms()
        else:
            resolved_at = None

        conn.execute(
            "UPDATE feedback SET status = ?, admin_note = ?, resolved_at_ms = ? "
            "WHERE id = ?",
            (new_status, new_note, resolved_at, int(feedback_id)),
        )
        conn.commit()
        updated = conn.execute(
            "SELECT * FROM feedback WHERE id = ?", (int(feedback_id),)
        ).fetchone()
    except sqlite3.Error as exc:
        if _is_missing_feedback_table(exc):
            raise _unavailable(exc) from exc
        raise FeedbackUnavailable(f"更新反馈失败：{exc}") from exc
    finally:
        conn.close()
    if updated is None:  # pragma: no cover - 更新后回读
        raise FeedbackUnavailable("更新反馈后回读失败。")
    changes: dict[str, dict] = {}
    if new_status != previous_status:
        changes["status"] = {"from": previous_status, "to": new_status}
    if has_admin_note and new_note != row["admin_note"]:
        changes["adminNote"] = {"from": row["admin_note"], "to": new_note}
    return {"feedback": _serialize(updated), "changes": changes}


__all__ = [
    "ADMIN_NOTE_MAX",
    "CATEGORIES",
    "CONTACT_MAX",
    "DEFAULT_LIST_LIMIT",
    "DEFAULT_STATUS",
    "FeedbackError",
    "FeedbackNotFound",
    "FeedbackUnavailable",
    "InvalidFeedback",
    "MAX_LIST_LIMIT",
    "MESSAGE_MAX",
    "MESSAGE_MIN",
    "PAGE_MAX",
    "REQUEST_ID_MAX",
    "STATUSES",
    "TERMINAL_STATUSES",
    "create",
    "get",
    "list_recent",
    "normalize_admin_note",
    "normalize_contact",
    "normalize_page",
    "normalize_request_id",
    "now_ms",
    "update",
    "validate_category",
    "validate_message",
    "validate_status",
]
