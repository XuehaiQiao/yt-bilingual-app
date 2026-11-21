"""FSRS-6 复习调度 + 词状态读写层（计划书 §13.2 M2 / specs/013）。

设计约束：

- **服务端是真源**：每个用户每个词一条 ``word_states``，换设备登录后队列一致；
  前端不持有调度状态。
- **纯函数可测**：:func:`review` 只接收「词状态字典 + 评分 + 当前毫秒时间」，
  不碰数据库、不读系统时间；同样的输入永远得到同样的输出（测试注入时钟）。
- **UTC 存储**：``due_at`` / ``last_reviewed_at`` / ``created_at`` 都是毫秒 UTC
  时间戳；时区展示交给前端。「今日」统计按 UTC 日界（文档已写明）。
- **表由 Alembic 创建**：运行时只读写（``0006_review_engine``）。表缺失时抛
  :class:`ReviewUnavailable`，路由转 503 并提示先跑迁移，绝不顺手建表/建库。
- **幂等**：``add_word`` 重复调用不重置进度（reps/due/stability 都不动），只
  补充新来源；suspend / restore 也是幂等的。
- **已掌握是标记不是状态**：``word_states.mastered``（迁移 0027）是词状态之上
  的 0/1 标记，不新增 ``state`` 取值；``mastered=1`` 的词不进队列、不计新词，
  ``set_mastered`` 幂等且不重置 FSRS 参数（撤销不清复习进度）。
- **可解释**：``review_logs`` 存每次作答前后的完整状态快照（JSON），审计与
  未来重算参数都靠它。
- **止损**：连续 3 次 ``again`` 自动 ``suspended``；手工恢复会把失败计数清零，
  不会被旧日志立刻再次判死。

FSRS 状态与业务状态的映射：

============  ==========================  ===============================
业务 state    FSRS State                  说明
============  ==========================  ===============================
``new``       Learning（step=0，空参数）   新词，首次作答走 FSRS 初始参数
``learning``  Learning                    学习步长（1 分钟 / 10 分钟）
``review``    Review                      正常长期复习
``relearning`` Relearning                 复习时 Again 后的重学阶段
``suspended`` —                           暂停，不进队列；需手工恢复
============  ==========================  ===============================

``step`` / ``fail_streak`` 是内部列（任务书的字段清单之外）：没有 step 就无法
恢复 FSRS 的 10 分钟学习档；没有 fail_streak 就只能靠日志推断连续失败，恢复后
的下一次 Again 会被旧日志再次判死。两列都由本模块维护，不对外暴露。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import uuid
from collections.abc import Iterable
from datetime import datetime, timezone

import config
import languages

logger = logging.getLogger(__name__)

# PyPI fsrs（FSRS-6）。延迟到调用时再 assert，避免缺依赖时整个 app 启动失败；
# requirements.txt 已固定版本。
try:  # pragma: no cover - 正常环境一定有
    from fsrs import Card, Rating, Scheduler, State
except ImportError as exc:  # pragma: no cover
    Card = Rating = Scheduler = State = None  # type: ignore[assignment]
    _FSRS_IMPORT_ERROR: ImportError | None = exc
else:
    _FSRS_IMPORT_ERROR = None

# 业务状态 / 评分（与迁移里的 CHECK 约束保持一致）。
STATE_NEW = "new"
STATE_LEARNING = "learning"
STATE_REVIEW = "review"
STATE_RELEARNING = "relearning"
STATE_SUSPENDED = "suspended"
VALID_STATES = (
    STATE_NEW,
    STATE_LEARNING,
    STATE_REVIEW,
    STATE_RELEARNING,
    STATE_SUSPENDED,
)
DUE_STATES = (STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING)

VALID_RATINGS = ("again", "hard", "good", "easy")

AUTO_SUSPEND_STREAK = 3
DEFAULT_QUEUE_LIMIT = 20
DEFAULT_NEW_LIMIT = 10
MAX_QUEUE_LIMIT = 100

MS_PER_DAY = 86_400_000

# FSRS 配置：目标保持率 0.9；关闭 fuzz 保证同输入同输出（测试可复现）。
DESIRED_RETENTION = 0.9

_scheduler = None


class ReviewError(Exception):
    """复习模块错误基类。"""


class ReviewUnavailable(ReviewError):
    """库/表不存在或 fsrs 未安装：路由应返回 503，提示先跑迁移/装依赖。"""


class WordNotFound(ReviewError):
    """词不在当前用户的生词本里（路由 404）。"""


class WordSuspended(ReviewError):
    """词已暂停复习，需先手工恢复（路由 409）。"""


# ---------------------------------------------------------------------------
# 时间 / 语言 / 词形
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前时间的毫秒时间戳（测试 monkeypatch 这里注入时钟）。"""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _coerce_ms(now) -> int:
    """接受毫秒整数或 aware datetime，统一成毫秒整数。"""
    if now is None:
        return now_ms()
    if isinstance(now, datetime):
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return int(round(now.timestamp() * 1000))
    try:
        return int(now)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"非法时间戳：{now!r}") from exc


def _to_datetime(ms: int) -> datetime:
    """毫秒 UTC → aware datetime（fsrs 要求 tzinfo 必须是 timezone.utc）。"""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def _datetime_to_ms(value: datetime) -> int:
    return int(round(value.timestamp() * 1000))


def normalize_lemma(lemma: str) -> str:
    """词形统一：NFC + 去首尾空白 + 小写（词条大小写不产生重复）。"""
    if not isinstance(lemma, str):
        raise ValueError("lemma 必须是字符串。")
    value = languages.normalize(lemma).strip().lower()
    if not value:
        raise ValueError("lemma 不能为空。")
    if len(value) > 200:
        raise ValueError("lemma 太长（最多 200 字符）。")
    return value


def canonical_target_lang(raw: str | None) -> str:
    """目标语言 canonical code；缺省 zh-CN，非法抛 ValueError（路由 400）。"""
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise ValueError(str(exc)) from exc


def normalize_source(source) -> dict | None:
    """把来源对象规整成 ``{content_ref, sentence_id}``。

    接受 ``None`` / 字符串（当 content_ref）/ dict（camelCase 与 snake_case
    都接受，兼容 videoId / episodeRef 等前端常用写法）。空来源返回 None。
    """
    if source is None:
        return None
    if isinstance(source, str):
        content_ref, sentence_id = source, None
    elif isinstance(source, dict):
        content_ref = _first_present(
            source,
            "contentRef",
            "content_ref",
            "videoId",
            "video_id",
            "episodeRef",
            "episode_ref",
            "content",
        )
        sentence_id = _first_present(
            source, "sentenceId", "sentence_id", "blockId", "block_id"
        )
    else:
        raise ValueError("source 必须是字符串、对象或 null。")

    content_ref = _clean_ref(content_ref)
    sentence_id = _clean_ref(sentence_id)
    if content_ref is None and sentence_id is None:
        return None
    return {"content_ref": content_ref, "sentence_id": sentence_id}


def _first_present(mapping: dict, *keys: str):
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def _clean_ref(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > 500:
        raise ValueError("source 引用太长（最多 500 字符）。")
    return text


# ---------------------------------------------------------------------------
# FSRS 调度（纯函数）
# ---------------------------------------------------------------------------

def _get_scheduler():
    global _scheduler
    if _FSRS_IMPORT_ERROR is not None:
        raise ReviewUnavailable(
            "复习引擎依赖未安装（fsrs）。请先运行 "
            "`backend/venv/bin/pip install -r backend/requirements.txt`。"
        )
    if _scheduler is None:
        _scheduler = Scheduler(
            desired_retention=DESIRED_RETENTION,
            # 关闭 fuzz：调度结果确定，测试可逐毫秒断言。
            enable_fuzzing=False,
        )
    return _scheduler


_RATING_MAP = None
_STATE_TO_DB = None


def _rating_map():
    global _RATING_MAP
    if _RATING_MAP is None:
        _RATING_MAP = {
            "again": Rating.Again,
            "hard": Rating.Hard,
            "good": Rating.Good,
            "easy": Rating.Easy,
        }
    return _RATING_MAP


def _state_map():
    global _STATE_TO_DB
    if _STATE_TO_DB is None:
        _STATE_TO_DB = {
            State.Learning: STATE_LEARNING,
            State.Review: STATE_REVIEW,
            State.Relearning: STATE_RELEARNING,
        }
    return _STATE_TO_DB


def _word_to_card(word_state: dict, now: int):
    """业务状态 → FSRS Card。state=suspended 抛异常。"""
    state = str(word_state.get("state") or STATE_NEW)
    if state == STATE_SUSPENDED:
        raise WordSuspended("该词已暂停复习，请先恢复后再作答。")
    if state not in VALID_STATES:
        raise ValueError(f"未知词状态：{state!r}")

    stability = word_state.get("stability")
    difficulty = word_state.get("difficulty")
    stability = float(stability) if stability is not None else None
    difficulty = float(difficulty) if difficulty is not None else None
    due_at = _coerce_ms(word_state.get("due_at"))
    last = word_state.get("last_reviewed_at")
    step = int(word_state.get("step") or 0)

    if state == STATE_NEW:
        # 新词不沿用任何历史参数，确保首次作答走 FSRS 初始值。
        return Card(
            card_id=0,
            state=State.Learning,
            step=0,
            stability=None,
            difficulty=None,
            due=_to_datetime(due_at),
            last_review=None,
        )
    if state == STATE_LEARNING:
        return Card(
            card_id=0,
            state=State.Learning,
            step=max(0, step),
            stability=stability,
            difficulty=difficulty,
            due=_to_datetime(due_at),
            last_review=_to_datetime(_coerce_ms(last)) if last is not None else None,
        )
    if state == STATE_REVIEW:
        return Card(
            card_id=0,
            state=State.Review,
            step=None,
            stability=stability,
            difficulty=difficulty,
            due=_to_datetime(due_at),
            last_review=_to_datetime(_coerce_ms(last)) if last is not None else None,
        )
    # relearning
    return Card(
        card_id=0,
        state=State.Relearning,
        step=max(0, step),
        stability=stability,
        difficulty=difficulty,
        due=_to_datetime(due_at),
        last_review=_to_datetime(_coerce_ms(last)) if last is not None else None,
    )


def review(word_state: dict, rating: str, now=None) -> dict:
    """按 FSRS-6 计算一次作答后的新状态（纯函数，不写库）。

    参数：

    - ``word_state``：至少包含 ``state`` / ``due_at`` / ``stability`` /
      ``difficulty`` / ``reps`` / ``lapses`` / ``step`` / ``fail_streak`` /
      ``last_reviewed_at`` 的字典（数据库行即可）；
    - ``rating``：``again`` / ``hard`` / ``good`` / ``easy``（大小写不敏感）；
    - ``now``：毫秒时间戳或 aware datetime；缺省取 :func:`now_ms`。

    返回新字典（不修改入参），并带 ``auto_suspended`` 标记：连续第 3 次
    ``again`` 时 ``state`` 直接变成 ``suspended``，``due_at`` 仍按 FSRS 算出，
    便于恢复时参考。新词首次作答、学习步长、重学步长全部由 fsrs 决定。
    """
    if not isinstance(rating, str):
        raise ValueError("rating 必须是字符串。")
    rating_key = rating.strip().lower()
    if rating_key not in VALID_RATINGS:
        raise ValueError(
            f"非法评分：{rating!r}（只能是 {', '.join(VALID_RATINGS)}）。"
        )
    if not isinstance(word_state, dict):
        word_state = dict(word_state)

    now_value = _coerce_ms(now)
    current = dict(word_state)
    scheduler = _get_scheduler()
    card = _word_to_card(current, now_value)
    try:
        new_card, _log = scheduler.review_card(
            card,
            _rating_map()[rating_key],
            review_datetime=_to_datetime(now_value),
        )
    except ValueError as exc:
        # 数据库里参数损坏（例如 stability 为负）时给出明确错误，不写坏状态。
        raise ReviewError(f"FSRS 调度失败：{exc}") from exc

    fail_streak = int(current.get("fail_streak") or 0)
    fail_streak = fail_streak + 1 if rating_key == "again" else 0
    lapses = int(current.get("lapses") or 0) + (1 if rating_key == "again" else 0)

    updated = dict(current)
    updated["state"] = _state_map()[new_card.state]
    updated["step"] = int(new_card.step or 0)
    updated["due_at"] = _datetime_to_ms(new_card.due)
    updated["stability"] = new_card.stability
    updated["difficulty"] = new_card.difficulty
    updated["reps"] = int(current.get("reps") or 0) + 1
    updated["lapses"] = lapses
    updated["fail_streak"] = fail_streak
    updated["last_reviewed_at"] = now_value
    updated["auto_suspended"] = False
    if fail_streak >= AUTO_SUSPEND_STREAK:
        updated["state"] = STATE_SUSPENDED
        updated["auto_suspended"] = True
    return updated


# ---------------------------------------------------------------------------
# SQLite 读写
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise ReviewUnavailable(
            f"数据库文件不存在：{path}（先运行 `venv/bin/alembic upgrade head`）。"
        )
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _translate_db_error(exc: sqlite3.Error) -> None:
    """表/列缺失 → ReviewUnavailable（503）；其余错误原样抛。"""
    text = str(exc).lower()
    if "no such table" in text or "no such column" in text:
        raise ReviewUnavailable(
            "复习数据表不存在（未跑 0006_review_engine 迁移）。"
            "请先运行 `backend/venv/bin/alembic upgrade head`。"
        ) from exc


def _row_to_word(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["state"] = str(item.get("state") or STATE_NEW)
    item["target_lang"] = item.get("target_lang") or languages.DEFAULT_TARGET_LANG
    item["due_at"] = int(item.get("due_at") or 0)
    item["reps"] = int(item.get("reps") or 0)
    item["lapses"] = int(item.get("lapses") or 0)
    item["step"] = int(item.get("step") or 0)
    item["fail_streak"] = int(item.get("fail_streak") or 0)
    # 「已掌握」标记：库停在 0026 时 SELECT 用 0 AS mastered 兜底，这里统一成 0/1。
    item[MASTERED_COLUMN] = 1 if int(item.get(MASTERED_COLUMN) or 0) else 0
    if item.get("stability") is not None:
        item["stability"] = float(item["stability"])
    if item.get("difficulty") is not None:
        item["difficulty"] = float(item["difficulty"])
    for key in ("last_reviewed_at", "created_at"):
        if item.get(key) is not None:
            item[key] = int(item[key])
    return item


def _snapshot(word: dict) -> dict:
    """写进 review_logs 的状态快照（只留调度相关字段，不含来源）。"""
    return {
        "lemma": word.get("lemma"),
        "target_lang": word.get("target_lang"),
        "state": word.get("state"),
        "due_at": word.get("due_at"),
        "stability": word.get("stability"),
        "difficulty": word.get("difficulty"),
        "reps": word.get("reps"),
        "lapses": word.get("lapses"),
        "step": word.get("step"),
        "fail_streak": word.get("fail_streak"),
        "last_reviewed_at": word.get("last_reviewed_at"),
    }


_WORD_COLUMNS = (
    "id, user_id, lemma, target_lang, state, due_at, stability, difficulty, "
    "reps, lapses, step, fail_streak, last_reviewed_at, created_at"
)

# 「已掌握」标记（迁移 0027_review_mastered）。它是词状态之上的标记，不是新的
# ``state`` 取值；列可能不存在（库停在 0026），所以读写都要先探测列。
MASTERED_COLUMN = "mastered"


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """表/列是否存在（PRAGMA；表不存在时返回 False，不抛异常）。"""
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.OperationalError:
        return False
    return any(row[1] == column for row in rows)


def _has_mastered(conn: sqlite3.Connection) -> bool:
    return _has_column(conn, "word_states", MASTERED_COLUMN)


def _word_columns(conn: sqlite3.Connection) -> str:
    """词状态 SELECT 的列清单。

    未跑 0027 的库没有 ``mastered`` 列：读侧返回 ``0 AS mastered``，让队列 /
    统计 / 公开形状保持兼容，而不是让整个复习模块 503。
    """
    if _has_mastered(conn):
        return _WORD_COLUMNS + f", {MASTERED_COLUMN}"
    return _WORD_COLUMNS + f", 0 AS {MASTERED_COLUMN}"


def _unmastered_clause(conn: sqlite3.Connection) -> str:
    """「不是已掌握」过滤；列不存在时全部视为 0，不需要过滤。"""
    return f" AND {MASTERED_COLUMN} = 0" if _has_mastered(conn) else ""


def _fetch_word(
    conn: sqlite3.Connection, user_id: str, lemma: str, target_lang: str
) -> sqlite3.Row | None:
    return conn.execute(
        f"SELECT {_word_columns(conn)} FROM word_states "
        "WHERE user_id = ? AND lemma = ? AND target_lang = ?",
        (user_id, lemma, target_lang),
    ).fetchone()


def _fetch_sources(conn: sqlite3.Connection, word_state_ids: list[str]) -> dict:
    """批量取来源，返回 ``{word_state_id: [来源…]}``。"""
    if not word_state_ids:
        return {}
    placeholders = ", ".join("?" for _ in word_state_ids)
    rows = conn.execute(
        "SELECT word_state_id, content_ref, sentence_id, created_at "
        f"FROM word_sources WHERE word_state_id IN ({placeholders}) "
        "ORDER BY created_at ASC, rowid ASC",
        tuple(word_state_ids),
    ).fetchall()
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row["word_state_id"], []).append(
            {
                "content_ref": row["content_ref"],
                "sentence_id": row["sentence_id"],
                "created_at": int(row["created_at"] or 0),
            }
        )
    return grouped


def _attach_sources(conn: sqlite3.Connection, words: list[dict]) -> None:
    grouped = _fetch_sources(conn, [word["id"] for word in words])
    for word in words:
        word["sources"] = grouped.get(word["id"], [])


def _insert_source(
    conn: sqlite3.Connection, word_state_id: str, source: dict, created_at: int
) -> bool:
    """插入一条来源；同一词 + 同一来源幂等去重。返回是否新增。"""
    content_ref = source.get("content_ref")
    sentence_id = source.get("sentence_id")
    if content_ref is None and sentence_id is None:
        return False
    existing = conn.execute(
        "SELECT 1 FROM word_sources WHERE word_state_id = ? "
        "AND content_ref IS ? AND sentence_id IS ?",
        (word_state_id, content_ref, sentence_id),
    ).fetchone()
    if existing is not None:
        return False
    conn.execute(
        "INSERT INTO word_sources (word_state_id, content_ref, sentence_id, created_at) "
        "VALUES (?, ?, ?, ?)",
        (word_state_id, content_ref, sentence_id, created_at),
    )
    return True


def _require_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("user_id 不能为空。")
    return user_id.strip()


def add_word(
    user_id: str,
    lemma: str,
    target_lang: str,
    source=None,
    now=None,
) -> dict:
    """把词加入生词本；已存在时**不重置进度**，只补充新来源。

    返回词字典（含 ``sources`` 与 ``created``）。``created=True`` 表示本次
    新建了状态；重复添加返回 ``created=False``，``reps`` / ``due_at`` /
    FSRS 参数保持原样。
    """
    user_id = _require_user_id(user_id)
    lemma_key = normalize_lemma(lemma)
    lang = canonical_target_lang(target_lang)
    normalized_source = normalize_source(source)
    created_at = _coerce_ms(now)

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = _fetch_word(conn, user_id, lemma_key, lang)
        created = False
        if row is None:
            word_id = uuid.uuid4().hex
            conn.execute(
                "INSERT OR IGNORE INTO word_states "
                "(id, user_id, lemma, target_lang, state, due_at, stability, "
                "difficulty, reps, lapses, step, fail_streak, last_reviewed_at, "
                "created_at) VALUES (?, ?, ?, ?, 'new', ?, NULL, NULL, 0, 0, 0, 0, "
                "NULL, ?)",
                (word_id, user_id, lemma_key, lang, created_at, created_at),
            )
            row = _fetch_word(conn, user_id, lemma_key, lang)
            if row is None:  # 理论上不会发生；保留明确错误而不是空指针
                raise ReviewError("创建词状态失败。")
            created = True
        elif int(row[MASTERED_COLUMN] or 0):
            # 已掌握的词再次「加入复习」= 用户想复习：强制清掉标记（specs/013
            # v1.1）。FSRS 参数、reps、due_at 一律不动，只是重新进队列。
            conn.execute(
                f"UPDATE word_states SET {MASTERED_COLUMN} = 0 WHERE id = ?",
                (row["id"],),
            )
            row = _fetch_word(conn, user_id, lemma_key, lang)
        if normalized_source is not None:
            _insert_source(conn, row["id"], normalized_source, created_at)
        word = _row_to_word(row)
        _attach_sources(conn, [word])
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    word["created"] = created
    return word


def get_word(user_id: str, lemma: str, target_lang: str) -> dict | None:
    """按用户 + 词 + 语言读取状态（不存在返回 None）。"""
    user_id = _require_user_id(user_id)
    lemma_key = normalize_lemma(lemma)
    lang = canonical_target_lang(target_lang)
    conn = _connect()
    try:
        row = _fetch_word(conn, user_id, lemma_key, lang)
        if row is None:
            return None
        word = _row_to_word(row)
        _attach_sources(conn, [word])
        return word
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()


def set_mastered(
    user_id: str,
    lemma: str,
    target_lang: str,
    mastered: bool,
    now=None,
    source=None,
) -> dict:
    """设置 / 撤销「已掌握」标记（upsert，幂等）。

    - 词不存在：建一行 ``state='new'``，``mastered`` 按入参落库（``mastered=1``
      时因队列过滤不会进复习队列）；
    - 已存在：**只改标记**，不碰 FSRS 参数 / ``reps`` / ``due_at``（撤销已掌握
      不重置复习进度）；
    - 同一个值重复调用幂等：不新建行、不改字段；
    - ``source`` 可选，形状同 :func:`add_word`，用于记录标记来源。

    返回词字典（含 ``sources`` 与 ``created``）。库未跑 ``0027_review_mastered``
    迁移时抛 :class:`ReviewUnavailable`（路由 503），不静默吞掉标记。
    """
    user_id = _require_user_id(user_id)
    lemma_key = normalize_lemma(lemma)
    lang = canonical_target_lang(target_lang)
    if isinstance(mastered, bool):
        flag = 1 if mastered else 0
    elif isinstance(mastered, int) and mastered in (0, 1):
        flag = int(mastered)
    else:
        raise ValueError("mastered 必须是布尔值。")
    normalized_source = normalize_source(source)
    now_value = _coerce_ms(now)

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not _has_mastered(conn):
            raise ReviewUnavailable(
                "词状态表缺少 mastered 列（未跑 0027_review_mastered 迁移）。"
                "请先运行 `backend/venv/bin/alembic upgrade head`。"
            )
        row = _fetch_word(conn, user_id, lemma_key, lang)
        created = False
        if row is None:
            word_id = uuid.uuid4().hex
            conn.execute(
                "INSERT OR IGNORE INTO word_states "
                "(id, user_id, lemma, target_lang, state, due_at, stability, "
                "difficulty, reps, lapses, step, fail_streak, last_reviewed_at, "
                "created_at, mastered) VALUES (?, ?, ?, ?, 'new', ?, NULL, NULL, "
                "0, 0, 0, 0, NULL, ?, ?)",
                (word_id, user_id, lemma_key, lang, now_value, now_value, flag),
            )
            row = _fetch_word(conn, user_id, lemma_key, lang)
            if row is None:  # 理论上不会发生；保留明确错误而不是空指针
                raise ReviewError("创建词状态失败。")
            created = True
        elif int(row[MASTERED_COLUMN] or 0) != flag:
            conn.execute(
                f"UPDATE word_states SET {MASTERED_COLUMN} = ? WHERE id = ?",
                (flag, row["id"]),
            )
            row = _fetch_word(conn, user_id, lemma_key, lang)
        if normalized_source is not None:
            _insert_source(conn, row["id"], normalized_source, now_value)
        word = _row_to_word(row)
        _attach_sources(conn, [word])
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    word["created"] = created
    return word


def _queue_rows(
    conn: sqlite3.Connection,
    user_id: str,
    target_lang: str | None,
    now: int,
    limit: int,
    new_limit: int,
) -> tuple[list[dict], list[dict]]:
    state_placeholders = ", ".join("?" for _ in DUE_STATES)
    language_clause = " AND target_lang = ?" if target_lang else ""
    language_args: tuple = (target_lang,) if target_lang else ()
    # 已掌握的词不进队列（specs/013 v1.1）；列不存在时无需过滤（全视为 0）。
    mastered_clause = _unmastered_clause(conn)

    due_rows = conn.execute(
        f"SELECT {_word_columns(conn)} FROM word_states "
        "WHERE user_id = ? AND state IN "
        f"({state_placeholders}) AND due_at <= ?"
        f"{language_clause}{mastered_clause} "
        "ORDER BY due_at ASC, created_at ASC, id ASC LIMIT ?",
        (user_id, *DUE_STATES, now, *language_args, limit),
    ).fetchall()
    due = [_row_to_word(row) for row in due_rows]

    remaining = max(0, limit - len(due))
    take_new = min(new_limit, remaining)
    new: list[dict] = []
    if take_new > 0:
        new_rows = conn.execute(
            f"SELECT {_word_columns(conn)} FROM word_states "
            "WHERE user_id = ? AND state = 'new' AND due_at <= ?"
            f"{language_clause}{mastered_clause} "
            "ORDER BY created_at ASC, id ASC LIMIT ?",
            (user_id, now, *language_args, take_new),
        ).fetchall()
        new = [_row_to_word(row) for row in new_rows]

    _attach_sources(conn, due + new)
    return due, new


def get_due(
    user_id: str,
    limit: int = DEFAULT_QUEUE_LIMIT,
    now=None,
    target_lang: str | None = None,
    new_limit: int | None = None,
) -> dict:
    """到期队列：到期词（learning/review/relearning）+ 有上限的新词。

    ``limit`` 是**总条数**上限；``new_limit`` 默认 10，且不会超过剩余名额。
    到期词按 ``due_at`` 升序；新词按 ``created_at`` 升序（先入先见）。
    ``target_lang=None`` 时跨语言返回（API 默认传 zh-CN）。
    """
    user_id = _require_user_id(user_id)
    now_value = _coerce_ms(now)
    try:
        limit_value = int(limit)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit 必须是整数。") from exc
    limit_value = max(1, min(MAX_QUEUE_LIMIT, limit_value))
    if new_limit is None:
        new_cap = DEFAULT_NEW_LIMIT
    else:
        try:
            new_cap = int(new_limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("newLimit 必须是整数。") from exc
        new_cap = max(0, min(MAX_QUEUE_LIMIT, new_cap))
    lang = canonical_target_lang(target_lang) if target_lang else None

    conn = _connect()
    try:
        due, new = _queue_rows(
            conn, user_id, lang, now_value, limit_value, new_cap
        )
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()

    return {
        "target_lang": lang,
        "now": now_value,
        "due": due,
        "new": new,
        "items": due + new,
        "counts": {"due": len(due), "new": len(new), "total": len(due) + len(new)},
        "limit": limit_value,
        "new_limit": new_cap,
    }


def record_answer(
    user_id: str,
    lemma: str,
    rating: str,
    target_lang: str,
    elapsed_ms: int | None = None,
    now=None,
) -> dict:
    """作答并落库：更新状态 + 追加 review_logs（同一事务）。

    连续第 3 次 ``again`` 时 ``review`` 会把 state 置为 suspended，本函数照常
    写日志并返回 ``auto_suspended=True``。
    """
    user_id = _require_user_id(user_id)
    lemma_key = normalize_lemma(lemma)
    lang = canonical_target_lang(target_lang)
    now_value = _coerce_ms(now)
    if elapsed_ms is not None:
        try:
            elapsed_value = int(elapsed_ms)
        except (TypeError, ValueError) as exc:
            raise ValueError("elapsedMs 必须是整数。") from exc
        if elapsed_value < 0:
            raise ValueError("elapsedMs 不能为负数。")
    else:
        elapsed_value = None

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = _fetch_word(conn, user_id, lemma_key, lang)
        if row is None:
            raise WordNotFound("词不在生词本中。")
        before = _row_to_word(row)
        if before["state"] == STATE_SUSPENDED:
            raise WordSuspended("该词已暂停复习，请先恢复后再作答。")
        after = review(before, rating, now=now_value)

        conn.execute(
            "UPDATE word_states SET state = ?, due_at = ?, stability = ?, "
            "difficulty = ?, reps = ?, lapses = ?, step = ?, fail_streak = ?, "
            "last_reviewed_at = ? WHERE id = ?",
            (
                after["state"],
                after["due_at"],
                after.get("stability"),
                after.get("difficulty"),
                after["reps"],
                after["lapses"],
                after.get("step", 0),
                after["fail_streak"],
                after["last_reviewed_at"],
                before["id"],
            ),
        )
        conn.execute(
            "INSERT INTO review_logs (user_id, lemma, target_lang, rating, "
            "state_before, state_after, reviewed_at, elapsed_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                lemma_key,
                lang,
                str(rating).strip().lower(),
                json.dumps(_snapshot(before), ensure_ascii=False, sort_keys=True),
                json.dumps(_snapshot(after), ensure_ascii=False, sort_keys=True),
                now_value,
                elapsed_value,
            ),
        )
        # review_logs 已写入；返回词按 after 构造（含来源），不再回查。
        word = dict(after)
        word.update(
            {
                "id": before["id"],
                "user_id": user_id,
                "lemma": lemma_key,
                "target_lang": lang,
                "created_at": before.get("created_at"),
            }
        )
        _attach_sources(conn, [word])
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "word": word,
        "state_before": _snapshot(before),
        "state_after": _snapshot(word),
        "auto_suspended": bool(after.get("auto_suspended")),
        "reviewed_at": now_value,
    }


def set_suspended(
    user_id: str,
    lemma: str,
    target_lang: str,
    suspended: bool = True,
    now=None,
) -> dict:
    """手工暂停 / 恢复一个词（幂等）。

    - 暂停：state → suspended，保留 FSRS 参数与 due_at；
    - 恢复：有复习历史（reps>0）→ review，否则 → new；``due_at=now``、
      ``fail_streak=0``，保留 stability/difficulty。恢复后不会被恢复前的
      三次 Again 日志立刻再次判死。
    """
    user_id = _require_user_id(user_id)
    lemma_key = normalize_lemma(lemma)
    lang = canonical_target_lang(target_lang)
    now_value = _coerce_ms(now)

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = _fetch_word(conn, user_id, lemma_key, lang)
        if row is None:
            raise WordNotFound("词不在生词本中。")
        word = _row_to_word(row)
        if suspended:
            if word["state"] != STATE_SUSPENDED:
                conn.execute(
                    "UPDATE word_states SET state = ? WHERE id = ?",
                    (STATE_SUSPENDED, word["id"]),
                )
                word["state"] = STATE_SUSPENDED
        else:
            if word["state"] == STATE_SUSPENDED:
                restored_state = STATE_REVIEW if word["reps"] > 0 else STATE_NEW
                conn.execute(
                    "UPDATE word_states SET state = ?, due_at = ?, step = ?, "
                    "fail_streak = 0, stability = ?, difficulty = ? WHERE id = ?",
                    (
                        restored_state,
                        now_value,
                        0,
                        None if restored_state == STATE_NEW else word.get("stability"),
                        None if restored_state == STATE_NEW else word.get("difficulty"),
                        word["id"],
                    ),
                )
                word.update(
                    {
                        "state": restored_state,
                        "due_at": now_value,
                        "step": 0,
                        "fail_streak": 0,
                        "stability": (
                            None
                            if restored_state == STATE_NEW
                            else word.get("stability")
                        ),
                        "difficulty": (
                            None
                            if restored_state == STATE_NEW
                            else word.get("difficulty")
                        ),
                    }
                )
        _attach_sources(conn, [word])
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return word


def list_suspended(
    user_id: str,
    target_lang: str | None = None,
    *,
    limit: int = 100,
    now=None,
) -> dict:
    """被暂停的词（自动或手工），最近更新优先；供「恢复」列表用。"""
    user_id = _require_user_id(user_id)
    lang = canonical_target_lang(target_lang) if target_lang else None
    now_value = _coerce_ms(now)
    limit_value = max(1, min(int(limit), 200))
    language_clause = " AND target_lang = ?" if lang else ""
    language_args: tuple = (lang,) if lang else ()

    conn = _connect()
    try:
        rows = conn.execute(
            f"SELECT {_word_columns(conn)} FROM word_states "
            "WHERE user_id = ? AND state = 'suspended'"
            f"{language_clause} "
            "ORDER BY COALESCE(last_reviewed_at, created_at) DESC, id DESC "
            "LIMIT ?",
            (user_id, *language_args, limit_value),
        ).fetchall()
        words = [_row_to_word(row) for row in rows]
        _attach_sources(conn, words)
        total = int(
            conn.execute(
                "SELECT COUNT(*) AS n FROM word_states "
                "WHERE user_id = ? AND state = 'suspended'"
                f"{language_clause}",
                (user_id, *language_args),
            ).fetchone()["n"]
            or 0
        )
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()
    return {
        "target_lang": lang,
        "now": now_value,
        "total": total,
        "words": words,
    }


def normalize_states(states: str | Iterable[str] | None) -> tuple[str, ...] | None:
    """把 ``state`` 筛选值规范成 ``VALID_STATES`` 的子集（``None`` = 不过滤）。

    - 接受逗号分隔字符串（``new,review``）或字符串序列；``None`` → ``None``；
    - 每一项去首尾空白 + 小写，空项忽略（``new,`` 等价 ``new``）；
    - 去重，并按 ``VALID_STATES`` 顺序返回（SQL 占位符参数稳定）；
    - 出现未知状态 → ``ValueError``；给的值里没有任何有效状态（``state=``）
      也是 ``ValueError``——省略该参数才表示不过滤。
    """
    if states is None:
        return None
    if isinstance(states, str):
        items = states.split(",")
    else:
        items = [str(item) for item in states]
    wanted: set[str] = set()
    for item in items:
        token = item.strip().lower()
        if not token:
            continue
        if token not in VALID_STATES:
            raise ValueError(
                "state 只能是 " + "/".join(VALID_STATES) + " 的子集（逗号分隔）。"
            )
        wanted.add(token)
    if not wanted:
        raise ValueError("state 不能为空；省略该参数表示不过滤。")
    return tuple(state for state in VALID_STATES if state in wanted)


def list_words(
    user_id: str,
    target_lang: str | None = None,
    mastered: int | bool | None = None,
    *,
    states: str | Iterable[str] | None = None,
    limit: int = 100,
    now=None,
) -> dict:
    """列出词状态（默认全部；``mastered`` / ``states`` 可再收窄）。

    - ``mastered=None``：不过滤，返回全部词（含已掌握）；``1`` 只返回已掌握、
      ``0`` 只返回未掌握；只接受 ``0`` / ``1``（布尔也接），其它值 ValueError；
    - ``states=None``：不过滤；否则只返回这些 ``state`` 的词（合法值见
      ``VALID_STATES``，规范/校验走 :func:`normalize_states`，与 ``mastered``
      同时给出时取交集（AND））；
    - ``target_lang=None``：跨语言；给了就只返回该语言；
    - **没有分页/offset**：``limit``（1–200，默认 100）只截断返回列表，
      ``total`` 是过滤后的总数、不受 ``limit`` 影响；
    - 排序 ``COALESCE(last_reviewed_at, created_at) DESC, id DESC``（最近更新的
      在前，与暂停词列表一致）；
    - 读侧兼容：库未跑 0027（没有 ``mastered`` 列）时 ``mastered=0`` 等价全部词、
      ``mastered=1`` 返回空列表，不 503。
    """
    user_id = _require_user_id(user_id)
    lang = canonical_target_lang(target_lang) if target_lang else None
    if mastered is None:
        flag: int | None = None
    elif isinstance(mastered, bool):
        flag = 1 if mastered else 0
    elif isinstance(mastered, int) and mastered in (0, 1):
        flag = int(mastered)
    else:
        raise ValueError("mastered 只能是 0 或 1。")
    state_filter = normalize_states(states)
    now_value = _coerce_ms(now)
    limit_value = max(1, min(int(limit), 200))
    language_clause = " AND target_lang = ?" if lang else ""
    language_args: tuple = (lang,) if lang else ()

    conn = _connect()
    try:
        if flag == 1 and not _has_mastered(conn):
            # 旧库不可能有已掌握行：直接空列表，不因缺列 503。
            total, words = 0, []
        else:
            mastered_clause = ""
            mastered_args: tuple = ()
            if flag is not None and _has_mastered(conn):
                mastered_clause = f" AND {MASTERED_COLUMN} = ?"
                mastered_args = (flag,)
            state_clause = ""
            state_args: tuple = ()
            if state_filter:
                placeholders = ", ".join("?" for _ in state_filter)
                state_clause = f" AND state IN ({placeholders})"
                state_args = state_filter
            filters_clause = f"{language_clause}{mastered_clause}{state_clause}"
            filters_args = (*language_args, *mastered_args, *state_args)
            rows = conn.execute(
                f"SELECT {_word_columns(conn)} FROM word_states "
                "WHERE user_id = ?"
                f"{filters_clause} "
                "ORDER BY COALESCE(last_reviewed_at, created_at) DESC, id DESC "
                "LIMIT ?",
                (user_id, *filters_args, limit_value),
            ).fetchall()
            words = [_row_to_word(row) for row in rows]
            _attach_sources(conn, words)
            total = int(
                conn.execute(
                    "SELECT COUNT(*) AS n FROM word_states WHERE user_id = ?"
                    f"{filters_clause}",
                    (user_id, *filters_args),
                ).fetchone()["n"]
                or 0
            )
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()
    return {
        "target_lang": lang,
        "now": now_value,
        "total": total,
        "words": words,
    }


def is_suspended(user_id: str, lemma: str, target_lang: str) -> bool | None:
    """状态查询便捷函数：不存在返回 None。"""
    word = get_word(user_id, lemma, target_lang)
    if word is None:
        return None
    return word["state"] == STATE_SUSPENDED


def suspend(user_id: str, lemma: str, target_lang: str, now=None) -> dict:
    """``set_suspended(..., suspended=True)`` 的语义化快捷入口。"""
    return set_suspended(user_id, lemma, target_lang, suspended=True, now=now)


def restore(user_id: str, lemma: str, target_lang: str, now=None) -> dict:
    """``set_suspended(..., suspended=False)`` 的语义化快捷入口。"""
    return set_suspended(user_id, lemma, target_lang, suspended=False, now=now)


def get_stats(
    user_id: str,
    target_lang: str | None = None,
    now=None,
) -> dict:
    """复习统计（「今日」按 UTC 日界；target_lang 缺省 = 全部语言）。"""
    user_id = _require_user_id(user_id)
    lang = canonical_target_lang(target_lang) if target_lang else None
    now_value = _coerce_ms(now)
    day_start = (now_value // MS_PER_DAY) * MS_PER_DAY
    day_end = day_start + MS_PER_DAY
    today = datetime.fromtimestamp(day_start / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d"
    )

    language_clause = " AND target_lang = ?" if lang else ""
    language_args: tuple = (lang,) if lang else ()
    state_placeholders = ", ".join("?" for _ in DUE_STATES)
    # 已掌握的词不进队列、不计 newWords / dueToday，也不参与连续天数
    # （specs/013 v1.1）；库停在 0026 时列不存在，全视为未掌握。
    conn = _connect()
    has_mastered = _has_mastered(conn)
    mastered_clause = _unmastered_clause(conn)

    try:
        def count_words(extra: str, *params) -> int:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM word_states WHERE user_id = ?"
                f"{language_clause}{extra}",
                (user_id, *language_args, *params),
            ).fetchone()
            return int(row["n"] or 0)

        def count_logs(extra: str, *params) -> int:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM review_logs WHERE user_id = ?"
                f"{language_clause}{extra}",
                (user_id, *language_args, *params),
            ).fetchone()
            return int(row["n"] or 0)

        due_today = count_words(
            f" AND state IN ({state_placeholders}) AND due_at < ?"
            f"{mastered_clause}",
            *DUE_STATES,
            day_end,
        )
        due_now = count_words(
            f" AND state IN ({state_placeholders}) AND due_at <= ?"
            f"{mastered_clause}",
            *DUE_STATES,
            now_value,
        )
        reviewed_today = count_logs(
            " AND reviewed_at >= ? AND reviewed_at < ?", day_start, day_end
        )
        reviewed_words_today = int(
            conn.execute(
                "SELECT COUNT(DISTINCT lemma) AS n FROM review_logs "
                "WHERE user_id = ?"
                f"{language_clause} AND reviewed_at >= ? AND reviewed_at < ?",
                (user_id, *language_args, day_start, day_end),
            ).fetchone()["n"]
            or 0
        )
        new_words = count_words(f" AND state = 'new'{mastered_clause}")
        new_today = count_words(" AND created_at >= ? AND created_at < ?", day_start, day_end)
        total_words = count_words("")
        suspended_words = count_words(" AND state = 'suspended'")
        mastered_words = (
            count_words(f" AND {MASTERED_COLUMN} = 1") if has_mastered else 0
        )

        # 连续天数：从今天（若今天已复习）或昨天往回数。只取近 400 天，避免全表扫。
        # 已掌握的词不参与连续天数：它们的作答日志不算「今天复习过」。
        streak_mastered_clause = (
            " AND NOT EXISTS ("
            "SELECT 1 FROM word_states ws "
            "WHERE ws.user_id = review_logs.user_id "
            "AND ws.lemma = review_logs.lemma "
            "AND ws.target_lang = review_logs.target_lang "
            f"AND ws.{MASTERED_COLUMN} = 1)"
            if has_mastered
            else ""
        )
        streak_rows = conn.execute(
            "SELECT DISTINCT (reviewed_at / ?) AS day FROM review_logs "
            "WHERE user_id = ?"
            f"{language_clause} AND reviewed_at >= ?{streak_mastered_clause}",
            (MS_PER_DAY, user_id, *language_args, now_value - 400 * MS_PER_DAY),
        ).fetchall()
        review_days = {int(row["day"]) for row in streak_rows}
        current_day = now_value // MS_PER_DAY
        cursor = current_day if current_day in review_days else current_day - 1
        streak_days = 0
        while cursor in review_days:
            streak_days += 1
            cursor -= 1
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()

    return {
        "target_lang": lang,
        "now": now_value,
        "today": today,
        "due_today": due_today,
        "due_now": due_now,
        "reviewed_today": reviewed_today,
        "reviewed_words_today": reviewed_words_today,
        "new_words": new_words,
        "new_today": new_today,
        "total_words": total_words,
        "suspended_words": suspended_words,
        "mastered_words": mastered_words,
        "streak_days": streak_days,
    }


# ---------------------------------------------------------------------------
# 对外序列化（camelCase，API 契约见 specs/013）
# ---------------------------------------------------------------------------

def _public_source(source: dict) -> dict:
    return {
        "contentRef": source.get("content_ref"),
        "sentenceId": source.get("sentence_id"),
        "createdAt": source.get("created_at"),
    }


def to_public_word(word: dict) -> dict:
    """内部 snak_case 词字典 → API camelCase 形状（不暴露 step）。"""
    return {
        "id": word.get("id"),
        "lemma": word.get("lemma"),
        "targetLang": word.get("target_lang"),
        "state": word.get("state"),
        "dueAt": word.get("due_at"),
        "stability": word.get("stability"),
        "difficulty": word.get("difficulty"),
        "reps": word.get("reps"),
        "lapses": word.get("lapses"),
        "failStreak": word.get("fail_streak"),
        "lastReviewedAt": word.get("last_reviewed_at"),
        "createdAt": word.get("created_at"),
        # 「已掌握」标记：bool（库停在 0026 时由读侧兜底为 False）。
        "mastered": bool(word.get(MASTERED_COLUMN)),
        "sources": [
            _public_source(source) for source in (word.get("sources") or [])
        ],
    }


def to_public_queue(queue: dict) -> dict:
    """内部队列 → API 形状。"""
    return {
        "targetLang": queue.get("target_lang"),
        "now": queue.get("now"),
        "limit": queue.get("limit"),
        "newLimit": queue.get("new_limit"),
        "counts": queue.get("counts"),
        "due": [to_public_word(word) for word in queue.get("due", [])],
        "new": [to_public_word(word) for word in queue.get("new", [])],
        "items": [to_public_word(word) for word in queue.get("items", [])],
    }


def to_public_stats(stats: dict) -> dict:
    """内部统计 → API 形状。"""
    return {
        "targetLang": stats.get("target_lang"),
        "now": stats.get("now"),
        "today": stats.get("today"),
        "dueToday": stats.get("due_today"),
        "dueNow": stats.get("due_now"),
        "reviewedToday": stats.get("reviewed_today"),
        "reviewedWordsToday": stats.get("reviewed_words_today"),
        "newWords": stats.get("new_words"),
        "newToday": stats.get("new_today"),
        "totalWords": stats.get("total_words"),
        "suspendedWords": stats.get("suspended_words"),
        "masteredWords": stats.get("mastered_words"),
        "streakDays": stats.get("streak_days"),
    }
