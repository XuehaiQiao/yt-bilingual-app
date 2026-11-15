"""考试练习（V2 用户需求 #11 / specs/022）。

用户选一套「CET-4 风格练习」题库：每次从 30 道自编题里抽 10 道（词汇 5 +
语法 2 + 阅读 3），提交后只看**逐题对错 + 正确答案 + 解析**。本模块刻意不计算
也不返回任何成绩/预测/通过口径，题库是静态 JSON，不是真题。

设计要点（规格见 ``specs/022-exam-practice/spec.md``）：

- **题库只读**：``content/exam/cet4.json``（30 题 = 15 词汇 + 5 语法 + 10 阅读，
  3 段短文每段 3–4 题），启动后懒加载并做结构校验；文件缺失/损坏/未标
  「草稿，待教研审校」抛 :class:`ExamUnavailable`（路由 503）。
- **会话保存卷面**：``exam_sessions.item_ids`` 存本次抽到的题库 id（JSON、保序），
  ``exam_answers`` 只存**已作答**的题；未答题由卷面与作答之差得出，响应里标
  ``answered=false``。不存题干/答案/结果，重复提交按题库 + 作答行重建同一份结果。
- **未提交会话复用**：同一用户存在 ``in_progress`` 会话时，``start`` 返回同一
  sessionId 与同一卷面（``resumed=true``）；部分唯一索引兜底并发。
- **幂等提交**：同一 sessionId 重复提交直接返回首次结果（``reused=true``），
  不重复写答案、不重复发 ``exam_submit`` 事件；提交成功后状态不可变。
- **不报分**：对外只有 ``correct`` / ``total`` / ``answered`` / ``unanswered``
  与逐题对错；没有 score、predictedScore、passRate 等字段。
- **归属**：考试练习需登录，归属 ``users.id``；游客在路由层 403（与复习/理解题/
  读文章一致）。越权读取/提交别人的会话返回 404，不泄露存在性。
- **事件**：新建会话写 ``exam_start``，首次提交写 ``exam_submit``，payload 只含
  题型/题数/答对数/用时，供周报与画像后续聚合使用；本模块不改 placement 画像。

表由 ``0012_exam`` 迁移创建，运行时不建表；表缺失抛 :class:`ExamUnavailable`
（路由 503）。
"""
from __future__ import annotations

import json
import logging
import os
import random
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

import config
import events

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量（规格冻结；改这些值要同步 specs/022 与测试）
# ---------------------------------------------------------------------------

EXAM_TYPE_CET4 = "cet4"
BANK_FILENAME = "cet4.json"
SUPPORTED_TYPES: tuple[str, ...] = (EXAM_TYPE_CET4,)

EXAM_SIZE = 10
# 每次练习的题型配额：与题库总量（15/5/10）解耦，改题库时不必改抽题逻辑。
SESSION_QUOTAS: dict[str, int] = {"vocab": 5, "grammar": 2, "reading": 3}
ITEM_TYPES: tuple[str, ...] = ("vocab", "grammar", "reading")

CEFR_BANDS: tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")
ITEMS_PER_TYPE: dict[str, int] = {"vocab": 15, "grammar": 5, "reading": 10}
TOTAL_ITEMS = sum(ITEMS_PER_TYPE.values())  # 30
READING_PASSAGES = 3
QUESTIONS_PER_PASSAGE = (3, 4)

SESSION_STATUSES: tuple[str, ...] = ("in_progress", "submitted")
MAX_DURATION_MS = 24 * 60 * 60 * 1000
HISTORY_DEFAULT_LIMIT = 20
HISTORY_MAX_LIMIT = 100

EXAM_TABLES: tuple[str, ...] = ("exam_sessions", "exam_answers")

TYPE_LABEL = "CET-4 风格练习"
TYPE_DESCRIPTION = "从 30 道自编题中抽 10 题（词汇 5 + 语法 2 + 阅读 3）；提交后看逐题对错与解析。"
DISCLAIMER = "自编题，非真题；只做题型练习，不报分、不预测成绩。"


# ---------------------------------------------------------------------------
# 异常（路由映射：Unavailable→503 / NotFound→404 / Conflict→409 / Invalid→400）
# ---------------------------------------------------------------------------

class ExamError(Exception):
    """考试练习领域错误基类。"""


class ExamUnavailable(ExamError):
    """题库或数据库表不可用（未跑 0012 迁移 / 题库损坏）。"""


class ExamInvalid(ExamError):
    """请求参数或会话内容非法。"""


class ExamNotFound(ExamError):
    """会话不存在，或不属于当前用户（不泄露存在性）。"""


class ExamConflict(ExamError):
    """会话状态已变化（并发提交/已有其他类型会话）。"""


# ---------------------------------------------------------------------------
# 题库模型与加载
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Passage:
    """一段阅读短文。"""

    id: str
    title: str
    text: str


@dataclass(frozen=True)
class Item:
    """一道题（内部模型；正确项与解析只留在服务端）。"""

    id: str
    type: str
    band: str
    topic: str
    prompt: str
    options: tuple[str, ...]
    answer_index: int
    explanation: str
    passage_id: str | None = None


@dataclass(frozen=True)
class Bank:
    """一份只读题库（顶层 meta + 3 段短文 + 30 题）。"""

    meta: dict
    passages: tuple[Passage, ...]
    items: tuple[Item, ...]

    @property
    def label(self) -> str:
        title = self.meta.get("label") if isinstance(self.meta, dict) else None
        return title.strip() if isinstance(title, str) and title.strip() else TYPE_LABEL

    @property
    def items_by_id(self) -> dict[str, Item]:
        return {item.id: item for item in self.items}

    @property
    def passages_by_id(self) -> dict[str, Passage]:
        return {passage.id: passage for passage in self.passages}

    def items_of_type(self, item_type: str) -> tuple[Item, ...]:
        return tuple(item for item in self.items if item.type == item_type)


def load_bank() -> Bank:
    """加载并缓存 ``config.EXAM_DIR/cet4.json``（按绝对路径缓存）。"""
    return _load_bank(os.path.abspath(config.EXAM_DIR))


@lru_cache(maxsize=4)
def _load_bank(directory: str) -> Bank:
    """读题库并校验结构与题目契约；失败抛 ExamUnavailable（路由 503）。"""
    path = os.path.join(directory, BANK_FILENAME)
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError as exc:
        raise ExamUnavailable(
            f"考试练习题库文件不存在：{path}（content/exam/ 应随仓库分发）"
        ) from exc
    except (OSError, ValueError) as exc:
        raise ExamUnavailable(f"考试练习题库读取失败：{path}：{exc}") from exc

    if not isinstance(payload, dict):
        raise ExamUnavailable(f"考试练习题库根节点必须是对象：{path}")

    meta = payload.get("_meta")
    if not isinstance(meta, dict):
        raise ExamUnavailable(f"考试练习题库缺少 _meta：{path}")
    notice = str(meta.get("notice") or "")
    if "待教研审校" not in notice:
        # 未标草稿的题库不允许直接上线：这是内容安全/效度闸门，不是格式检查。
        raise ExamUnavailable(f"考试练习题库未标「草稿，待教研审校」：{path}")
    declared = meta.get("itemCount")
    if declared is not None and declared != TOTAL_ITEMS:
        raise ExamUnavailable(
            f"考试练习题库 _meta.itemCount 应为 {TOTAL_ITEMS}，实际 {declared!r}：{path}"
        )

    raw_passages = payload.get("passages")
    if not isinstance(raw_passages, list):
        raise ExamUnavailable(f"考试练习题库 passages 必须是数组：{path}")
    if len(raw_passages) != READING_PASSAGES:
        raise ExamUnavailable(
            f"考试练习题库应有 {READING_PASSAGES} 段阅读短文，实际 "
            f"{len(raw_passages)}：{path}"
        )
    passages = tuple(
        _parse_passage(raw, path, index) for index, raw in enumerate(raw_passages)
    )
    passage_ids = {passage.id for passage in passages}
    if len(passage_ids) != len(passages):
        raise ExamUnavailable(f"考试练习题库 passage id 重复：{path}")

    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise ExamUnavailable(f"考试练习题库 items 必须是数组：{path}")
    if len(raw_items) != TOTAL_ITEMS:
        raise ExamUnavailable(
            f"考试练习题库应有 {TOTAL_ITEMS} 道题，实际 {len(raw_items)}：{path}"
        )

    items = tuple(
        _parse_item(raw, path, index) for index, raw in enumerate(raw_items)
    )
    seen: set[str] = set()
    for item in items:
        if item.id in seen:
            raise ExamUnavailable(f"考试练习题库 id 重复：{item.id}")
        seen.add(item.id)

    counts = {item_type: 0 for item_type in ITEM_TYPES}
    for item in items:
        counts[item.type] += 1
    for item_type, expected in ITEMS_PER_TYPE.items():
        if counts[item_type] != expected:
            raise ExamUnavailable(
                f"考试练习题库 {item_type} 数量应为 {expected}，实际 "
                f"{counts[item_type]}：{path}"
            )

    for item in items:
        if item.type != "reading":
            continue
        if item.passage_id not in passage_ids:
            raise ExamUnavailable(
                f"考试练习题库 {item.id} 的 passageId 不存在：{item.passage_id!r}"
            )
    for passage in passages:
        count = sum(1 for item in items if item.passage_id == passage.id)
        low, high = QUESTIONS_PER_PASSAGE
        if not low <= count <= high:
            raise ExamUnavailable(
                f"考试练习题库短文 {passage.id} 应有 {low}–{high} 道阅读题，"
                f"实际 {count}"
            )

    return Bank(meta=meta, passages=passages, items=items)


def _parse_passage(raw, path: str, index: int) -> Passage:
    where = f"{path} passages[{index}]"
    if not isinstance(raw, dict):
        raise ExamUnavailable(f"{where} 必须是对象")
    passage_id = raw.get("id")
    title = raw.get("title")
    text = raw.get("text")
    if not isinstance(passage_id, str) or not passage_id.strip():
        raise ExamUnavailable(f"{where} 缺少 id")
    if not isinstance(title, str) or not title.strip():
        raise ExamUnavailable(f"{where} 缺少 title")
    if not isinstance(text, str) or len(text.strip()) < 80:
        raise ExamUnavailable(f"{where} 的 text 太短或缺失")
    return Passage(
        id=passage_id.strip(), title=title.strip(), text=text.strip()
    )


def _parse_item(raw, path: str, index: int) -> Item:
    where = f"{path} items[{index}]"
    if not isinstance(raw, dict):
        raise ExamUnavailable(f"{where} 必须是对象")

    item_id = raw.get("id")
    item_type = raw.get("type")
    band = raw.get("band")
    topic = raw.get("topic")
    prompt = raw.get("prompt")
    options = raw.get("options")
    explanation = raw.get("explanation")

    if not isinstance(item_id, str) or not item_id.strip():
        raise ExamUnavailable(f"{where} 缺少 id")
    if item_type not in ITEM_TYPES:
        raise ExamUnavailable(f"{where} 题型非法：{item_type!r}")
    if band not in CEFR_BANDS:
        raise ExamUnavailable(f"{where} 难度带非法：{band!r}")
    if not isinstance(topic, str) or not topic.strip():
        raise ExamUnavailable(f"{where} 缺少 topic")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ExamUnavailable(f"{where} 缺少 prompt")
    if (
        not isinstance(options, list)
        or len(options) != 4
        or not all(isinstance(option, str) and option.strip() for option in options)
    ):
        raise ExamUnavailable(f"{where} 需要 4 个非空选项")
    if len({option.strip() for option in options}) != 4:
        raise ExamUnavailable(f"{where} 选项重复")
    if not isinstance(explanation, str) or not explanation.strip():
        raise ExamUnavailable(f"{where} 缺少 explanation")

    answer_index = raw.get("answerIndex")
    if (
        isinstance(answer_index, bool)
        or not isinstance(answer_index, int)
        or not 0 <= answer_index <= 3
    ):
        raise ExamUnavailable(f"{where} answerIndex 必须是 0–3 的整数")

    passage_id = raw.get("passageId")
    if item_type == "reading":
        if not isinstance(passage_id, str) or not passage_id.strip():
            raise ExamUnavailable(f"{where} 阅读题缺少 passageId")
        passage_id = passage_id.strip()
    else:
        passage_id = None

    return Item(
        id=item_id.strip(),
        type=item_type,
        band=band,
        topic=topic.strip(),
        prompt=prompt.strip(),
        options=tuple(option.strip() for option in options),
        answer_index=answer_index,
        explanation=explanation.strip(),
        passage_id=passage_id,
    )


# ---------------------------------------------------------------------------
# 抽题（确定性：同一 sessionId 重算同一份卷）
# ---------------------------------------------------------------------------

def sample_items(session_id: str) -> list[Item]:
    """按 sessionId 确定性抽 10 题并打乱：词汇 5 + 语法 2 + 阅读 3。"""
    bank = load_bank()
    rng = random.Random(f"exam.serve.v1:{session_id}")

    picks: list[Item] = []
    for item_type in ("vocab", "grammar"):
        pool = list(bank.items_of_type(item_type))
        take = SESSION_QUOTAS[item_type]
        picks.extend(rng.sample(pool, take))

    # 阅读题按短文抽：尽量让 3 段短文都出现，每段抽 1 题。
    passages = list(bank.passages)
    rng.shuffle(passages)
    for passage in passages[: SESSION_QUOTAS["reading"]]:
        pool = [item for item in bank.items if item.passage_id == passage.id]
        picks.append(rng.choice(pool))

    if len(picks) != EXAM_SIZE:
        raise ExamUnavailable("考试练习抽题数量异常，请检查题库。")
    rng.shuffle(picks)
    return picks


# ---------------------------------------------------------------------------
# 对外视图
# ---------------------------------------------------------------------------

def _public_item(item: Item, bank: Bank) -> dict:
    """下发一道题：题干/选项/短文，**绝不含 answerIndex 与 explanation**。"""
    payload = {
        "itemId": item.id,
        "type": item.type,
        "band": item.band,
        "topic": item.topic,
        "prompt": item.prompt,
        "options": list(item.options),
    }
    if item.passage_id:
        passage = bank.passages_by_id[item.passage_id]
        payload["passage"] = {
            "id": passage.id,
            "title": passage.title,
            "text": passage.text,
        }
    return payload


def _type_totals(items) -> dict:
    counts = {item_type: 0 for item_type in ITEM_TYPES}
    for item in items:
        counts[item.type] += 1
    return {**counts, "all": len(items)}


def _session_items(row: sqlite3.Row, bank: Bank) -> list[Item]:
    """按会话里保存的 item_ids 重建卷面；题库变动导致缺题时 503，不静默改卷。"""
    try:
        item_ids = json.loads(row["item_ids"] or "[]")
    except (TypeError, ValueError) as exc:
        raise ExamUnavailable("考试练习会话的卷面数据损坏。") from exc
    if not isinstance(item_ids, list) or len(item_ids) != EXAM_SIZE:
        raise ExamUnavailable("考试练习会话的卷面题数异常。")
    if not all(isinstance(item_id, str) and item_id for item_id in item_ids):
        raise ExamUnavailable("考试练习会话的卷面数据损坏。")
    if len(set(item_ids)) != len(item_ids):
        raise ExamUnavailable("考试练习会话的卷面存在重复题目。")

    mapping = bank.items_by_id
    missing = [item_id for item_id in item_ids if item_id not in mapping]
    if missing:
        raise ExamUnavailable(
            "题库已更新，当前会话的题目已不存在；请重新开始一次练习。"
        )
    return [mapping[item_id] for item_id in item_ids]


def _iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    return (
        datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


# ---------------------------------------------------------------------------
# 数据库（表只由 0012_exam 创建）
# ---------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    """连库（不建库、不建目录：schema 只由迁移创建）。"""
    path = _db_path()
    if not os.path.exists(path):
        raise ExamUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise ExamUnavailable(f"考试练习数据库不可用：{exc}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _require_tables(conn: sqlite3.Connection) -> None:
    existing = _table_names(conn)
    missing = [table for table in EXAM_TABLES if table not in existing]
    if missing:
        raise ExamUnavailable(
            f"数据库缺少表 {missing}（先运行 alembic upgrade head；"
            "考试练习需要 0012_exam 迁移）。"
        )


def _find_active(conn: sqlite3.Connection, user_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM exam_sessions "
        "WHERE user_id = ? AND status = 'in_progress' "
        "ORDER BY started_at DESC, rowid DESC LIMIT 1",
        (user_id,),
    ).fetchone()


def _load_row(
    conn: sqlite3.Connection, session_id: str, user_id: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM exam_sessions WHERE id = ? AND user_id = ?",
        (session_id, user_id),
    ).fetchone()


# ---------------------------------------------------------------------------
# 对外用例：types / start / submit / history
# ---------------------------------------------------------------------------

def list_types() -> dict:
    """可用题型（当前只有 cet4）；静态题库，不读写数据库。"""
    bank = load_bank()
    return {
        "types": [
            {
                "id": EXAM_TYPE_CET4,
                "label": bank.label,
                "itemCount": len(bank.items),
                "sessionItemCount": EXAM_SIZE,
                "description": TYPE_DESCRIPTION,
                "disclaimer": DISCLAIMER,
            }
        ],
        "disclaimer": DISCLAIMER,
    }


def _canonical_type(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    if not value:
        raise ExamInvalid("请选择练习类型（当前支持 cet4）。")
    if value not in SUPPORTED_TYPES:
        raise ExamInvalid(f"暂不支持该练习类型：{raw}（当前支持 cet4）。")
    return value


def start(user_id: str, exam_type: str | None, *, now: int | None = None) -> dict:
    """开始或复用一次练习；返回 10 道题，卷面不含答案与解析。"""
    if not user_id:
        raise ExamInvalid("缺少考试练习身份。")
    canonical = _canonical_type(exam_type)
    # 先验证题库：题库坏了就不该落一条永远无法提交的 in_progress 会话。
    bank = load_bank()
    stamp = int(now) if now is not None else now_ms()

    created = False
    resumed = False
    row: sqlite3.Row | None = None
    conn = _connect()
    try:
        _require_tables(conn)
        row = _find_active(conn, user_id)
        if row is not None:
            resumed = True
            if row["exam_type"] != canonical:
                raise ExamConflict(
                    "已有另一类型的未提交练习，请先完成或提交它。"
                )
        else:
            session_id = uuid.uuid4().hex
            items = sample_items(session_id)
            item_ids = [item.id for item in items]
            try:
                with conn:
                    conn.execute(
                        "INSERT INTO exam_sessions "
                        "(id, user_id, exam_type, status, item_ids, started_at) "
                        "VALUES (?, ?, ?, 'in_progress', ?, ?)",
                        (
                            session_id,
                            user_id,
                            canonical,
                            json.dumps(item_ids, ensure_ascii=False),
                            stamp,
                        ),
                    )
            except sqlite3.IntegrityError:
                # 并发 start：另一个请求已建了未提交会话，直接复用。
                row = _find_active(conn, user_id)
                if row is None:
                    raise
                resumed = True
            else:
                created = True
                row = _load_row(conn, session_id, user_id)
                if row is None:  # pragma: no cover - 插后即查，理论不可达
                    raise ExamConflict("考试练习会话创建失败，请重试。")

        items = _session_items(row, bank)
        payload = {
            "sessionId": row["id"],
            "examType": row["exam_type"],
            "label": bank.label,
            "status": "in_progress",
            "resumed": resumed,
            "startedAt": int(row["started_at"]),
            "itemCount": len(items),
            "totals": _type_totals(items),
            "instructions": (
                "共 10 题，选择每题的答案后提交；提交后可看逐题对错与解析。"
                "这是自编题练习，不是真题，也不提供成绩评估。"
            ),
            "items": [_public_item(item, bank) for item in items],
            "disclaimer": DISCLAIMER,
        }
    except sqlite3.OperationalError as exc:
        raise ExamUnavailable(
            f"考试练习暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    if created:
        events.emit_event(
            "exam_start",
            user_id=user_id,
            session_id=payload["sessionId"],
            content_ref=payload["examType"],
            payload={
                "examType": payload["examType"],
                "itemCount": payload["itemCount"],
                "totals": payload["totals"],
                "resumed": False,
            },
        )
    return payload


def _normalize_answers(answers, allowed: set[str]) -> dict[str, int]:
    """校验并规范化 ``[{itemId, chosenIndex}]`` → {itemId: 0..3}。

    ``chosenIndex`` 省略或为 null 表示未作答（不写入 exam_answers）；
    其余值必须是 0–3 的整数，且 itemId 必须属于本次卷面。
    """
    if answers is None:
        return {}
    if not isinstance(answers, (list, tuple)):
        raise ExamInvalid("answers 必须是数组。")
    if len(answers) > EXAM_SIZE:
        raise ExamInvalid(f"answers 最多 {EXAM_SIZE} 条。")

    chosen: dict[str, int] = {}
    seen: set[str] = set()
    for index, raw in enumerate(answers):
        if not isinstance(raw, dict):
            raise ExamInvalid(f"answers[{index}] 必须是对象。")
        item_id = raw.get("itemId", raw.get("item_id"))
        if not isinstance(item_id, str) or not item_id.strip():
            raise ExamInvalid(f"answers[{index}] 缺少 itemId。")
        item_id = item_id.strip()
        if item_id not in allowed:
            raise ExamInvalid(
                f"answers[{index}]：未知 itemId（{item_id}，不在本次卷面中）。"
            )
        if item_id in seen:
            raise ExamInvalid(f"answers[{index}]：itemId 重复（{item_id}）。")
        seen.add(item_id)

        value = raw.get("chosenIndex", raw.get("chosen_index"))
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise ExamInvalid(
                f"answers[{index}]：chosenIndex 必须是 0–3 的整数。"
            )
        if not 0 <= value <= 3:
            raise ExamInvalid(
                f"answers[{index}]：chosenIndex 必须在 0–3（4 选 1）。"
            )
        chosen[item_id] = value
    return chosen


def _normalize_duration(
    duration_ms, *, started_at: int, now: int
) -> int:
    if duration_ms is None:
        # 服务端回算；会话放太久（>24h）时截到上限，避免写库触发 CHECK。
        return min(MAX_DURATION_MS, max(0, now - int(started_at)))
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
        raise ExamInvalid("durationMs 必须是整数毫秒。")
    if duration_ms < 0:
        raise ExamInvalid("durationMs 不能为负数。")
    if duration_ms > MAX_DURATION_MS:
        raise ExamInvalid("durationMs 超出合理范围（最长 24 小时）。")
    return int(duration_ms)


def _result_payload(
    row: sqlite3.Row,
    bank: Bank,
    items: list[Item],
    chosen: dict[str, int],
    *,
    reused: bool,
    submitted_at: int,
    duration_ms: int | None,
) -> dict:
    """把卷面 + 选择组装成提交结果（含逐题对错/正确答案/解析/未答标记）。"""
    rendered: list[dict] = []
    correct = 0
    answered = 0
    for item in items:
        picked = chosen.get(item.id)
        is_answered = picked is not None
        is_correct = is_answered and picked == item.answer_index
        if is_answered:
            answered += 1
        if is_correct:
            correct += 1
        entry = _public_item(item, bank)
        entry.update(
            {
                "chosenIndex": picked,
                "correctIndex": item.answer_index,
                "correct": is_correct,
                "answered": is_answered,
                "explanation": item.explanation,
            }
        )
        rendered.append(entry)

    total = len(items)
    return {
        "sessionId": row["id"],
        "examType": row["exam_type"],
        "label": bank.label,
        "status": "submitted",
        "reused": reused,
        "startedAt": int(row["started_at"]),
        "submittedAt": int(submitted_at),
        "durationMs": duration_ms,
        "correct": correct,
        "total": total,
        "answered": answered,
        "unanswered": total - answered,
        "items": rendered,
        "disclaimer": DISCLAIMER,
    }


def submit(
    user_id: str,
    session_id: str,
    answers,
    duration_ms: int | None = None,
    *,
    now: int | None = None,
) -> dict:
    """提交作答并返回逐题结果；同一会话重复提交幂等返回首次结果。"""
    if not user_id:
        raise ExamInvalid("缺少考试练习身份。")
    if not isinstance(session_id, str) or not session_id.strip():
        raise ExamInvalid("缺少 sessionId。")
    session_id = session_id.strip()
    stamp = int(now) if now is not None else now_ms()
    bank = load_bank()

    first_submit = False
    result: dict | None = None
    conn = _connect()
    try:
        _require_tables(conn)
        row = _load_row(conn, session_id, user_id)
        if row is None:
            raise ExamNotFound("考试练习会话不存在或不属于当前用户。")
        if row["status"] == "submitted":
            return _result_from_rows(conn, row, bank, reused=True)
        if row["status"] != "in_progress":
            raise ExamConflict("该考试练习会话已结束，请重新开始一次。")

        items = _session_items(row, bank)
        allowed = {item.id for item in items}
        chosen = _normalize_answers(answers, allowed)
        duration = _normalize_duration(
            duration_ms, started_at=int(row["started_at"]), now=stamp
        )

        try:
            with conn:
                for item in items:
                    picked = chosen.get(item.id)
                    if picked is None:
                        continue
                    conn.execute(
                        "INSERT INTO exam_answers "
                        "(session_id, item_id, chosen_index, correct, answered_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (
                            session_id,
                            item.id,
                            picked,
                            int(picked == item.answer_index),
                            stamp,
                        ),
                    )
                cursor = conn.execute(
                    "UPDATE exam_sessions SET status = 'submitted', "
                    "submitted_at = ?, duration_ms = ? "
                    "WHERE id = ? AND status = 'in_progress'",
                    (stamp, duration, session_id),
                )
                if cursor.rowcount != 1:
                    raise ExamConflict(
                        "考试练习会话状态已变化（可能已在另一处提交），请刷新结果。"
                    )
        except sqlite3.IntegrityError:
            # 并发重复提交：另一个请求已写入，回滚本次事务并返回首次结果。
            row = _load_row(conn, session_id, user_id)
            if row is not None and row["status"] == "submitted":
                return _result_from_rows(conn, row, bank, reused=True)
            raise ExamConflict("考试练习提交冲突，请重试。")

        row = _load_row(conn, session_id, user_id)
        if row is None:  # pragma: no cover - 刚写入，理论不可达
            raise ExamConflict("考试练习会话状态异常，请重试。")
        result = _result_payload(
            row,
            bank,
            items,
            chosen,
            reused=False,
            submitted_at=stamp,
            duration_ms=duration,
        )
        first_submit = True
    except sqlite3.OperationalError as exc:
        raise ExamUnavailable(
            f"考试练习暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()

    if first_submit and result is not None:
        events.emit_event(
            "exam_submit",
            user_id=user_id,
            session_id=result["sessionId"],
            content_ref=result["examType"],
            payload={
                "examType": result["examType"],
                "correct": result["correct"],
                "total": result["total"],
                "answered": result["answered"],
                "durationMs": result["durationMs"],
            },
        )
    if result is None:  # pragma: no cover - 正常路径必已赋值
        raise ExamConflict("考试练习提交失败，请重试。")
    return result


def _result_from_rows(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    bank: Bank,
    *,
    reused: bool,
) -> dict:
    """从已提交会话 + 作答行重建响应（重复提交/幂等共用同一形状）。"""
    items = _session_items(row, bank)
    stored_rows = conn.execute(
        "SELECT item_id, chosen_index, correct FROM exam_answers "
        "WHERE session_id = ?",
        (row["id"],),
    ).fetchall()
    chosen = {
        stored["item_id"]: int(stored["chosen_index"]) for stored in stored_rows
    }
    return _result_payload(
        row,
        bank,
        items,
        chosen,
        reused=reused,
        submitted_at=int(row["submitted_at"] or 0),
        duration_ms=(
            int(row["duration_ms"]) if row["duration_ms"] is not None else None
        ),
    )


def history(user_id: str, limit: int = HISTORY_DEFAULT_LIMIT) -> dict:
    """历史练习（**只含已提交**）：日期/题型/正确数/总数，不出现任何成绩字段。"""
    if not user_id:
        raise ExamInvalid("缺少考试练习身份。")
    try:
        value = int(limit)
    except (TypeError, ValueError) as exc:
        raise ExamInvalid("limit 必须是整数。") from exc
    limit = max(1, min(value, HISTORY_MAX_LIMIT))

    bank = load_bank()
    conn = _connect()
    try:
        _require_tables(conn)
        rows = conn.execute(
            "SELECT id, exam_type, started_at, submitted_at, duration_ms, item_ids "
            "FROM exam_sessions WHERE user_id = ? AND status = 'submitted' "
            "ORDER BY submitted_at DESC, rowid DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        if not rows:
            return {"sessions": [], "limit": limit, "disclaimer": DISCLAIMER}

        session_ids = [row["id"] for row in rows]
        placeholders = ", ".join("?" for _ in session_ids)
        counts = {
            count_row["session_id"]: count_row
            for count_row in conn.execute(
                "SELECT session_id, SUM(correct) AS correct, "
                f"COUNT(*) AS answered FROM exam_answers "
                f"WHERE session_id IN ({placeholders}) GROUP BY session_id",
                session_ids,
            ).fetchall()
        }

        sessions = []
        for row in rows:
            try:
                total = len(json.loads(row["item_ids"] or "[]"))
            except (TypeError, ValueError):
                total = 0
            count_row = counts.get(row["id"])
            submitted_at = (
                int(row["submitted_at"]) if row["submitted_at"] is not None else None
            )
            sessions.append(
                {
                    "sessionId": row["id"],
                    "examType": row["exam_type"],
                    "label": bank.label,
                    "startedAt": int(row["started_at"]),
                    "submittedAt": submitted_at,
                    "date": _iso(submitted_at),
                    "correct": int(count_row["correct"] or 0) if count_row else 0,
                    "total": total,
                    "answered": int(count_row["answered"] or 0) if count_row else 0,
                    "durationMs": (
                        int(row["duration_ms"])
                        if row["duration_ms"] is not None
                        else None
                    ),
                }
            )
        return {"sessions": sessions, "limit": limit, "disclaimer": DISCLAIMER}
    except sqlite3.OperationalError as exc:
        raise ExamUnavailable(
            f"考试练习暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()
