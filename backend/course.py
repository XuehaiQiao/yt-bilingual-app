"""课程垂直切片（specs/029 + 030）：课程包读取、尝试进度、判分与埋点。

课程内容有两种来源：

- **静态课程**：``content/course/*.json``（``config.COURSE_DIR`` 可覆盖），
  一课一个 JSON 包，schema 为 ``linguatrek.course-lesson.v1``。运行期读文件、
  做结构与题目校验；内容坏了抛 :class:`CourseUnavailable`（路由 503），不
  静默降级、不写文件。
- **用户生成课程**：``generated_courses`` 表（迁移 ``0022_generated_courses``）
  里当前用户的行，``lesson_json`` 同样是同一 schema。列表/详情/attempt 只认
  本人：别人的生成课程 id 与不存在一样返回 404（不泄露存在性）。

数据落三张表（运行时不建表）：

- ``course_attempts``：某用户对某课的一次尝试。同一用户同一课程最多一条
  ``in_progress``（部分唯一索引兜底）；``answers_json`` 只存首次答案，
  重复同 choice 幂等、换 choice 409；``complete`` 时按课程题目数计分。
- ``course_events``：append-only 埋点，为私测看流失用；payload 小对象 ≤2KB。
- ``generated_courses``：生成课程缓存（含答案，仅服务端用）；只读本人行。

安全与归属：

- 所有 attempt 查询都带 ``user_id``；别人的 attempt 一律 404，不泄露存在性；
- 生成课程按 ``owner_user_id`` 过滤，别人的课程 id 同样 404；
- lesson 详情**脱敏**：``questions`` / ``exitTicket`` 里只保留 ``id/prompt/options``，
  不下发 ``answer`` / ``explain``（step 级讲解 ``explain`` 是教学内容，保留）。

对外函数：

- :func:`list_lessons` / :func:`get_lesson`（静态 + 本人生成；脱敏）；
- :func:`start_attempt` / :func:`get_attempt`；
- :func:`answer_question` / :func:`update_step` / :func:`save_output`；
- :func:`complete_attempt` / :func:`record_event`。
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import config

logger = logging.getLogger("linguatrek.course")

SCHEMA = "linguatrek.course-lesson.v1"
SCHEMA_VERSION = 1

STATUS_IN_PROGRESS = "in_progress"
STATUS_COMPLETED = "completed"
STATUS_ABANDONED = "abandoned"
ATTEMPT_STATUSES = (STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_ABANDONED)

GENERATED_TABLE = "generated_courses"
GENERATED_ID_PREFIX = "gen-"
GENERATED_STATUS_READY = "ready"

EVENT_TYPES = frozenset(
    {
        "lesson_start",
        "step_view",
        "step_complete",
        "answer",
        "output_submit",
        "lesson_complete",
        "drop",
    }
)

STEP_TYPES = frozenset({"intro", "words", "read", "output"})
STEP_ID_RE = re.compile(r"^S\d{1,2}$")
MAX_OUTPUT_CHARS = 2000
MAX_EVENT_PAYLOAD_BYTES = 2048
MIN_OPTIONS = 2
MAX_OPTIONS = 6

COURSE_TABLES = ("course_attempts", "course_events")


# ---------------------------------------------------------------------------
# 错误类型（路由按类型映射 400/404/409/503）
# ---------------------------------------------------------------------------

class CourseError(Exception):
    """课程模块的领域错误基类。"""

    code = "course_error"


class InvalidRequest(CourseError):
    """参数/内容非法（路由 400）。"""

    code = "invalid_request"


class LessonNotFound(CourseError):
    """课程不存在（路由 404 ``lesson_not_found``）。"""

    code = "lesson_not_found"


class AttemptNotFound(CourseError):
    """attempt 不存在或属于别人（路由 404，不泄露存在性）。"""

    code = "attempt_not_found"


class CourseConflict(CourseError):
    """状态冲突（路由 409：已答过、已完成、未完成等）。"""

    code = "conflict"


class CourseUnavailable(CourseError):
    """课程包/数据库不可用（路由 503：内容损坏、缺表、未迁移）。"""

    code = "unavailable"


# ---------------------------------------------------------------------------
# 课程包模型与校验
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Question:
    """一道题（只含服务端判分需要的信息）。"""

    id: str
    step_id: str
    prompt: str
    options: tuple[str, ...]
    answer: str
    explain: str
    source: str  # "questions" 或 "exitTicket"


@dataclass(frozen=True)
class Lesson:
    """校验通过的课程包（``raw`` 保留完整内容供脱敏下发）。"""

    id: str
    version: int
    raw: dict
    step_ids: tuple[str, ...]
    first_step_id: str
    questions: tuple[Question, ...]
    questions_by_id: dict[str, Question] = field(default_factory=dict)


def _lesson_title(raw: dict, lesson_id: str) -> str:
    title = raw.get("title")
    return title.strip() if isinstance(title, str) and title.strip() else lesson_id


def _require_str(value: Any, where: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise CourseUnavailable(f"课程包字段非法：{where} 必须是字符串。")
    text = value.strip()
    if not text and not allow_empty:
        raise CourseUnavailable(f"课程包字段非法：{where} 不能为空。")
    return text


def _parse_steps(raw: dict, where: str) -> tuple[tuple[str, ...], list[dict]]:
    steps = raw.get("steps")
    if not isinstance(steps, list) or not steps:
        raise CourseUnavailable(f"课程包 {where} 的 steps 必须是非空数组。")

    step_ids: list[str] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise CourseUnavailable(f"课程包 {where} 的 steps[{index}] 必须是对象。")
        step_id = _require_str(step.get("id"), f"{where}.steps[{index}].id")
        if not STEP_ID_RE.match(step_id):
            raise CourseUnavailable(
                f"课程包 {where} 的步骤 id 非法：{step_id!r}（应形如 S0）。"
            )
        if step_id in step_ids:
            raise CourseUnavailable(f"课程包 {where} 的步骤 id 重复：{step_id}。")
        step_type = step.get("type")
        if step_type is not None and step_type not in STEP_TYPES:
            raise CourseUnavailable(
                f"课程包 {where} 的步骤 {step_id} 类型非法：{step_type!r}。"
            )
        step_ids.append(step_id)
    return tuple(step_ids), steps


def _parse_questions(
    items: Any, step_id: str, where: str, source: str
) -> list[Question]:
    if items is None:
        return []
    if not isinstance(items, list):
        raise CourseUnavailable(f"课程包 {where} 的 {source} 必须是数组。")

    questions: list[Question] = []
    for index, item in enumerate(items):
        label = f"{where}.{source}[{index}]"
        if not isinstance(item, dict):
            raise CourseUnavailable(f"课程包 {label} 必须是对象。")
        question_id = _require_str(item.get("id"), f"{label}.id")
        prompt = _require_str(item.get("prompt"), f"{label}.prompt")
        options_raw = item.get("options")
        if not isinstance(options_raw, list) or not (
            MIN_OPTIONS <= len(options_raw) <= MAX_OPTIONS
        ):
            raise CourseUnavailable(
                f"课程包 {label} 需要 {MIN_OPTIONS}–{MAX_OPTIONS} 个选项。"
            )
        options: list[str] = []
        for option_index, option in enumerate(options_raw):
            if not isinstance(option, dict):
                raise CourseUnavailable(f"课程包 {label}.options[{option_index}] 必须是对象。")
            option_id = _require_str(option.get("id"), f"{label}.options[{option_index}].id")
            _require_str(option.get("text"), f"{label}.options[{option_index}].text")
            if option_id in options:
                raise CourseUnavailable(f"课程包 {label} 的选项 id 重复：{option_id}。")
            options.append(option_id)
        answer = _require_str(item.get("answer"), f"{label}.answer")
        if answer not in options:
            raise CourseUnavailable(
                f"课程包 {label} 的 answer={answer!r} 不在选项 {options} 中。"
            )
        explain = item.get("explain")
        if explain is not None and not isinstance(explain, str):
            raise CourseUnavailable(f"课程包 {label}.explain 必须是字符串。")
        questions.append(
            Question(
                id=question_id,
                step_id=step_id,
                prompt=prompt,
                options=tuple(options),
                answer=answer,
                explain=(explain or "").strip(),
                source=source,
            )
        )
    return questions


def parse_lesson(raw: Any, where: str = "course") -> Lesson:
    """校验一个课程包对象；失败抛 :class:`CourseUnavailable`。"""
    if not isinstance(raw, dict):
        raise CourseUnavailable(f"课程包 {where} 根节点必须是对象。")
    if raw.get("schema") != SCHEMA:
        raise CourseUnavailable(
            f"课程包 {where} 的 schema 非法：{raw.get('schema')!r}（期望 {SCHEMA}）。"
        )
    lesson_id = _require_str(raw.get("id"), f"{where}.id")
    version = raw.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise CourseUnavailable(f"课程包 {where} 的 version 必须是 ≥1 的整数。")
    _lesson_title(raw, lesson_id)
    if raw.get("titleZh") is not None:
        _require_str(raw.get("titleZh"), f"{where}.titleZh")
    level = raw.get("level")
    if level is not None and not isinstance(level, str):
        raise CourseUnavailable(f"课程包 {where} 的 level 必须是字符串。")
    duration = raw.get("durationMinutes")
    if duration is not None and (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or duration <= 0
    ):
        raise CourseUnavailable(f"课程包 {where} 的 durationMinutes 必须是正数。")

    step_ids, steps = _parse_steps(raw, where)
    questions: list[Question] = []
    for step in steps:
        step_id = step["id"]
        questions.extend(
            _parse_questions(
                step.get("questions"), step_id, f"{where}.{step_id}", "questions"
            )
        )
        questions.extend(
            _parse_questions(
                step.get("exitTicket"), step_id, f"{where}.{step_id}", "exitTicket"
            )
        )
    # 兼容把 exitTicket 放在根节点的写法；步骤内是 MVP 内容的标准位置。
    questions.extend(
        _parse_questions(raw.get("exitTicket"), "S5", where, "exitTicket")
    )
    if not questions:
        raise CourseUnavailable(f"课程包 {where} 没有任何题目，无法计分。")

    seen: dict[str, Question] = {}
    for question in questions:
        if question.id in seen:
            raise CourseUnavailable(f"课程包 {where} 的题目 id 重复：{question.id}。")
        seen[question.id] = question

    return Lesson(
        id=lesson_id,
        version=version,
        raw=raw,
        step_ids=step_ids,
        first_step_id=step_ids[0],
        questions=tuple(questions),
        questions_by_id=seen,
    )


def _course_dir() -> str:
    return config.COURSE_DIR


def _load_static_lessons() -> dict[str, Lesson]:
    """读取并校验 ``COURSE_DIR`` 下全部 ``*.json``；一台坏包整体 503。"""
    directory = _course_dir()
    if not os.path.isdir(directory):
        raise CourseUnavailable(
            f"课程内容目录不存在：{directory}（需要随仓库分发 content/course/）。"
        )
    lessons: dict[str, Lesson] = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, encoding="utf-8") as handle:
                raw = json.load(handle)
        except OSError as exc:
            raise CourseUnavailable(f"课程包读取失败：{path}：{exc}") from exc
        except ValueError as exc:
            raise CourseUnavailable(f"课程包不是合法 JSON：{path}：{exc}") from exc
        lesson = parse_lesson(raw, where=path)
        if lesson.id in lessons:
            raise CourseUnavailable(f"课程包 id 重复：{lesson.id}（{path}）。")
        lessons[lesson.id] = lesson
    if not lessons:
        raise CourseUnavailable(f"课程内容目录里没有课程包：{directory}。")
    return lessons


def _decode_generated_lesson(row: sqlite3.Row) -> Lesson:
    """把 ``generated_courses.lesson_json`` 解析成校验通过的课程包。"""
    try:
        raw = json.loads(row["lesson_json"] or "")
    except (TypeError, ValueError) as exc:
        raise CourseUnavailable(
            f"生成课程数据损坏（{row['id']}）：lesson_json 不是合法 JSON。"
        ) from exc
    lesson = parse_lesson(raw, where=f"{GENERATED_TABLE}:{row['id']}")
    if lesson.id != row["id"]:
        raise CourseUnavailable(
            f"生成课程数据损坏（{row['id']}）：lesson_json 内 id={lesson.id!r} 不一致。"
        )
    return lesson


def _load_generated_lessons(user_id: str | None, *, required: bool) -> dict[str, Lesson]:
    """读当前用户全部生成课程；列表场景表缺失时静默降级为只看静态课程。"""
    if not user_id:
        return {}
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        if required:
            raise CourseUnavailable(
                f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
            )
        return {}
    try:
        conn = _connect()
    except CourseUnavailable:
        if required:
            raise
        return {}
    try:
        if GENERATED_TABLE not in _table_names(conn):
            if required:
                raise CourseUnavailable(
                    f"数据库缺少表 {GENERATED_TABLE}（先运行 alembic upgrade head；"
                    "生成课程需要 0022_generated_courses 迁移）。"
                )
            return {}
        rows = conn.execute(
            f"SELECT * FROM {GENERATED_TABLE} "
            "WHERE owner_user_id = ? AND status = ? "
            "ORDER BY created_at ASC, id ASC",
            (user_id, GENERATED_STATUS_READY),
        ).fetchall()
        return {row["id"]: _decode_generated_lesson(row) for row in rows}
    except sqlite3.OperationalError as exc:
        if required:
            raise CourseUnavailable(
                f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
            ) from exc
        logger.warning("读取生成课程失败（已降级为只看静态课程）：%s", exc)
        return {}
    finally:
        conn.close()


def _load_generated_lesson(lesson_id: str, user_id: str | None) -> Lesson | None:
    """按 id + 归属取一条生成课程；别人的行与不存在等价（返回 None）。"""
    if not user_id:
        return None
    conn = _connect()
    try:
        if GENERATED_TABLE not in _table_names(conn):
            raise CourseUnavailable(
                f"数据库缺少表 {GENERATED_TABLE}（先运行 alembic upgrade head；"
                "生成课程需要 0022_generated_courses 迁移）。"
            )
        row = conn.execute(
            f"SELECT * FROM {GENERATED_TABLE} "
            "WHERE id = ? AND owner_user_id = ? AND status = ?",
            (lesson_id, user_id, GENERATED_STATUS_READY),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()
    return _decode_generated_lesson(row) if row is not None else None


def load_lessons(user_id: str | None = None) -> dict[str, Lesson]:
    """静态课程 + 当前用户生成课程；``user_id`` 缺省只看静态课程。"""
    lessons = _load_static_lessons()
    for lesson_id, lesson in _load_generated_lessons(
        user_id, required=False
    ).items():
        if lesson_id in lessons:
            raise CourseUnavailable(f"课程包 id 与生成课程冲突：{lesson_id}。")
        lessons[lesson_id] = lesson
    return lessons


def _get_lesson(lesson_id: str, user_id: str | None = None) -> Lesson:
    lesson = _load_static_lessons().get(lesson_id)
    if lesson is not None:
        return lesson
    if lesson_id.startswith(GENERATED_ID_PREFIX):
        generated = _load_generated_lesson(lesson_id, user_id)
        if generated is not None:
            return generated
    raise LessonNotFound(f"lesson_not_found：课程不存在（{lesson_id}）。")


def _attempt_lesson(lesson_id: str, user_id: str | None = None) -> Lesson:
    """attempt 指向的课程必须仍然存在且属于本人；已下架按 404 处理。"""
    lesson = _load_static_lessons().get(lesson_id)
    if lesson is not None:
        return lesson
    if lesson_id.startswith(GENERATED_ID_PREFIX):
        generated = _load_generated_lesson(lesson_id, user_id)
        if generated is not None:
            return generated
    raise LessonNotFound(f"lesson_not_found：课程内容已不存在（{lesson_id}）。")


# ---------------------------------------------------------------------------
# 脱敏视图
# ---------------------------------------------------------------------------

def _sanitize_questions(items: Any) -> None:
    """原地删除题目里的 ``answer`` / ``explain``（只保留 id/prompt/options 等）。"""
    if not isinstance(items, list):
        return
    for item in items:
        if isinstance(item, dict):
            item.pop("answer", None)
            item.pop("explain", None)


def sanitized_lesson(lesson: Lesson) -> dict:
    """课程详情脱敏：题目不下发答案与解析；step 级 explain 保留。"""
    payload = copy.deepcopy(lesson.raw)
    for step in payload.get("steps") or []:
        if isinstance(step, dict):
            _sanitize_questions(step.get("questions"))
            _sanitize_questions(step.get("exitTicket"))
    _sanitize_questions(payload.get("exitTicket"))
    return payload


def lesson_meta(lesson: Lesson) -> dict:
    """课程列表条目（只给元数据，不下发正文）。"""
    raw = lesson.raw
    generated = lesson.id.startswith(GENERATED_ID_PREFIX)
    meta = {
        "id": lesson.id,
        "title": _lesson_title(raw, lesson.id),
        "titleZh": raw.get("titleZh") or _lesson_title(raw, lesson.id),
        "level": raw.get("level") or "",
        "durationMinutes": raw.get("durationMinutes") or 0,
        "status": raw.get("status") or "draft",
        "version": lesson.version,
        "generated": generated,
    }
    if generated:
        source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
        meta["sourceKind"] = source.get("kind") or ""
        meta["sourceRef"] = source.get("sourceRef") or ""
    return meta


# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def _connect() -> sqlite3.Connection:
    """连库（不建库、不建目录：schema 只由迁移创建）。"""
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        raise CourseUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise CourseUnavailable(f"课程数据库不可用：{exc}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _require_tables(conn: sqlite3.Connection) -> None:
    missing = [table for table in COURSE_TABLES if table not in _table_names(conn)]
    if missing:
        raise CourseUnavailable(
            f"数据库缺少表 {missing}（先运行 alembic upgrade head；"
            "课程 MVP 需要 0021_course_mvp 迁移）。"
        )


def _attempt_row(
    conn: sqlite3.Connection, attempt_id: str, user_id: str
) -> sqlite3.Row | None:
    """只看本人的 attempt；别人的 id 与不存在等价（不泄露存在性）。"""
    return conn.execute(
        "SELECT * FROM course_attempts WHERE id = ? AND user_id = ?",
        (attempt_id, user_id),
    ).fetchone()


def _require_attempt(
    conn: sqlite3.Connection, attempt_id: str, user_id: str
) -> sqlite3.Row:
    _require_tables(conn)
    row = _attempt_row(conn, attempt_id, user_id)
    if row is None:
        raise AttemptNotFound("attempt_not_found：课程进度不存在。")
    return row


def _decode_answers(row: sqlite3.Row) -> dict[str, str]:
    try:
        answers = json.loads(row["answers_json"] or "{}")
    except (TypeError, ValueError) as exc:
        raise CourseUnavailable("课程进度数据损坏：answers_json 不是合法 JSON。") from exc
    if not isinstance(answers, dict):
        raise CourseUnavailable("课程进度数据损坏：answers_json 必须是对象。")
    clean: dict[str, str] = {}
    for key, value in answers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise CourseUnavailable("课程进度数据损坏：answers_json 必须是字符串映射。")
        clean[key] = value
    return clean


def _attempt_base(row: sqlite3.Row, lesson: Lesson, *, resumed: bool) -> dict:
    return {
        "attemptId": row["id"],
        "lesson": sanitized_lesson(lesson),
        "status": row["status"],
        "currentStepId": row["current_step_id"],
        "answers": _decode_answers(row),
        "output": row["output_text"] or "",
        "startedAt": int(row["started_at"]),
        "resumed": resumed,
    }


def _completed_payload(row: sqlite3.Row, lesson: Lesson) -> dict:
    answers = _decode_answers(row)
    return {
        "score": int(row["score"]) if row["score"] is not None else 0,
        "total": (
            int(row["total"]) if row["total"] is not None else len(lesson.questions)
        ),
        "answers": [
            {
                "questionId": question.id,
                "choice": answers.get(question.id),
                "correct": answers.get(question.id) == question.answer,
            }
            for question in lesson.questions
        ],
        "output": row["output_text"] or "",
        "completedAt": row["completed_at"],
    }


# ---------------------------------------------------------------------------
# 对外：课程读取
# ---------------------------------------------------------------------------

def list_lessons(user_id: str | None = None) -> dict:
    """静态课程 + 当前用户生成课程（静态在前），只给元数据。"""
    lessons = load_lessons(user_id)
    ordered = sorted(
        lessons.values(),
        key=lambda item: (item.id.startswith(GENERATED_ID_PREFIX), item.id),
    )
    return {"lessons": [lesson_meta(lesson) for lesson in ordered]}


def get_lesson(lesson_id: str, user_id: str | None = None) -> dict:
    lesson_id = (lesson_id or "").strip()
    if not lesson_id:
        raise InvalidRequest("lesson_not_found：缺少课程 id。")
    return sanitized_lesson(_get_lesson(lesson_id, user_id))


# ---------------------------------------------------------------------------
# 对外：attempt
# ---------------------------------------------------------------------------

def start_attempt(user_id: str, lesson_id: str) -> dict:
    """开始/恢复一次课程尝试：同一用户同一课程复用唯一 in_progress。"""
    if not user_id:
        raise InvalidRequest("缺少用户身份。")
    lesson_id = (lesson_id or "").strip()
    if not lesson_id:
        raise InvalidRequest("lessonId 不能为空。")
    # 先校验课程包：课程坏了不落一条永远无法推进的 attempt。
    lesson = _get_lesson(lesson_id, user_id)

    stamp = now_ms()
    conn = _connect()
    try:
        _require_tables(conn)
        row = conn.execute(
            "SELECT * FROM course_attempts "
            "WHERE user_id = ? AND lesson_id = ? AND status = ?",
            (user_id, lesson_id, STATUS_IN_PROGRESS),
        ).fetchone()
        resumed = row is not None
        if row is None:
            attempt_id = uuid.uuid4().hex
            try:
                with conn:
                    conn.execute(
                        "INSERT INTO course_attempts "
                        "(id, user_id, lesson_id, lesson_version, status, "
                        " current_step_id, answers_json, output_text, "
                        " started_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, '{}', '', ?, ?)",
                        (
                            attempt_id,
                            user_id,
                            lesson_id,
                            lesson.version,
                            STATUS_IN_PROGRESS,
                            lesson.first_step_id,
                            stamp,
                            stamp,
                        ),
                    )
            except sqlite3.IntegrityError:
                # 并发 start：另一个请求已建了 in_progress，直接复用。
                row = conn.execute(
                    "SELECT * FROM course_attempts "
                    "WHERE user_id = ? AND lesson_id = ? AND status = ?",
                    (user_id, lesson_id, STATUS_IN_PROGRESS),
                ).fetchone()
                if row is None:
                    raise
                resumed = True
            else:
                row = conn.execute(
                    "SELECT * FROM course_attempts WHERE id = ? AND user_id = ?",
                    (attempt_id, user_id),
                ).fetchone()
                if row is None:  # pragma: no cover - 插后即查，理论不可达
                    raise CourseConflict("课程进度创建失败，请重试。")
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    return _attempt_base(row, lesson, resumed=resumed)


def get_attempt(user_id: str, attempt_id: str) -> dict:
    lesson_cache: dict[str, Lesson] = {}
    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        lesson = lesson_cache.get(row["lesson_id"])
        if lesson is None:
            lesson = _attempt_lesson(row["lesson_id"], user_id)
            lesson_cache[row["lesson_id"]] = lesson
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    payload = _attempt_base(row, lesson, resumed=False)
    payload.update(
        {
            "score": row["score"],
            "total": row["total"],
            "completedAt": row["completed_at"],
        }
    )
    return payload


# ---------------------------------------------------------------------------
# 对外：作答 / 步骤 / 产出 / 完成
# ---------------------------------------------------------------------------

def answer_question(
    user_id: str, attempt_id: str, question_id: str, choice: str
) -> dict:
    """记录首次答案；重复同 choice 幂等，换 choice 409，题目/选项非法 400。"""
    question_id = (question_id or "").strip()
    if not question_id:
        raise InvalidRequest("questionId 不能为空。")
    choice = (choice or "").strip()
    if not choice:
        raise InvalidRequest("choice 不能为空。")

    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        if row["status"] != STATUS_IN_PROGRESS:
            raise CourseConflict(f"attempt_completed：课程已{('完成' if row['status'] == STATUS_COMPLETED else '结束')}，不能再作答。")
        lesson = _attempt_lesson(row["lesson_id"], user_id)
        question = lesson.questions_by_id.get(question_id)
        if question is None:
            raise InvalidRequest(f"question_not_found：题目不存在（{question_id}）。")
        if choice not in question.options:
            if choice.upper() in question.options:
                choice = choice.upper()
            else:
                raise InvalidRequest(f"invalid_choice：选项非法（{choice}）。")

        stamp = now_ms()
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = _attempt_row(conn, attempt_id, user_id)
            if current is None:
                raise AttemptNotFound("attempt_not_found：课程进度不存在。")
            if current["status"] != STATUS_IN_PROGRESS:
                raise CourseConflict("attempt_completed：课程已结束，不能再作答。")
            answers = _decode_answers(current)
            previous = answers.get(question_id)
            if previous is not None:
                if previous != choice:
                    raise CourseConflict(
                        "answer_locked：该题已作答，不能修改答案。"
                    )
                conn.rollback()
            else:
                answers[question_id] = choice
                conn.execute(
                    "UPDATE course_attempts "
                    "SET answers_json = ?, updated_at = ? "
                    "WHERE id = ? AND user_id = ? AND status = ?",
                    (
                        json.dumps(answers, ensure_ascii=False, sort_keys=True),
                        stamp,
                        attempt_id,
                        user_id,
                        STATUS_IN_PROGRESS,
                    ),
                )
                conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except sqlite3.Error:
                pass
            raise
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    return {
        "questionId": question.id,
        "choice": choice,
        "correct": choice == question.answer,
        "correctChoice": question.answer,
        "explanation": question.explain,
    }


def update_step(user_id: str, attempt_id: str, step_id: str) -> dict:
    """更新 current_step_id；非法步骤 400，完成后 409。"""
    step_id = (step_id or "").strip()
    if not step_id:
        raise InvalidRequest("stepId 不能为空。")

    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        if row["status"] != STATUS_IN_PROGRESS:
            raise CourseConflict("attempt_completed：课程已结束，不能更新步骤。")
        lesson = _attempt_lesson(row["lesson_id"], user_id)
        if step_id not in lesson.step_ids:
            raise InvalidRequest(f"invalid_step：步骤非法（{step_id}）。")
        stamp = now_ms()
        with conn:
            cursor = conn.execute(
                "UPDATE course_attempts SET current_step_id = ?, updated_at = ? "
                "WHERE id = ? AND user_id = ? AND status = ?",
                (step_id, stamp, attempt_id, user_id, STATUS_IN_PROGRESS),
            )
        if cursor.rowcount == 0:
            current = _attempt_row(conn, attempt_id, user_id)
            if current is None:
                raise AttemptNotFound("attempt_not_found：课程进度不存在。")
            raise CourseConflict("attempt_completed：课程已结束，不能更新步骤。")
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    return {"attemptId": attempt_id, "currentStepId": step_id, "updatedAt": stamp}


def save_output(user_id: str, attempt_id: str, text: str) -> dict:
    """保存 S5 产出；服务端按空白切分算 wordCount，最长 2000 字符。"""
    if not isinstance(text, str):
        raise InvalidRequest("text 必须是字符串。")
    if len(text) > MAX_OUTPUT_CHARS:
        raise InvalidRequest(
            f"output_too_long：产出最长 {MAX_OUTPUT_CHARS} 字符（当前 {len(text)}）。"
        )

    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        if row["status"] != STATUS_IN_PROGRESS:
            raise CourseConflict("attempt_completed：课程已结束，不能保存产出。")
        stamp = now_ms()
        with conn:
            cursor = conn.execute(
                "UPDATE course_attempts SET output_text = ?, updated_at = ? "
                "WHERE id = ? AND user_id = ? AND status = ?",
                (text, stamp, attempt_id, user_id, STATUS_IN_PROGRESS),
            )
        if cursor.rowcount == 0:
            current = _attempt_row(conn, attempt_id, user_id)
            if current is None:
                raise AttemptNotFound("attempt_not_found：课程进度不存在。")
            raise CourseConflict("attempt_completed：课程已结束，不能保存产出。")
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    return {
        "attemptId": attempt_id,
        "text": text,
        "output": text,
        "wordCount": len(text.split()),
        "updatedAt": stamp,
    }


def complete_attempt(user_id: str, attempt_id: str) -> dict:
    """全部题已答 + 产出非空才可完成；按课程题目数评分，重复完成幂等。"""
    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        lesson = _attempt_lesson(row["lesson_id"], user_id)
        if row["status"] == STATUS_COMPLETED:
            return _completed_payload(row, lesson)
        if row["status"] != STATUS_IN_PROGRESS:
            raise CourseConflict("attempt_closed：课程已结束。")

        answers = _decode_answers(row)
        missing = [
            question.id for question in lesson.questions if question.id not in answers
        ]
        output = row["output_text"] or ""
        if missing or not output.strip():
            raise CourseConflict(
                "incomplete：还有题目未作答或产出为空，不能完成课程。"
            )

        score = sum(
            1 for question in lesson.questions if answers.get(question.id) == question.answer
        )
        total = len(lesson.questions)
        stamp = now_ms()
        with conn:
            cursor = conn.execute(
                "UPDATE course_attempts "
                "SET status = ?, score = ?, total = ?, completed_at = ?, updated_at = ? "
                "WHERE id = ? AND user_id = ? AND status = ?",
                (
                    STATUS_COMPLETED,
                    score,
                    total,
                    stamp,
                    stamp,
                    attempt_id,
                    user_id,
                    STATUS_IN_PROGRESS,
                ),
            )
        if cursor.rowcount == 0:
            current = _attempt_row(conn, attempt_id, user_id)
            if current is None:
                raise AttemptNotFound("attempt_not_found：课程进度不存在。")
            if current["status"] == STATUS_COMPLETED:
                return _completed_payload(current, lesson)
            raise CourseConflict("attempt_closed：课程已结束。")
        row = _attempt_row(conn, attempt_id, user_id)
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    return _completed_payload(row, lesson)


# ---------------------------------------------------------------------------
# 对外：埋点
# ---------------------------------------------------------------------------

def record_event(
    user_id: str,
    attempt_id: str,
    event: str,
    step_id: str | None = None,
    payload: Any = None,
) -> None:
    """写入一条课程埋点；非法 event/步骤/payload（>2KB）一律 400。"""
    event = (event or "").strip()
    if event not in EVENT_TYPES:
        raise InvalidRequest(f"invalid_event：不支持的事件类型（{event or '空'}）。")

    conn = _connect()
    try:
        row = _require_attempt(conn, attempt_id, user_id)
        lesson = _attempt_lesson(row["lesson_id"], user_id)

        step_id = (step_id or "").strip() or None
        if step_id is not None and step_id not in lesson.step_ids:
            raise InvalidRequest(f"invalid_step：步骤非法（{step_id}）。")

        encoded: str | None = None
        if payload is not None:
            if not isinstance(payload, dict):
                raise InvalidRequest("invalid_payload：payload 必须是 JSON 对象。")
            try:
                encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            except (TypeError, ValueError) as exc:
                raise InvalidRequest("invalid_payload：payload 不是合法 JSON。") from exc
            if len(encoded.encode("utf-8")) > MAX_EVENT_PAYLOAD_BYTES:
                raise InvalidRequest(
                    f"payload_too_large：事件 payload 不能超过 "
                    f"{MAX_EVENT_PAYLOAD_BYTES} 字节。"
                )

        with conn:
            conn.execute(
                "INSERT INTO course_events "
                "(attempt_id, user_id, event, step_id, payload_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (attempt_id, user_id, event, step_id, encoded, now_ms()),
            )
    except sqlite3.OperationalError as exc:
        raise CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()
