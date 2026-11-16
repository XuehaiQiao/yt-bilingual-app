"""ability：分技能画像 + 证据（计划书 §7.2，specs/025）。

Revision ID: 0014_ability
Revises: 0013_user_profile
Create Date: 2026-11-17

M1「CEFR 能力标定」的存储层第一块：

- ``user_skill_profiles``：每用户每技能**当前值**（聚合读模型）。
  - PK ``(user_id, skill)``；``skill`` CHECK 六值；
  - ``cefr_point/low/high`` 可空（``self_report`` 行必须为空，K20）；
  - ``status`` CHECK ``uncalibrated/measured/estimated/self_report``；
    M1 代码断言 ``measured`` 不可达（迁移不限制，M2 达标后才开放）；
  - ``method`` CHECK ``placement/test/behavior/self_report/writing_task/
    speaking_task/composite``；
  - ``details`` 是 JSON 文本（精度/可信度/can-do/证据/自评等）；
  - ``calibration_version`` / ``schema_version`` 非空，没有版本号的结果不展示；
  - 索引 ``(user_id, updated_at)``。
  **不建 not_measured 行**：缺失技能由 API 合成 ``not_measured``。

- ``skill_evidence``：append-only 证据流水。
  - ``UNIQUE(user_id, evidence_type, source_key)`` 保证重复提交幂等；
  - 只存 item id / band / outcome / 耗时等小字段，**不存用户原文、不存 PII**；
  - 索引 ``(user_id, skill, observed_at)``；保留策略由后续清理任务执行
    （M1 只写不删，账号删除除外）。

- ``placement_answers.elapsed_ms``：单题真实用时（K21/F7）；旧行保持 NULL，
  缺省时该题的可信度记「用时未知」而不惩罚。

- **seed**：把旧 ``user_profiles.vocab_estimate`` 映射成 vocabulary 行，
  ``status='uncalibrated'``、``confidence`` 沿用但 cap 0.85；
  ``reading_estimate`` **不建 reading 行**（M1 阅读由 API 合成 insufficient）。
  映射边界：<2,250 → A1；<4,000 → A2；<6,500 → B1；<10,000 → B2；
  其余 → C1；NULL → 只建词汇空行（cefr 三列 NULL）。

downgrade 删除两张新表并移除 ``elapsed_ms`` 列；``user_profiles`` 旧数据保留。
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014_ability"
down_revision: str = "0013_user_profile"
branch_labels: str | None = None
depends_on: str | None = None

PROFILES = "user_skill_profiles"
EVIDENCE = "skill_evidence"
ANSWERS = "placement_answers"
LEGACY_PROFILES = "user_profiles"

INDEX_PROFILES_USER_UPDATED = "ix_user_skill_profiles_user_updated"
INDEX_EVIDENCE_USER_SKILL_TIME = "ix_skill_evidence_user_skill_time"
UNIQUE_EVIDENCE_SOURCE = "ux_skill_evidence_source"

SKILLS = (
    "vocabulary",
    "grammar",
    "listening",
    "reading",
    "speaking",
    "writing",
)
STATUSES = ("uncalibrated", "measured", "estimated", "self_report")
METHODS = (
    "placement",
    "test",
    "behavior",
    "self_report",
    "writing_task",
    "speaking_task",
    "composite",
)
EVIDENCE_TYPES = (
    "placement_answer",
    "quiz_attempt",
    "review_state",
    "watch_behavior",
    "dictation",
    "reading_progress",
    "self_assess",
    "writing_sample",
    "speaking_sample",
)
CEFR_BANDS = ("A1", "A2", "B1", "B2", "C1", "C2")
SCHEMA_VERSION = "ability.v1"
CALIBRATION_VERSION = "rasch.eap.v1"
MAX_DURATION_MS = 86_400_000
CONFIDENCE_CAP = 0.85


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def _seed_band(vocab_estimate: int | None) -> str | None:
    """旧词汇量 → CEFR 带（仅迁移使用；阈值冻结在计划书 §7.3）。"""
    if vocab_estimate is None:
        return None
    if vocab_estimate < 2_250:
        return "A1"
    if vocab_estimate < 4_000:
        return "A2"
    if vocab_estimate < 6_500:
        return "B1"
    if vocab_estimate < 10_000:
        return "B2"
    return "C1"


def _band_window(band: str | None) -> tuple[str | None, str | None]:
    if band is None:
        return None, None
    index = CEFR_BANDS.index(band)
    low = CEFR_BANDS[max(0, index - 1)]
    high = CEFR_BANDS[min(len(CEFR_BANDS) - 1, index + 1)]
    return low, high


def _seed_details(vocab_estimate: int | None, confidence: float) -> dict:
    """旧画像回填的 details：只写来源与粗略区间，不伪造题目级精度。"""
    band = _seed_band(vocab_estimate)
    details: dict = {
        "source": "legacy_seed",
        "seededFrom": "user_profiles.vocab_estimate",
        "precision": {"label": "low", "se": None, "value": 0.55},
        "validity": {"label": "medium", "flags": ["legacy_seed"], "value": 0.65},
        "confidence": confidence,
        "note": "旧版词汇量回填：只有粗略区间，没有题目级证据。",
    }
    if vocab_estimate is not None:
        low = max(0, int(round((vocab_estimate - 2_500) / 100.0)) * 100)
        high = int(round((vocab_estimate + 2_500) / 100.0)) * 100
        details["estimate"] = {
            "point": int(vocab_estimate),
            "low": low,
            "high": high,
            "unit": "lemma",
            "method": "legacy_mapping",
        }
        details["interval"] = {
            "low": band,
            "high": _band_window(band)[1],
            "label": f"{band}–{_band_window(band)[1]}",
        }
    else:
        details["note"] = "旧画像没有词汇量估计：只建空行，等下一次定位测填充。"
    return details


def _seed_profiles() -> None:
    """从旧 ``user_profiles`` 回填 vocabulary 行（幂等，不覆盖已有行）。"""
    if LEGACY_PROFILES not in _table_names():
        return
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT user_id, vocab_estimate, confidence, updated_at "
            "FROM user_profiles"
        )
    ).fetchall()
    for user_id, vocab_estimate, confidence, updated_at in rows:
        band = _seed_band(vocab_estimate)
        low, high = _band_window(band)
        capped = min(float(confidence), CONFIDENCE_CAP)
        details = _seed_details(vocab_estimate, capped)
        bind.execute(
            sa.text(
                "INSERT INTO user_skill_profiles "
                "(user_id, skill, cefr_point, cefr_low, cefr_high, confidence, "
                "status, method, evidence_count, effective_n, last_evidence_at, "
                "details, calibration_version, schema_version, updated_at) "
                "VALUES (:user_id, 'vocabulary', :point, :low, :high, :confidence, "
                "'uncalibrated', 'placement', 0, 0.0, :updated_at, :details, "
                ":calibration, :schema, :updated_at) "
                "ON CONFLICT(user_id, skill) DO NOTHING"
            ),
            {
                "user_id": user_id,
                "point": band,
                "low": low,
                "high": high,
                "confidence": capped,
                "updated_at": int(updated_at),
                "details": json.dumps(details, ensure_ascii=False, sort_keys=True),
                "calibration": CALIBRATION_VERSION,
                "schema": SCHEMA_VERSION,
            },
        )


def upgrade() -> None:
    """建两张新表、加 elapsed_ms、回填旧词汇量（幂等）。"""
    tables = _table_names()

    if PROFILES not in tables:
        op.create_table(
            PROFILES,
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("skill", sa.Text(), nullable=False),
            sa.Column("cefr_point", sa.Text(), nullable=True),
            sa.Column("cefr_low", sa.Text(), nullable=True),
            sa.Column("cefr_high", sa.Text(), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("method", sa.Text(), nullable=False),
            sa.Column(
                "evidence_count", sa.Integer(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column(
                "effective_n", sa.Float(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column("last_evidence_at", sa.Integer(), nullable=True),
            sa.Column(
                "details", sa.Text(), nullable=False, server_default=sa.text("'{}'")
            ),
            sa.Column("calibration_version", sa.Text(), nullable=False),
            sa.Column(
                "schema_version",
                sa.Text(),
                nullable=False,
                server_default=sa.text(f"'{SCHEMA_VERSION}'"),
            ),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.PrimaryKeyConstraint("user_id", "skill"),
            sa.CheckConstraint(_in_check("skill", SKILLS), name="ck_skill_profiles_skill"),
            sa.CheckConstraint(
                _in_check("status", STATUSES), name="ck_skill_profiles_status"
            ),
            sa.CheckConstraint(
                _in_check("method", METHODS), name="ck_skill_profiles_method"
            ),
            sa.CheckConstraint(
                "cefr_point IS NULL OR " + _in_check("cefr_point", CEFR_BANDS),
                name="ck_skill_profiles_point",
            ),
            sa.CheckConstraint(
                "cefr_low IS NULL OR " + _in_check("cefr_low", CEFR_BANDS),
                name="ck_skill_profiles_low",
            ),
            sa.CheckConstraint(
                "cefr_high IS NULL OR " + _in_check("cefr_high", CEFR_BANDS),
                name="ck_skill_profiles_high",
            ),
            sa.CheckConstraint(
                "cefr_low IS NULL OR cefr_high IS NULL OR cefr_low <= cefr_high",
                name="ck_skill_profiles_window",
            ),
            # K20：自评行不得携带任何 CEFR 点/区间，band 只放 details.selfReport。
            sa.CheckConstraint(
                "status != 'self_report' OR "
                "(cefr_point IS NULL AND cefr_low IS NULL AND cefr_high IS NULL)",
                name="ck_skill_profiles_self_report",
            ),
            sa.CheckConstraint(
                "confidence BETWEEN 0 AND 1", name="ck_skill_profiles_confidence"
            ),
            sa.CheckConstraint(
                "evidence_count >= 0", name="ck_skill_profiles_evidence_count"
            ),
            sa.CheckConstraint("effective_n >= 0", name="ck_skill_profiles_effective_n"),
        )

    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(PROFILES)}
    if INDEX_PROFILES_USER_UPDATED not in indexes:
        op.create_index(
            INDEX_PROFILES_USER_UPDATED,
            PROFILES,
            ["user_id", "updated_at"],
        )

    tables = _table_names()
    if EVIDENCE not in tables:
        op.create_table(
            EVIDENCE,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("skill", sa.Text(), nullable=False),
            sa.Column("evidence_type", sa.Text(), nullable=False),
            sa.Column("source_key", sa.Text(), nullable=False),
            sa.Column("source_ref", sa.Text(), nullable=True),
            sa.Column("band", sa.Text(), nullable=True),
            sa.Column("outcome", sa.Float(), nullable=True),
            sa.Column("weight", sa.Float(), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=True),
            sa.Column("observed_at", sa.Integer(), nullable=False),
            sa.Column("payload", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(_in_check("skill", SKILLS), name="ck_skill_evidence_skill"),
            sa.CheckConstraint(
                _in_check("evidence_type", EVIDENCE_TYPES),
                name="ck_skill_evidence_type",
            ),
            sa.CheckConstraint(
                "band IS NULL OR " + _in_check("band", CEFR_BANDS),
                name="ck_skill_evidence_band",
            ),
            sa.CheckConstraint(
                "outcome IS NULL OR outcome BETWEEN 0 AND 1",
                name="ck_skill_evidence_outcome",
            ),
            sa.CheckConstraint(
                "weight IS NULL OR weight BETWEEN 0 AND 1",
                name="ck_skill_evidence_weight",
            ),
            sa.CheckConstraint(
                "confidence IS NULL OR confidence BETWEEN 0 AND 1",
                name="ck_skill_evidence_confidence",
            ),
            sa.UniqueConstraint(
                "user_id",
                "evidence_type",
                "source_key",
                name=UNIQUE_EVIDENCE_SOURCE,
            ),
        )
        op.create_index(
            INDEX_EVIDENCE_USER_SKILL_TIME,
            EVIDENCE,
            ["user_id", "skill", "observed_at"],
        )

    if ANSWERS in _table_names() and "elapsed_ms" not in _column_names(ANSWERS):
        op.add_column(ANSWERS, sa.Column("elapsed_ms", sa.Integer(), nullable=True))

    _seed_profiles()


def downgrade() -> None:
    """按依赖反向回滚；旧 ``user_profiles`` 不动。仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (EVIDENCE, PROFILES):
        if table in tables:
            op.drop_table(table)
    if ANSWERS in _table_names() and "elapsed_ms" in _column_names(ANSWERS):
        op.drop_column(ANSWERS, "elapsed_ms")
