"""能力档案聚合：分技能画像 / 自评 / can-do（计划书 §5、§7，specs/025）。

M1 的一条硬边界：**只交付词汇识别区间**，阅读证据不足，听说写未测。
所以本模块的输出里：

- ``vocabulary`` 可以有 ``uncalibrated`` + 区间/精度/可信度（题目证据，未标定）；
- ``reading`` 固定 ``insufficient``，任何 payload 都不带阅读带；
- ``listening`` / ``speaking`` / ``grammar`` 固定 ``not_measured``；
- ``writing`` 是 ``self_report``，``cefr`` 恒为 ``null``，band 只放
  ``selfReport.band``（K20）；
- ``composite.cefr`` 恒为 ``null``，不存在 ``overall.cefr``；
- ``measured`` 状态在 M1 代码里不可达（:func:`_assert_m1_status`）。

数据来源：

- ``user_skill_profiles``：当前聚合值（定位测提交时写入，旧画像 seed）；
- ``skill_evidence``：append-only 证据流水（定位测逐题、自评按技能）；
- ``assessment_sessions``：自评会话（幂等键 ``client_request_id``）；
- ``placement_sessions``：样本量与最近一次作答可信度；
- ``content/ability/{can_do,self_assess}.json``：只读内容，缺失/损坏 → 503。

不存 PII、不存用户原文：证据只落 item id / 带 / outcome / 耗时等小字段。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
import uuid
from typing import Mapping, Sequence

import assessment
import config
import ratelimit

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 公开常量
# ---------------------------------------------------------------------------

SCHEMA_VERSION = assessment.SCHEMA_VERSION
CALIBRATION_VERSION = assessment.CALIBRATION_VERSION

SKILLS: tuple[str, ...] = (
    "vocabulary",
    "grammar",
    "listening",
    "reading",
    "speaking",
    "writing",
)
SELF_ASSESS_SKILLS: tuple[str, ...] = ("listening", "speaking", "reading", "writing")
PROFILE_STATUSES: tuple[str, ...] = (
    "uncalibrated",
    "measured",
    "estimated",
    "self_report",
)
METHODS: tuple[str, ...] = (
    "placement",
    "test",
    "behavior",
    "self_report",
    "writing_task",
    "speaking_task",
    "composite",
)

ABILITY_TABLES: tuple[str, ...] = (
    "user_skill_profiles",
    "skill_evidence",
    "assessment_sessions",
    "placement_sessions",
    "placement_answers",
    "user_profiles",
)

PRELIMINARY_SAMPLE_THRESHOLD = 100
STALE_DAYS = 90
STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

SELF_ASSESS_MIN_ITEMS = 12
SELF_ASSESS_MAX_ITEMS = 20
SELF_ASSESS_DAILY_LIMIT = 10
SELF_ASSESS_MIN_DURATION_MS = 30_000
SELF_ASSESS_MAX_DURATION_MS = 30 * 60 * 1000
SELF_REPORT_CONFIDENCE_CAP = 0.35

CAN_DO_LANGS: dict[str, str] = {"zh-CN": "zh", "vi-VN": "vi"}

DISCLAIMER = (
    "这是基于有限证据的 CEFR 对齐估计，不是官方 CEFR 认证，"
    "也不等同于雅思/托福分数。"
)
SELF_REPORT_CAVEAT = "自评仅参考，可能与实际差 1–2 档；不构成能力判定。"

READING_NOTE = "题量少，不足以单独评级；下一版 20 题小测。"
LISTENING_NOTE = "行为证据不足；M3 起 6–8 题小测。"
SPEAKING_NOTE = "未测；不会用 AI 猜等级。"
WRITING_NOTE = "自评不构成能力判定，不进入任何合成。"
GRAMMAR_NOTE = "M1 不测语法；80 点用于内容难度解释与 M3 题蓝图。"
VOCABULARY_NOTE = (
    "题目证据·未标定：有 {count} 道题，但难度为编辑带中心，"
    "未做题目拟合与标准设定。"
)
VOCABULARY_EMPTY_NOTE = "完成一次 12 分钟定位测后显示词汇识别区间。"


class AbilityError(Exception):
    """能力档案领域错误基类。"""


class AbilityUnavailable(AbilityError):
    """表/内容文件缺失或损坏（路由 503）。"""


class AbilityInvalid(AbilityError):
    """参数非法（路由 400）。"""


class AbilityNotFound(AbilityError):
    """会话/内容不存在（路由 404，不泄露存在性）。"""


class AbilityConflict(AbilityError):
    """状态冲突（路由 409）。"""


class AbilityRateLimited(AbilityError):
    """自评日限（路由 429，带 Retry-After）。"""

    def __init__(self, retry_after: int) -> None:
        self.retry_after = max(1, int(retry_after))
        super().__init__("自评次数已达今日上限，请明天再试。")


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise AbilityUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise AbilityUnavailable(f"能力档案数据库不可用：{exc}") from exc
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
    missing = [table for table in ABILITY_TABLES if table not in existing]
    if missing:
        raise AbilityUnavailable(
            f"数据库缺少表 {missing}（先运行 alembic upgrade head；"
            "能力档案需要 0014_ability 与 0015_assessment_sessions；"
            "定位测需要 0009_placement 及更早迁移）。"
        )


def require_tables(conn: sqlite3.Connection) -> None:
    """给定位测提交等跨模块调用方用的表检查（缺失 → AbilityUnavailable/503）。"""
    _require_tables(conn)


def _assert_m1_status(status: str) -> None:
    """M1 状态机断言：``measured`` 不可达（G4 / 计划书 §5.8 K16）。

    这不是文案约束，是代码硬边界：M1 没有题目标定样本，任何写 ``measured``
    的路径都应视为 bug。M2 达标后删除本函数即可。
    """
    if status == "measured":
        raise RuntimeError(
            "M1 的 measured 状态不可达：能力档案只允许 uncalibrated/"
            "estimated/self_report（计划书 §5.8）。"
        )


def _count_reading_items(conn: sqlite3.Connection, identity: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS total FROM skill_evidence "
        "WHERE user_id = ? AND skill = 'reading' "
        "AND evidence_type = 'placement_answer'",
        (identity,),
    ).fetchone()
    return int(row["total"] or 0)


def _sample_size(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COUNT(DISTINCT user_id) AS total FROM placement_sessions "
        "WHERE status = 'submitted'"
    ).fetchone()
    return int(row["total"] or 0)


def record_placement_result(
    conn: sqlite3.Connection,
    identity: str,
    session_id: str,
    items: Sequence[object],
    chosen: Mapping[str, int],
    elapsed_ms: Mapping[str, int | None],
    result: Mapping,
    *,
    stamp: int,
) -> None:
    """把一次定位测写进能力新表（由 ``placement.submit`` 在同一事务内调用）。

    - 逐题写 ``skill_evidence``（vocabulary / reading；伪词不写）：
      ``source_key = placement:<sessionId>:<bankItemId>``，唯一键保证重放幂等；
    - 只 upsert **vocabulary** 行；reading 不建行（M1 由 API 合成 insufficient）；
    - ``status`` 固定 ``uncalibrated``，``calibration_version`` 来自估计器；
    - payload 只存 ``elapsedMs`` 这类小字段，不存题干/选项/原文。
    """
    calibration = result.get("calibration") or {}
    # M2：v2 卷面的估计器版本必须原样记录；旧 v1 结果保持默认。
    calibration_version = str(
        calibration.get("calibrationVersion")
        or calibration.get("version")
        or CALIBRATION_VERSION
    )
    breakdown = result.get("breakdown") or {}
    validity = breakdown.get("validity") if isinstance(breakdown, Mapping) else None
    if not isinstance(validity, dict):
        validity = {"label": "medium", "flags": ["unknown"]}
    precision = calibration.get("precision")
    if not isinstance(precision, dict):
        precision = {"label": "low", "se": calibration.get("se")}
    band = calibration.get("band") or (result.get("cefr") or {}).get("point")
    estimate = calibration.get("vocabulary")
    if not isinstance(estimate, dict):
        estimate = {}
    confidence = min(
        assessment.confidence_value(precision, validity),
        float(result.get("confidence") or 0.0) or 1.0,
    )

    vocab_items = [item for item in items if getattr(item, "type", None) == "vocab"]
    for item in items:
        item_type = getattr(item, "type", None)
        if item_type not in ("vocab", "reading"):
            continue
        bank_id = str(getattr(item, "id"))
        picked = int(chosen.get(bank_id, -1))
        answer_index = getattr(item, "answer_index", None)
        correct = int(answer_index is not None and picked == answer_index)
        payload: dict = {}
        elapsed = elapsed_ms.get(bank_id)
        if elapsed is not None:
            payload["elapsedMs"] = int(elapsed)
        conn.execute(
            "INSERT OR IGNORE INTO skill_evidence "
            "(user_id, skill, evidence_type, source_key, source_ref, band, "
            "outcome, weight, confidence, observed_at, payload, created_at) "
            "VALUES (?, ?, 'placement_answer', ?, ?, ?, ?, ?, 1.0, ?, ?, ?)",
            (
                identity,
                "vocabulary" if item_type == "vocab" else "reading",
                f"placement:{session_id}:{bank_id}",
                session_id,
                getattr(item, "band", None),
                correct,
                1.0 if item_type == "vocab" else 0.15,
                stamp,
                json.dumps(payload, ensure_ascii=False, sort_keys=True) if payload else None,
                stamp,
            ),
        )

    evidence_total = conn.execute(
        "SELECT COUNT(*) AS total FROM skill_evidence "
        "WHERE user_id = ? AND skill = 'vocabulary'",
        (identity,),
    ).fetchone()["total"]
    details = {
        "source": "placement",
        "sourceSessionId": session_id,
        "theta": calibration.get("theta"),
        "se": calibration.get("se"),
        "ci95": calibration.get("ci95"),
        "ci80": calibration.get("ci80"),
        "band": band,
        "bandPosterior": calibration.get("bandPosterior"),
        "interval": calibration.get("interval"),
        "estimate": estimate,
        "precision": {
            "label": precision.get("label"),
            "se": precision.get("se"),
            "value": precision.get("value"),
        },
        "validity": validity,
        "confidence": round(confidence, 4),
        "calibrationVersion": calibration_version,
        "note": VOCABULARY_NOTE.format(count=len(vocab_items)),
    }
    interval = calibration.get("interval")
    if not isinstance(interval, dict):
        interval = {}
    conn.execute(
        "INSERT INTO user_skill_profiles "
        "(user_id, skill, cefr_point, cefr_low, cefr_high, confidence, status, "
        "method, evidence_count, effective_n, last_evidence_at, details, "
        "calibration_version, schema_version, updated_at) "
        "VALUES (?, 'vocabulary', ?, ?, ?, ?, 'uncalibrated', 'placement', ?, ?, ?, "
        "?, ?, ?, ?) "
        "ON CONFLICT(user_id, skill) DO UPDATE SET "
        "cefr_point = excluded.cefr_point, cefr_low = excluded.cefr_low, "
        "cefr_high = excluded.cefr_high, confidence = excluded.confidence, "
        "status = 'uncalibrated', method = 'placement', "
        "evidence_count = excluded.evidence_count, "
        "effective_n = excluded.effective_n, "
        "last_evidence_at = excluded.last_evidence_at, "
        "details = excluded.details, "
        "calibration_version = excluded.calibration_version, "
        "schema_version = excluded.schema_version, updated_at = excluded.updated_at",
        (
            identity,
            band,
            interval.get("low"),
            interval.get("high"),
            round(confidence, 4),
            int(evidence_total or 0),
            float(evidence_total or 0),
            stamp,
            json.dumps(details, ensure_ascii=False, sort_keys=True),
            calibration_version,
            SCHEMA_VERSION,
            stamp,
        ),
    )


def claim_guest(guest_hash: str, user_id: str) -> dict:
    """把游客名下的能力数据迁移到登录账号（幂等；用户已有数据优先）。

    与 ``placement.claim_guest_sessions`` 同一套口径：游客身份是
    ``guest:<sha256>``。唯一键冲突（同一 ``source_key`` 或同一技能行）时跳过
    游客行，保留用户行，最后删除剩余游客行。
    """
    if not guest_hash or not user_id:
        return {"user_skill_profiles": 0, "skill_evidence": 0, "assessment_sessions": 0}
    owner = "guest:" + guest_hash
    moved: dict[str, int] = {}
    conn = _connect()
    try:
        _require_tables(conn)
        with conn:
            for table, guest_columns in (
                ("assessment_sessions", ", guest_hash = NULL"),
                ("skill_evidence", ""),
                ("user_skill_profiles", ""),
            ):
                total = conn.execute(
                    f"SELECT COUNT(*) AS total FROM {table} WHERE user_id = ?",
                    (owner,),
                ).fetchone()["total"]
                if not total:
                    moved[table] = 0
                    continue
                conn.execute(
                    f"UPDATE OR IGNORE {table} SET user_id = ?{guest_columns} "
                    "WHERE user_id = ?",
                    (user_id, owner),
                )
                left = conn.execute(
                    f"SELECT COUNT(*) AS total FROM {table} WHERE user_id = ?",
                    (owner,),
                ).fetchone()["total"]
                moved[table] = max(0, int(total) - int(left))
                conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (owner,))
        return moved
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 内容文件（只读、随仓库分发）
# ---------------------------------------------------------------------------

def _content_path(name: str) -> str:
    return os.path.join(config.ABILITY_DIR, name)


def _read_json(name: str, *, expected: str) -> dict:
    path = _content_path(name)
    if not os.path.exists(path):
        raise AbilityUnavailable(
            f"{expected}文件不存在：{path}（content/ability/ 应随仓库分发）"
        )
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        raise AbilityUnavailable(f"{expected}文件损坏：{exc}") from exc
    if not isinstance(data, dict):
        raise AbilityUnavailable(f"{expected}文件结构非法：顶层必须是对象。")
    return data


def load_can_do() -> dict:
    """加载并校验 ``can_do.json``：A1–C1 × 4 技能，≥40 条，zh + vi。"""
    data = _read_json("can_do.json", expected="can-do 内容")
    items = data.get("items")
    if not isinstance(items, list) or len(items) < 40:
        raise AbilityUnavailable("can-do 内容条数不足 40。")
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise AbilityUnavailable(f"can-do items[{index}] 必须是对象。")
        item_id = item.get("id")
        level = item.get("level")
        skill = item.get("skill")
        statement = item.get("statement")
        if not isinstance(item_id, str) or not item_id or item_id in seen:
            raise AbilityUnavailable(f"can-do items[{index}] 的 id 缺失或重复。")
        seen.add(item_id)
        if level not in assessment.CEFR_BANDS[:5]:
            raise AbilityUnavailable(f"can-do items[{index}] 的 level 非法。")
        if skill not in SELF_ASSESS_SKILLS:
            raise AbilityUnavailable(f"can-do items[{index}] 的 skill 非法。")
        if not isinstance(statement, dict) or not all(
            isinstance(statement.get(lang), str) and statement.get(lang)
            for lang in ("zh", "vi")
        ):
            raise AbilityUnavailable(f"can-do items[{index}] 缺少 zh/vi 文案。")
        if item.get("basis") not in ("cefr-aligned", "product-operational"):
            raise AbilityUnavailable(f"can-do items[{index}] 的 basis 非法。")
    data["items"] = items
    return data


def load_self_assess() -> dict:
    """加载并校验 ``self_assess.json``：恰好 20 条，4 技能 × A1–C1。"""
    data = _read_json("self_assess.json", expected="自评内容")
    items = data.get("items")
    if not isinstance(items, list) or len(items) != 20:
        raise AbilityUnavailable("自评内容必须恰好 20 条。")
    seen: set[str] = set()
    coverage: set[tuple[str, str]] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise AbilityUnavailable(f"self_assess items[{index}] 必须是对象。")
        item_id = item.get("id")
        level = item.get("level")
        skill = item.get("skill")
        statement = item.get("statement")
        if not isinstance(item_id, str) or not item_id or item_id in seen:
            raise AbilityUnavailable(f"self_assess items[{index}] 的 id 缺失或重复。")
        seen.add(item_id)
        if level not in assessment.CEFR_BANDS[:5]:
            raise AbilityUnavailable(f"self_assess items[{index}] 的 level 非法。")
        if skill not in SELF_ASSESS_SKILLS:
            raise AbilityUnavailable(f"self_assess items[{index}] 的 skill 非法。")
        if not isinstance(statement, dict) or not all(
            isinstance(statement.get(lang), str) and statement.get(lang)
            for lang in ("zh", "vi")
        ):
            raise AbilityUnavailable(f"self_assess items[{index}] 缺少 zh/vi 文案。")
        coverage.add((skill, level))
    expected = {(skill, level) for skill in SELF_ASSESS_SKILLS for level in assessment.CEFR_BANDS[:5]}
    if coverage != expected:
        raise AbilityUnavailable("自评内容没有覆盖 4 技能 × A1–C1。")
    return data


def reset_content_cache() -> None:
    """兼容测试的显式清理钩子（当前内容文件不做进程内缓存）。"""


# ---------------------------------------------------------------------------
# 行解析 / 聚合小工具
# ---------------------------------------------------------------------------

def _decode_json(raw: object) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _rows_by_skill(conn: sqlite3.Connection, identity: str) -> dict[str, sqlite3.Row]:
    rows = conn.execute(
        "SELECT * FROM user_skill_profiles WHERE user_id = ?", (identity,)
    ).fetchall()
    result: dict[str, sqlite3.Row] = {}
    for row in rows:
        status = str(row["status"])
        _assert_m1_status(status)
        result[str(row["skill"])] = row
    return result


def _latest_placement_breakdown(
    conn: sqlite3.Connection, identity: str
) -> dict:
    row = conn.execute(
        "SELECT breakdown FROM placement_sessions "
        "WHERE user_id = ? AND status = 'submitted' "
        "ORDER BY submitted_at DESC, rowid DESC LIMIT 1",
        (identity,),
    ).fetchone()
    if row is None:
        return {}
    stored = _decode_json(row["breakdown"])
    breakdown = stored.get("breakdown")
    return breakdown if isinstance(breakdown, dict) else {}


def _validity_from_breakdown(breakdown: Mapping) -> dict:
    """优先用定位测写入的 validity；旧 breakdown 没有就按字段回退。"""
    stored = breakdown.get("validity")
    if isinstance(stored, dict) and stored.get("label"):
        return {
            "label": str(stored["label"]),
            "flags": list(stored.get("flags") or []),
        }
    flags: list[str] = []
    pseudo = breakdown.get("pseudo")
    suspicion = None
    if isinstance(pseudo, dict):
        suspicion = pseudo.get("suspicion")
    if isinstance(suspicion, (int, float)):
        flags.append("pseudo_overclaim" if suspicion > 1 / 3 else "pseudo_ok")
    duration = breakdown.get("durationMs")
    if isinstance(duration, (int, float)):
        if duration < 180_000:
            flags.append("duration_short")
        elif duration > 20 * 60 * 1000:
            flags.append("duration_long")
        else:
            flags.append("duration_ok")
    else:
        flags.append("duration_unknown")
    ratio = breakdown.get("completionRatio")
    if isinstance(ratio, (int, float)):
        flags.append("completion_ok" if ratio >= 0.6 else "completion_low")
    return {
        "label": assessment.validity_label(flags),
        "flags": flags,
    }


def _confidence_from_details(details: Mapping, row: Mapping) -> dict:
    precision = details.get("precision")
    if not isinstance(precision, dict):
        precision = {"label": "low", "se": None}
    validity = details.get("validity")
    if not isinstance(validity, dict):
        validity = {"label": "medium", "flags": ["legacy_seed"]}
    se = precision.get("se")
    precision_payload = {
        # 有 SE 时由 SE 统一分档，避免上游 label 与数值不一致。
        "label": (
            assessment.precision_label(float(se))
            if isinstance(se, (int, float))
            else str(precision.get("label") or "low")
        ),
        "se": se,
    }
    validity_payload = {
        "label": str(validity.get("label") or "medium"),
        "flags": list(validity.get("flags") or []),
    }
    score = assessment.confidence_value(precision_payload, validity_payload)
    return {
        "precision": precision_payload,
        "validity": validity_payload,
        "confidence": round(min(score, float(row["confidence"])), 4),
    }


def _evidence_strength(precision: Mapping, validity: Mapping) -> str:
    precision_score = assessment.precision_value(
        float(precision.get("se") or 0.7)
    ) if precision.get("se") is not None else 0.55
    validity_score = assessment.validity_value(str(validity.get("label") or "low"))
    score = 0.6 * precision_score + 0.4 * validity_score
    if score >= 0.82:
        return "strong"
    if score >= 0.60:
        return "medium"
    return "weak"


def _vocabulary_payload(
    conn: sqlite3.Connection,
    identity: str,
    row: sqlite3.Row | None,
    *,
    now: int,
) -> dict:
    if row is None:
        return {
            "status": "not_measured",
            "cefr": None,
            "low": None,
            "high": None,
            "label": None,
            "method": None,
            "evidenceCount": 0,
            "effectiveN": 0.0,
            "precision": {"label": "low", "se": None},
            "validity": {"label": "low", "flags": ["no_evidence"]},
            "evidenceStrength": "none",
            "confidence": 0.0,
            "confidenceDeprecated": True,
            "lastEvidenceAt": None,
            "stale": False,
            "estimate": None,
            "note": VOCABULARY_EMPTY_NOTE,
        }

    details = _decode_json(row["details"])
    confidence_parts = _confidence_from_details(details, row)
    last_evidence_at = row["last_evidence_at"]
    stale = bool(
        last_evidence_at is not None
        and now - int(last_evidence_at) > STALE_MS
    )
    estimate = details.get("estimate")
    if not isinstance(estimate, dict):
        estimate = None
    count = int(row["evidence_count"] or 0)
    note = details.get("note") or VOCABULARY_NOTE.format(count=count)
    return {
        "status": str(row["status"]),
        "cefr": row["cefr_point"],
        "low": row["cefr_low"],
        "high": row["cefr_high"],
        "label": (
            f"{row['cefr_low']}–{row['cefr_high']}"
            if row["cefr_low"] and row["cefr_high"]
            else None
        ),
        "method": str(row["method"]),
        "evidenceCount": count,
        "effectiveN": round(float(row["effective_n"] or 0), 3),
        "precision": confidence_parts["precision"],
        "validity": confidence_parts["validity"],
        "evidenceStrength": _evidence_strength(
            confidence_parts["precision"], confidence_parts["validity"]
        ),
        "confidence": confidence_parts["confidence"],
        "confidenceDeprecated": True,
        "lastEvidenceAt": int(last_evidence_at) if last_evidence_at else None,
        "stale": stale,
        "estimate": estimate,
        "note": note,
        "calibrationVersion": str(row["calibration_version"]),
    }


def _latest_self_report(conn: sqlite3.Connection, identity: str, *, now: int) -> dict:
    """最近 24 小时只认第一次自评；没有近期记录时退回最近一次。"""
    row = conn.execute(
        "SELECT result FROM assessment_sessions "
        "WHERE user_id = ? AND kind = 'self_assess' AND status = 'submitted' "
        "AND submitted_at IS NOT NULL AND submitted_at >= ? "
        "ORDER BY submitted_at ASC, rowid ASC LIMIT 1",
        (identity, now - 24 * 60 * 60 * 1000),
    ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT result FROM assessment_sessions "
            "WHERE user_id = ? AND kind = 'self_assess' AND status = 'submitted' "
            "ORDER BY submitted_at DESC, rowid DESC LIMIT 1",
            (identity,),
        ).fetchone()
    if row is None:
        return {}
    return _decode_json(row["result"])


def _writing_payload(self_report: Mapping) -> dict:
    by_skill = self_report.get("bySkill")
    entry = by_skill.get("writing") if isinstance(by_skill, dict) else None
    band = None
    items = 0
    if isinstance(entry, dict):
        band = entry.get("band")
        items = int(entry.get("items") or 0)
    return {
        "status": "self_report",
        "cefr": None,
        "low": None,
        "high": None,
        "method": "self_report",
        "items": items,
        "selfReport": {
            "band": band,
            "items": items,
            "caveat": SELF_REPORT_CAVEAT,
        },
        "note": WRITING_NOTE,
    }


def _can_do_by_skill(level: str | None, lang: str) -> dict[str, list[str]]:
    result = {skill: [] for skill in SELF_ASSESS_SKILLS}
    if not level:
        return result
    try:
        content = load_can_do()
    except AbilityUnavailable:
        return result
    for item in content.get("items", []):
        if item.get("level") != level:
            continue
        skill = item.get("skill")
        statement = item.get("statement")
        if skill in result and isinstance(statement, dict):
            text = statement.get(lang)
            if isinstance(text, str) and text:
                if skill == "reading":
                    text = f"{text}（通用描述）"
                result[skill].append(text)
    return result


def _conflicts(
    rows: Mapping[str, sqlite3.Row], self_report: Mapping
) -> list[dict]:
    """同一技能「题目带」与「自评带」相差 ≥2 带 → 冲突提示（不自动降级）。

    M1 只有词汇带可作参照，而自评覆盖听/说/读/写，技能不同不互相比较，
    所以正常情况下返回空列表；函数保留给 M2/M3 有同技能双证据时启用。
    """
    by_skill = self_report.get("bySkill")
    if not isinstance(by_skill, dict):
        return []
    conflicts: list[dict] = []
    for skill, row in rows.items():
        cefr_point = row["cefr_point"]
        entry = by_skill.get(skill)
        if not cefr_point or not isinstance(entry, dict):
            continue
        band = entry.get("band")
        if band not in assessment.BAND_INDEX or cefr_point not in assessment.BAND_INDEX:
            continue
        gap = abs(assessment.BAND_INDEX[str(band)] - assessment.BAND_INDEX[str(cefr_point)])
        if gap >= 2:
            conflicts.append(
                {
                    "skill": skill,
                    "evidenceBand": str(cefr_point),
                    "selfReportBand": str(band),
                    "bandGap": gap,
                    "action": "suggest_retest",
                    "note": "自评与题目证据相差 2 带以上，建议重测；不自动调整区间。",
                }
            )
    return conflicts


# ---------------------------------------------------------------------------
# 对外：profile / legacy shim
# ---------------------------------------------------------------------------

def profile(
    identity: str, *, lang: str = "zh-CN", now: int | None = None
) -> dict:
    """``GET /api/ability/profile`` 的完整响应（登录/游客同一形状）。"""
    if not identity:
        raise AbilityInvalid("缺少能力档案身份。")
    language = _normalize_lang(lang)
    stamp = int(now) if now is not None else now_ms()
    conn = _connect()
    try:
        _require_tables(conn)
        rows = _rows_by_skill(conn, identity)
        vocabulary_row = rows.get("vocabulary")
        vocabulary = _vocabulary_payload(
            conn, identity, vocabulary_row, now=stamp
        )
        self_report = _latest_self_report(conn, identity, now=stamp)
        sample_size = _sample_size(conn)
        level = vocabulary["cefr"] if vocabulary_row is not None else None
        reading_items = _count_reading_items(conn, identity)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "calibrationVersion": CALIBRATION_VERSION,
            "primary": "vocabulary",
            "vocabulary": vocabulary,
            "composite": {
                "derivedFrom": ["vocabulary"] if vocabulary_row is not None else [],
                "cefr": None,
                "label": vocabulary["label"],
                "status": (
                    "uncalibrated" if vocabulary_row is not None else "not_measured"
                ),
                "note": "只由词汇识别派生，不是四技能平均，也不作总等级使用。",
            },
            "skills": {
                "reading": {
                    "status": "insufficient",
                    "cefr": None,
                    "low": None,
                    "high": None,
                    "items": reading_items,
                    "method": "reading.5item.v1",
                    "note": READING_NOTE,
                },
                "listening": {
                    "status": "not_measured",
                    "cefr": None,
                    "note": LISTENING_NOTE,
                },
                "speaking": {
                    "status": "not_measured",
                    "cefr": None,
                    "note": SPEAKING_NOTE,
                },
                "writing": _writing_payload(self_report),
            },
            "grammar": {
                "status": "not_measured",
                "band": None,
                "pointsTotal": 80,
                "note": GRAMMAR_NOTE,
            },
            "inputOutputGap": {
                "available": False,
                "inputBand": level,
                "outputBand": None,
                "note": "输出未测，不能计算差距。",
            },
            "canDo": {
                "level": level,
                "bySkill": _can_do_by_skill(level, language),
                "note": "通用描述，不是对个人的能力判定。",
            },
            "conflicts": _conflicts(rows, self_report),
            "preliminary": sample_size < PRELIMINARY_SAMPLE_THRESHOLD,
            "sampleSize": sample_size,
            "disclaimer": DISCLAIMER,
        }
    except sqlite3.OperationalError as exc:
        raise AbilityUnavailable(
            f"能力档案暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def advice_for_vocabulary(band: str | None, *, suspicion: float = 0.0) -> str:
    """词汇区间的 1 条规则建议（不调用模型；阅读只提「下一版」小测）。"""
    reading_note = "阅读只有 5 题，证据不足，下一版可做 20 题阅读小测。"
    if suspicion >= 0.5:
        return (
            "伪词题答得偏多，可能高估了自己的词汇量：不确定就选「不认识」，"
            "休息一下再测一次会比这次更可信。" + reading_note
        )
    output_bands = assessment.CEFR_BANDS[:5]
    if band not in output_bands:
        return "先完成一次 12 分钟定位测，拿到词汇识别区间。" + reading_note
    index = output_bands.index(str(band))
    target = output_bands[min(index + 1, len(output_bands) - 1)]
    if index <= 1:
        core = (
            "先从 A1–A2 的慢速短视频起步：每天 8 分钟，开英文字幕跟读，"
            "把反复出现的词加进复习队列。"
        )
    elif index <= 3:
        core = (
            f"当前词汇识别区间在 {band}–{target} 附近：挑 10 分钟以上的真实视频精看，"
            "每周围绕一个主题做 3 次精读。"
        )
    else:
        core = (
            "区间已到 C1：尝试无字幕或纯音频材料，每周做一次 2 分钟复述，"
            "用「能不能讲清楚」检验理解而不是靠选择题。"
        )
    return core + reading_note


def legacy_profile(identity: str, *, now: int | None = None) -> dict:
    """旧 ``GET /api/placement/profile`` 的 shim。

    字段名保持不变；值从 ``user_skill_profiles`` 的 vocabulary 行派生：

    - ``cefr`` / ``levelBandLow`` / ``levelBandHigh`` = 词汇带与区间；
    - ``vocabEstimate`` = 词汇量点估计；
    - ``readingEstimate`` = **null**，并新增 ``readingStatus='insufficient'``；
    - ``confidence`` = min(precision, validity)；
    - 额外返回 ``deprecated: true`` 与 ``replacedBy``。

    没有 vocabulary 行时 ``profile`` 为 null（与旧端点一致）。
    """
    if not identity:
        raise AbilityInvalid("缺少定位测身份。")
    stamp = int(now) if now is not None else now_ms()
    conn = _connect()
    try:
        _require_tables(conn)
        rows = _rows_by_skill(conn, identity)
        row = rows.get("vocabulary")
        sample_size = _sample_size(conn)
        response = {
            "profile": None,
            "preliminary": sample_size < PRELIMINARY_SAMPLE_THRESHOLD,
            "sampleSize": sample_size,
            "disclaimer": DISCLAIMER,
            "deprecated": True,
            "replacedBy": "/api/ability/profile",
        }
        if row is None:
            # 兼容：新表没有行、但旧 user_profiles 有画像（例如 0014 之后直接写入
            # 的旧调用方）。推荐等读路径按「新表缺失回退旧逻辑」处理；阅读仍降级。
            legacy = conn.execute(
                "SELECT * FROM user_profiles WHERE user_id = ?", (identity,)
            ).fetchone()
            if legacy is None:
                return response
            legacy_low = legacy["level_band_low"]
            legacy_high = legacy["level_band_high"]
            legacy_confidence = min(float(legacy["confidence"]), 0.85)
            latest = _latest_placement_breakdown(conn, identity)
            response["profile"] = {
                "cefr": legacy["cefr"],
                "levelBandLow": legacy_low,
                "levelBandHigh": legacy_high,
                "vocabEstimate": legacy["vocab_estimate"],
                "readingEstimate": None,
                # 兼容计划书 §7.7 A3 的 snake_case 写法；旧前端只用 camelCase。
                "reading_estimate": None,
                "readingStatus": "insufficient",
                "confidence": legacy_confidence,
                "confidenceLabel": _confidence_label(legacy_confidence),
                "confidenceLabelZh": _confidence_label_zh(legacy_confidence),
                "pseudoWordSuspicion": float(legacy["pseudo_word_suspicion"]),
                "updatedAt": int(legacy["updated_at"]),
                "source": legacy["source"],
                "strengths": (
                    [f"词汇识别（{legacy_low}）"] if legacy_low else []
                ),
                "weaknesses": [],
                "advice": advice_for_vocabulary(
                    legacy_low,
                    suspicion=float((latest.get("pseudo") or {}).get("suspicion") or 0.0),
                ),
                "measuredDomains": ["vocab"],
                "notMeasured": ["listening", "speaking", "writing"],
                "validity": _validity_from_breakdown(latest),
                "calibrationVersion": None,
                "preliminary": sample_size < PRELIMINARY_SAMPLE_THRESHOLD,
                "sampleSize": sample_size,
                "disclaimer": DISCLAIMER,
            }
            return response
        details = _decode_json(row["details"])
        confidence_parts = _confidence_from_details(details, row)
        latest = _latest_placement_breakdown(conn, identity)
        validity = _validity_from_breakdown(latest)
        label = (
            f"{row['cefr_low']}–{row['cefr_high']}"
            if row["cefr_low"] and row["cefr_high"]
            else None
        )
        estimate = details.get("estimate") if isinstance(details.get("estimate"), dict) else {}
        vocab_estimate = estimate.get("point")
        if not isinstance(vocab_estimate, int):
            vocab_estimate = None
        strengths = (
            [f"词汇识别（{row['cefr_point']}）"] if row["cefr_point"] else []
        )
        response["profile"] = {
            "cefr": label,
            "levelBandLow": row["cefr_low"],
            "levelBandHigh": row["cefr_high"],
            "vocabEstimate": vocab_estimate,
            "readingEstimate": None,
            "reading_estimate": None,
            "readingStatus": "insufficient",
            "confidence": confidence_parts["confidence"],
            "confidenceLabel": _confidence_label(confidence_parts["confidence"]),
            "confidenceLabelZh": _confidence_label_zh(confidence_parts["confidence"]),
            "pseudoWordSuspicion": float(
                (latest.get("pseudo") or {}).get("suspicion") or 0.0
            ),
            "updatedAt": int(row["updated_at"]),
            "source": "placement",
            "strengths": strengths,
            "weaknesses": [],
            "advice": advice_for_vocabulary(
                row["cefr_point"],
                suspicion=float((latest.get("pseudo") or {}).get("suspicion") or 0.0),
            ),
            "measuredDomains": ["vocab"],
            "notMeasured": ["listening", "speaking", "writing"],
            "validity": validity,
            "calibrationVersion": str(row["calibration_version"]),
            "preliminary": sample_size < PRELIMINARY_SAMPLE_THRESHOLD,
            "sampleSize": sample_size,
            "disclaimer": DISCLAIMER,
        }
        return response
    except sqlite3.OperationalError as exc:
        raise AbilityUnavailable(
            f"定位测暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def _confidence_label(value: float) -> str:
    if value >= 0.75:
        return "high"
    if value >= 0.5:
        return "medium"
    return "low"


def _confidence_label_zh(value: float) -> str:
    return {"high": "高", "medium": "中", "low": "低"}[_confidence_label(value)]


# ---------------------------------------------------------------------------
# 自评
# ---------------------------------------------------------------------------

def _normalize_lang(lang: str | None) -> str:
    if lang in (None, "", "zh", "zh-CN", "zh-cn"):
        return "zh"
    if lang in ("vi", "vi-VN", "vi-vn"):
        return "vi"
    raise AbilityInvalid("lang 只支持 zh-CN / vi-VN。")


def _normalize_self_answers(
    answers, items_by_id: Mapping[str, dict]
) -> list[tuple[str, int]]:
    if not isinstance(answers, (list, tuple)):
        raise AbilityInvalid("answers 必须是数组。")
    if not SELF_ASSESS_MIN_ITEMS <= len(answers) <= SELF_ASSESS_MAX_ITEMS:
        raise AbilityInvalid(
            f"answers 必须为 {SELF_ASSESS_MIN_ITEMS}–{SELF_ASSESS_MAX_ITEMS} 条。"
        )
    normalized: list[tuple[str, int]] = []
    seen: set[str] = set()
    for index, raw in enumerate(answers):
        if not isinstance(raw, Mapping):
            raise AbilityInvalid(f"answers[{index}] 必须是对象。")
        item_id = raw.get("itemId", raw.get("item_id"))
        if not isinstance(item_id, str) or not item_id.strip():
            raise AbilityInvalid(f"answers[{index}] 缺少 itemId。")
        item_id = item_id.strip()
        if item_id in seen:
            raise AbilityInvalid(f"answers[{index}]：itemId 重复（{item_id}）。")
        if item_id not in items_by_id:
            raise AbilityInvalid(f"answers[{index}]：未知 itemId（{item_id}）。")
        rating = raw.get("rating")
        if isinstance(rating, bool) or not isinstance(rating, int):
            raise AbilityInvalid(f"answers[{index}]：rating 必须是整数。")
        if rating < -1 or rating > 3:
            raise AbilityInvalid(f"answers[{index}]：rating 必须在 -1–3。")
        seen.add(item_id)
        normalized.append((item_id, rating))
    return normalized


def _normalize_self_duration(duration_ms) -> int:
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
        raise AbilityInvalid("durationMs 必须是整数毫秒。")
    if duration_ms < SELF_ASSESS_MIN_DURATION_MS:
        raise AbilityInvalid("durationMs 太短（至少 30 秒）。")
    if duration_ms > SELF_ASSESS_MAX_DURATION_MS:
        raise AbilityInvalid("durationMs 太长（最多 30 分钟）。")
    return int(duration_ms)


def _self_skill_bands(
    normalized: Sequence[tuple[str, int]], items_by_id: Mapping[str, dict]
) -> dict[str, dict]:
    grouped: dict[str, list[tuple[str, int]]] = {
        skill: [] for skill in SELF_ASSESS_SKILLS
    }
    for item_id, rating in normalized:
        if rating < 0:
            continue
        item = items_by_id[item_id]
        grouped[str(item["skill"])].append((str(item["level"]), rating))
    result: dict[str, dict] = {}
    for skill, values in grouped.items():
        if not values:
            result[skill] = {"band": None, "items": 0, "mean": None}
            continue
        mean = round(sum(rating for _level, rating in values) / len(values), 4)
        at_least_basic = [
            level for level, rating in values if rating >= 2
        ]
        if at_least_basic:
            band = max(at_least_basic, key=lambda level: assessment.BAND_INDEX[level])
        else:
            band = min(
                (level for level, _rating in values),
                key=lambda level: assessment.BAND_INDEX[level],
            )
        result[skill] = {"band": band, "items": len(values), "mean": mean}
    return result


def _upsert_writing_self_report(
    conn: sqlite3.Connection,
    identity: str,
    session_result: Mapping,
    *,
    stamp: int,
) -> None:
    by_skill = session_result.get("bySkill") or {}
    entry = by_skill.get("writing") if isinstance(by_skill, dict) else None
    items = int(entry.get("items") or 0) if isinstance(entry, dict) else 0
    band = entry.get("band") if isinstance(entry, dict) else None
    evidence_count = conn.execute(
        "SELECT COUNT(*) AS total FROM skill_evidence "
        "WHERE user_id = ? AND skill = 'writing' AND evidence_type = 'self_assess'",
        (identity,),
    ).fetchone()["total"]
    details = {
        "selfReport": {
            "band": band,
            "items": items,
            "caveat": SELF_REPORT_CAVEAT,
        },
        "precision": {"label": "low", "se": None, "value": 0.55},
        "validity": {"label": "medium", "flags": ["self_report"], "value": 0.65},
        "note": "自评只作先验，不改变能力带，也不进入任何合成。",
    }
    confidence = min(SELF_REPORT_CONFIDENCE_CAP, 0.35)
    conn.execute(
        "INSERT INTO user_skill_profiles "
        "(user_id, skill, cefr_point, cefr_low, cefr_high, confidence, status, "
        "method, evidence_count, effective_n, last_evidence_at, details, "
        "calibration_version, schema_version, updated_at) "
        "VALUES (?, 'writing', NULL, NULL, NULL, ?, 'self_report', 'self_report', "
        "?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id, skill) DO UPDATE SET "
        "cefr_point = NULL, cefr_low = NULL, cefr_high = NULL, "
        "confidence = excluded.confidence, status = 'self_report', "
        "method = 'self_report', evidence_count = excluded.evidence_count, "
        "effective_n = excluded.effective_n, "
        "last_evidence_at = excluded.last_evidence_at, "
        "details = excluded.details, updated_at = excluded.updated_at",
        (
            identity,
            confidence,
            int(evidence_count or 0),
            round(min(1.0, 0.15 * int(evidence_count or 0)), 4),
            stamp,
            json.dumps(details, ensure_ascii=False, sort_keys=True),
            CALIBRATION_VERSION,
            SCHEMA_VERSION,
            stamp,
        ),
    )


def self_assess(
    identity: str,
    guest_hash: str | None,
    client_request_id: str,
    answers,
    duration_ms,
    *,
    lang: str = "zh-CN",
    now: int | None = None,
) -> dict:
    """``POST /api/ability/self-assess``：20 条自评 → 先验，不改任何能力带。"""
    if not identity:
        raise AbilityInvalid("缺少自评身份。")
    if not isinstance(client_request_id, str) or not client_request_id.strip():
        raise AbilityInvalid("缺少 clientRequestId。")
    client_request_id = client_request_id.strip()
    if len(client_request_id) > 128:
        raise AbilityInvalid("clientRequestId 过长。")
    content = load_self_assess()
    items = content.get("items") or []
    items_by_id = {str(item["id"]): item for item in items}
    normalized = _normalize_self_answers(answers, items_by_id)
    duration = _normalize_self_duration(duration_ms)
    stamp = int(now) if now is not None else now_ms()

    conn = _connect()
    try:
        _require_tables(conn)
        existing = conn.execute(
            "SELECT * FROM assessment_sessions "
            "WHERE user_id = ? AND client_request_id = ?",
            (identity, client_request_id),
        ).fetchone()
        if existing is not None:
            if existing["kind"] != "self_assess":
                raise AbilityConflict("clientRequestId 已被其他类型的会话占用。")
            return {
                "sessionId": existing["id"],
                "status": existing["status"],
                "reused": True,
                "evidenceAdded": 0,
                "profile": profile(identity, lang=lang, now=stamp),
                "disclaimer": DISCLAIMER,
            }

        retry_after = ratelimit.consume_daily(
            "self_assess",
            f"user:{identity}",
            SELF_ASSESS_DAILY_LIMIT,
            now=time.monotonic(),
        )
        if retry_after is not None:
            raise AbilityRateLimited(retry_after)

        by_skill = _self_skill_bands(normalized, items_by_id)
        session_result = {
            "schemaVersion": SCHEMA_VERSION,
            "calibrationVersion": CALIBRATION_VERSION,
            "bySkill": by_skill,
            "items": len(normalized),
            "durationMs": duration,
            "caveat": SELF_REPORT_CAVEAT,
        }
        session_id = uuid.uuid4().hex
        skills = [skill for skill, entry in by_skill.items() if entry["items"] > 0]
        started_at = max(0, stamp - duration)
        evidence_added = 0
        with conn:
            conn.execute(
                "INSERT INTO assessment_sessions "
                "(id, user_id, guest_hash, kind, status, client_request_id, "
                "started_at, submitted_at, duration_ms, score, confidence, "
                "skills, result, schema_version) "
                "VALUES (?, ?, ?, 'self_assess', 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    identity,
                    guest_hash,
                    client_request_id,
                    started_at,
                    stamp,
                    duration,
                    round(
                        sum(
                            (entry["mean"] or 0)
                            for entry in by_skill.values()
                            if entry["items"]
                        )
                        / max(1, len(skills)),
                        4,
                    ),
                    SELF_REPORT_CONFIDENCE_CAP,
                    json.dumps(skills, ensure_ascii=False),
                    json.dumps(session_result, ensure_ascii=False, sort_keys=True),
                    SCHEMA_VERSION,
                ),
            )
            for skill, entry in by_skill.items():
                if entry["items"] <= 0:
                    continue
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO skill_evidence "
                    "(user_id, skill, evidence_type, source_key, source_ref, band, "
                    "outcome, weight, confidence, observed_at, payload, created_at) "
                    "VALUES (?, ?, 'self_assess', ?, NULL, ?, ?, 0.15, ?, ?, ?, ?)",
                    (
                        identity,
                        skill,
                        f"{client_request_id}:{skill}",
                        entry["band"],
                        round(float(entry["mean"] or 0) / 3.0, 4),
                        SELF_REPORT_CONFIDENCE_CAP,
                        stamp,
                        json.dumps(
                            {"items": entry["items"], "scale": "0-3"},
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        stamp,
                    ),
                )
                evidence_added += max(0, cursor.rowcount)
            _upsert_writing_self_report(
                conn, identity, session_result, stamp=stamp
            )
        return {
            "sessionId": session_id,
            "status": "submitted",
            "reused": False,
            "evidenceAdded": evidence_added,
            "profile": profile(identity, lang=lang, now=stamp),
            "disclaimer": DISCLAIMER,
        }
    except sqlite3.IntegrityError:
        # 并发重复提交：唯一键兜底，返回先写入的那一次。
        row = conn.execute(
            "SELECT * FROM assessment_sessions "
            "WHERE user_id = ? AND client_request_id = ?",
            (identity, client_request_id),
        ).fetchone()
        if row is not None:
            return {
                "sessionId": row["id"],
                "status": row["status"],
                "reused": True,
                "evidenceAdded": 0,
                "profile": profile(identity, lang=lang, now=stamp),
                "disclaimer": DISCLAIMER,
            }
        raise AbilityConflict("自评提交冲突，请重试。")
    except sqlite3.OperationalError as exc:
        raise AbilityUnavailable(
            f"能力档案暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 公开 can-do
# ---------------------------------------------------------------------------

def can_do(level: str, skill: str, lang: str = "zh-CN") -> dict:
    """某级某技能的通用 can-do 描述（公开；不读用户身份）。"""
    if level not in assessment.CEFR_BANDS[:5]:
        raise AbilityInvalid("level 只支持 A1–C1。")
    if skill not in SELF_ASSESS_SKILLS:
        raise AbilityInvalid("skill 只支持 listening/speaking/reading/writing。")
    language = _normalize_lang(lang)
    content = load_can_do()
    items = [
        item
        for item in content["items"]
        if item.get("level") == level and item.get("skill") == skill
    ]
    if not items:
        raise AbilityNotFound("该级别/技能没有 can-do 描述。")
    payload = []
    for item in items:
        statement = item["statement"]
        observable = item.get("observable") or {}
        payload.append(
            {
                "id": item["id"],
                "level": item["level"],
                "skill": item["skill"],
                "statement": statement.get(language),
                "observable": observable.get(language),
                "basis": item.get("basis"),
            }
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "version": content.get("version"),
        "level": level,
        "skill": skill,
        "lang": "zh-CN" if language == "zh" else "vi-VN",
        "basis": content.get("basis"),
        "note": content.get("note"),
        "items": payload,
    }


# ---------------------------------------------------------------------------
# 隐私：账号删除钩子
# ---------------------------------------------------------------------------

def purge_user(identity: str) -> dict:
    """删除某归属键在能力新表里的全部数据（账号删除/隐私清理钩子）。

    当前产品没有自助注销端点；保留本函数给未来删除流程与隐私验收测试使用。
    只删 ``user_skill_profiles`` / ``skill_evidence`` / ``assessment_sessions``，
    定位测旧表由既有生命周期管理。
    """
    if not identity:
        return {"user_skill_profiles": 0, "skill_evidence": 0, "assessment_sessions": 0}
    conn = _connect()
    try:
        _require_tables(conn)
        counts = {}
        with conn:
            for table in (
                "skill_evidence",
                "assessment_sessions",
                "user_skill_profiles",
            ):
                cursor = conn.execute(
                    f"DELETE FROM {table} WHERE user_id = ?", (identity,)
                )
                counts[table] = max(0, cursor.rowcount)
        return counts
    finally:
        conn.close()
