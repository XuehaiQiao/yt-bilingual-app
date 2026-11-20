"""课程生成后端离线验收（specs/030）。

覆盖：

1. 迁移 0022：表/列/唯一缓存键/归属索引/回滚；
2. YouTube 源适配：读当前用户双语字幕、已有 zh 复用、无字幕/未翻译/太短 409；
3. 小说源：Gutenberg #1342 61 章切分、章节参数、抓取失败 502、机器译文标记；
4. 严格校验：词/形式点原文、答案合法、evidence 子串、题目数、词数；
   校验失败重试 1 次后 502 且不落库；
5. 缓存：同源同等级/语言第二次 `cached:true` 零模型调用、不占配额；等级隔离；
6. 并发：同 key 两个请求只调用一次模型（进程内单飞）；
7. 权限：游客 403 login_required、别人的生成课程 404/列表不泄露、attempt 可指向生成课程；
8. 配额：`feature=course_generation` 日限额 429；
9. API：缺参/非法等级/chapter 400、源未就绪 409、生成失败 502、详情脱敏。

全部离线：模型走 fake `generate_json_async`，小说正文由 fixture 提供，不联网；
数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移。
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path

import pytest

import books
import config
import course
import course_generator
import llm
import storage
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

PASSWORD = "course-gen-password-123"
SECOND_EMAIL = "course-gen-second@example.com"
VIDEO_ID = "coursegen001"
NOVEL_TEXT = ""


# ---------------------------------------------------------------------------
# 夹具 / 桩
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (course generation)",
    )


@pytest.fixture()
def gen_client(client):
    """已迁移到 head 的登录客户端；每个用例清空进程内课程缓存。"""
    _upgrade()
    course_generator.reset_caches()
    yield client
    course_generator.reset_caches()


@pytest.fixture()
def second_client(gen_client, make_client):
    """第二个登录用户（用于跨用户隔离）。"""
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": SECOND_EMAIL, "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


def _roman(number: int) -> str:
    values = (
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
        (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
        (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    )
    result = ""
    for value, symbol in values:
        while number >= value:
            result += symbol
            number -= value
    return result


_NOVEL_WORDS = (
    "quiet countryside Bennett family ancient mariners observed changing weather "
    "open sea village neighbours fortune marriage daughter father mother evening "
    "conversation carriage journey happiness property estate character opinion"
)


def _novel_paragraph(chapter: int, paragraph: int) -> str:
    words = _NOVEL_WORDS.split()
    body = " ".join(words[(paragraph + index) % len(words)] for index in range(48))
    return (
        f"Chapter {chapter} paragraph {paragraph} follows the {body}. "
        "The narrator describes ordinary people and their small decisions."
    )


def _make_novel_text() -> str:
    chunks = [
        "*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***",
        "",
    ]
    for chapter in range(1, 62):
        chunks.append(f"CHAPTER {_roman(chapter)}.")
        chunks.append("")
        for paragraph in range(1, 13):
            chunks.append(_novel_paragraph(chapter, paragraph))
            chunks.append("")
    chunks.append(
        "*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***"
    )
    return "\n".join(chunks)


def _youtube_blocks(count: int = 30) -> list[dict]:
    blocks = []
    for index in range(count):
        blocks.append(
            {
                "id": index + 1,
                "start": float(index * 5),
                "end": float(index * 5 + 5),
                "en_text": (
                    f"Block {index + 1} explains how ancient mariners studied the "
                    "changing weather and the open sea during long voyages."
                ),
                "zh_text": f"第{index + 1}块解释古代水手如何在漫长航行中研究变化的天气和开阔的海洋。",
            }
        )
    return blocks


def _write_history(
    client,
    video_id: str = VIDEO_ID,
    *,
    target_lang: str | None = None,
    blocks: list[dict] | None = None,
    title: str = "Course Generation Test",
) -> Path:
    root = Path(storage.user_history_dir(client.user_id, target_lang))
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"Test_20260101_{video_id}.json"
    payload = {
        "videoId": video_id,
        "metadata": {"title": title},
        "target_lang": storage._canonical_lang(target_lang),
        "transcript": blocks if blocks is not None else _youtube_blocks(),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z]+(?:['\-][A-Za-z]+)*", text))


def _sentences(text: str) -> list[str]:
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    return parts or [text.strip()]


def _question(text: str) -> dict:
    evidence = _sentences(text)[0][:500]
    return {
        "prompt": "What does the passage say about the topic?",
        "options": [
            {"id": "A", "text": "It describes ordinary people and small decisions"},
            {"id": "B", "text": "It lists cooking recipes"},
            {"id": "C", "text": "It explains car repairs"},
            {"id": "D", "text": "It sells train tickets"},
        ],
        "answer": "A",
        "explain": "原文说明普通人和他们的小决定。",
        "evidence": evidence,
    }


def _build_lesson_from_prompt(prompt: str) -> dict:
    """按 prompt 里的源段落造一份能过校验的课程 JSON。"""
    start = prompt.index("<<<SOURCE_PARAGRAPHS")
    end = prompt.index("SOURCE_PARAGRAPHS>>>")
    raw = prompt[start + len("<<<SOURCE_PARAGRAPHS") : end].strip()
    paragraphs = json.loads(raw)
    # 每步最多 2 个源单元；先每步放 1 个，再按顺序补到 2 个，直到总词数
    # 接近 300（模型在真实场景里也是这个选择逻辑）。
    step_units: list[list[dict]] = [[], [], []]
    for index, paragraph in enumerate(paragraphs[:6]):
        step_units[index % 3].append(paragraph)
        total = sum(
            _word_count(item["en"])
            for units in step_units
            for item in units
        )
        if index >= 2 and total >= 280:
            break
    chosen = [item for units in step_units for item in units]
    total = sum(_word_count(item["en"]) for item in chosen)
    while total > 450 and len(chosen) > 3:
        longest = max(range(3), key=lambda slot: len(step_units[slot]))
        removed = step_units[longest].pop()
        chosen.remove(removed)
        total -= _word_count(removed["en"])
    if len(chosen) < 3:
        raise AssertionError("fixture 源段落不足以组课")

    read_steps = []
    for index, step_paragraphs in enumerate(step_units):
        text = "\n\n".join(paragraph["en"] for paragraph in step_paragraphs)
        read_steps.append(
            {
                "title": f"精读 {index + 1}",
                "paragraphIds": [paragraph["id"] for paragraph in step_paragraphs],
                "explain": "先看事实，再看作者的态度。",
                "questions": [_question(text), _question(text)],
            }
        )

    all_text = "\n\n".join(paragraph["en"] for paragraph in chosen)
    chosen_words: list[str] = []
    seen: set[str] = set()
    for word in re.findall(r"[A-Za-z]{5,}", all_text):
        key = word.casefold()
        if key in seen:
            continue
        seen.add(key)
        chosen_words.append(word)
        if len(chosen_words) == 4:
            break
    assert len(chosen_words) == 4
    words_payload = []
    for word in chosen_words:
        evidence = next(
            sentence
            for sentence in _sentences(all_text)
            if re.search(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", sentence, re.I)
        )
        words_payload.append(
            {
                "kind": "word",
                "word": word,
                "ipa": "/test/",
                "meaning": "测试词义",
                "cefr": "B1",
                "example": evidence,
                "evidence": evidence[:500],
            }
        )
    form_evidence = _sentences(all_text)[0][:500]
    words_payload.append(
        {
            "kind": "form",
            "word": "the + noun + of + noun",
            "meaning": "测试形式点",
            "cefr": "B1",
            "example": form_evidence,
            "note": "名词所有格/限定结构。",
            "evidence": form_evidence,
        }
    )

    translations = {
        paragraph["id"]: f"第{paragraph['id']}段的机器译文。" for paragraph in chosen
    }
    return {
        "title": f"Generated lesson ({total} words)",
        "titleZh": "生成课程",
        "goal": "读懂原文并完成一个小产出。",
        "readSteps": read_steps,
        "words": words_payload,
        "output": {
            "prompt": "Explain one idea from the text in 2-5 sentences.",
            "targetWords": chosen_words[:2],
            "wordRange": {"B1": [40, 60]},
            "rubric": ["任务完成", "目标词", "可读性"],
            "sample": "The text describes ordinary people. They make small decisions. "
            "This shows how daily life works.",
            "exitTicket": [_question(all_text), _question(all_text)],
        },
        "translations": translations,
    }


class LlmStub:
    """记录 prompt、可控制失败/延迟/变形的异步 generate_json_async 桩。"""

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.calls = 0
        self.fail_times = 0
        self.delay = 0.0
        self.mutator = None

    async def generate_json_async(self, prompt: str, model: str | None = None):
        self.prompts.append(prompt)
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("model unavailable")
        payload = _build_lesson_from_prompt(prompt)
        if self.mutator is not None:
            self.mutator(payload)
        return json.dumps(payload, ensure_ascii=False)


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LlmStub()
    monkeypatch.setattr(llm, "generate_json_async", stub.generate_json_async)
    return stub


@pytest.fixture()
def novel_source(monkeypatch):
    """小说源：fixture 文本 + 记录抓取次数。"""
    text = _make_novel_text()
    calls = {"count": 0}

    def fake_fetch(url: str, *, timeout: float | None = None):
        calls["count"] += 1
        return text, url

    monkeypatch.setattr(books, "fetch_source_text", fake_fetch)
    course_generator.reset_caches()
    return calls


def _generate(client, **overrides) -> dict:
    body = {"sourceKind": "youtube", "videoId": VIDEO_ID}
    body.update(overrides)
    response = client.post("/api/course/generate", json=body)
    return {"status": response.status_code, "body": response.json()}


def _generate_ok(client, **overrides) -> dict:
    result = _generate(client, **overrides)
    assert result["status"] == 200, result["body"]
    return result["body"]


def _row_count() -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM generated_courses"
        ).fetchone()[0]


def _quota_used() -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        row = conn.execute(
            "SELECT used_units FROM ai_quota WHERE feature = 'course_generation'"
        ).fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# 1. 迁移 0022
# ---------------------------------------------------------------------------

def test_migration_0022_table_columns_indexes(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (0022)")
    assert revision(db) == "0025_balance_cost"
    assert "generated_courses" in table_names(db)

    cols = columns(db, "generated_courses")
    assert list(cols) == [
        "id",
        "owner_user_id",
        "source_kind",
        "source_ref",
        "content_hash",
        "level",
        "target_lang",
        "prompt_version",
        "title",
        "lesson_json",
        "status",
        "created_at",
    ]
    assert cols["id"]["pk"] == 1
    assert cols["status"]["default"] == "'ready'"
    assert cols["lesson_json"]["notnull"] == 1

    indexes = index_names(db, "generated_courses")
    assert "ux_generated_courses_cache" in indexes
    assert "ix_generated_courses_owner_created" in indexes
    with sqlite3.connect(db) as conn:
        unique = conn.execute("PRAGMA index_list('generated_courses')").fetchall()
    cache = next(row for row in unique if row[1] == "ux_generated_courses_cache")
    assert cache[2] == 1


def test_migration_0022_unique_cache_key_and_downgrade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    insert = (
        "INSERT INTO generated_courses "
        "(id, owner_user_id, source_kind, source_ref, content_hash, level, "
        " target_lang, prompt_version, title, lesson_json, status, created_at) "
        "VALUES (?, 'u1', 'youtube', ?, ?, 'orbit', 'zh-CN', ?, 't', '{}', 'ready', 1)"
    )
    key = (VIDEO_ID, "hash", "course-gen.v1")
    with sqlite3.connect(db) as conn:
        conn.execute(insert, ("gen-a", *key))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert, ("gen-b", *key))

    assert_alembic_ok(run_alembic(db, "downgrade", "0021_course_mvp"), "downgrade 0022")
    assert "generated_courses" not in table_names(db)
    assert revision(db) == "0021_course_mvp"


# ---------------------------------------------------------------------------
# 2. YouTube 源适配
# ---------------------------------------------------------------------------

def test_youtube_source_missing_history_is_409(gen_client, llm_stub):
    result = _generate(gen_client)
    assert result["status"] == 409
    assert "source_not_ready" in result["body"]["detail"]
    assert llm_stub.calls == 0


def test_youtube_source_uses_existing_zh(gen_client, llm_stub):
    _write_history(gen_client)
    payload = _generate_ok(gen_client)
    assert payload["cached"] is False
    assert payload["level"] == "orbit"
    detail = gen_client.get(f"/api/course/lessons/{payload['lessonId']}")
    assert detail.status_code == 200, detail.text
    lesson = detail.json()
    paragraphs = [
        paragraph
        for step in lesson["steps"]
        if step["type"] == "read"
        for paragraph in step["paragraphs"]
    ]
    assert paragraphs
    for paragraph in paragraphs:
        assert paragraph["zhSource"] == "existing"
        assert "第" in paragraph["zh"]
        assert "机器译文" not in paragraph["zh"]
    assert lesson["source"]["kind"] == "youtube"
    assert lesson["source"]["videoId"] == VIDEO_ID


def test_youtube_only_untranslated_is_409(gen_client, llm_stub):
    blocks = _youtube_blocks()
    for block in blocks:
        block["zh_text"] = "[未翻译]"
    _write_history(gen_client, blocks=blocks)
    result = _generate(gen_client)
    assert result["status"] == 409
    assert "source_not_ready" in result["body"]["detail"]
    assert llm_stub.calls == 0


def test_youtube_too_short_is_409(gen_client, llm_stub):
    _write_history(gen_client, blocks=_youtube_blocks(3))
    result = _generate(gen_client)
    assert result["status"] == 409
    assert "source_not_ready" in result["body"]["detail"]
    assert llm_stub.calls == 0


def test_youtube_target_lang_mismatch_is_409(gen_client, llm_stub):
    _write_history(gen_client)  # zh-CN 缓存
    result = _generate(gen_client, targetLang="vi-VN")
    assert result["status"] == 409
    assert "source_not_ready" in result["body"]["detail"]


def _to_final_schema(payload: dict, prompt: str) -> dict:
    """把内部候选格式转成「完整 029 lesson JSON」，用于兼容性测试。"""
    start = prompt.index("<<<SOURCE_PARAGRAPHS")
    end = prompt.index("SOURCE_PARAGRAPHS>>>")
    paragraphs = {
        item["id"]: item
        for item in json.loads(
            prompt[start + len("<<<SOURCE_PARAGRAPHS") : end].strip()
        )
    }
    steps: list[dict] = [
        {"id": "S0", "type": "intro", "title": "intro", "body": "intro"},
        {
            "id": "S1",
            "type": "words",
            "title": "words",
            "points": [
                {**point, "id": f"W{index + 1}"}
                for index, point in enumerate(payload["words"])
            ],
        },
    ]
    for index, read_step in enumerate(payload["readSteps"]):
        questions = []
        for question in read_step["questions"]:
            item = dict(question)
            item.pop("evidence", None)
            questions.append(item)
        steps.append(
            {
                "id": f"S{index + 2}",
                "type": "read",
                "title": read_step["title"],
                "paragraphs": [
                    {
                        "en": paragraphs[paragraph_id]["en"],
                        "zh": payload["translations"][paragraph_id],
                    }
                    for paragraph_id in read_step["paragraphIds"]
                ],
                "explain": read_step["explain"],
                "questions": questions,
            }
        )
    output = dict(payload["output"])
    output["exitTicket"] = [
        {key: value for key, value in question.items() if key != "evidence"}
        for question in output["exitTicket"]
    ]
    steps.append({"id": "S5", "type": "output", "title": "output", **output})
    return {
        "schema": "linguatrek.course-lesson.v1",
        "id": "pending",
        "version": 1,
        "status": "ready",
        "title": payload["title"],
        "titleZh": payload["titleZh"],
        "goal": payload["goal"],
        "steps": steps,
    }


# ---------------------------------------------------------------------------
# 3. 小说源：切章 / 缓存 / 失败 / 机器译文
# ---------------------------------------------------------------------------

def test_generation_accepts_full_lesson_schema(gen_client, monkeypatch, novel_source):
    """模型直接回 schema 029 的完整 lesson 时也能落库（缺 evidence 从原文补）。"""

    async def fake_generate_json_async(prompt: str, model: str | None = None):
        return json.dumps(
            _to_final_schema(_build_lesson_from_prompt(prompt), prompt),
            ensure_ascii=False,
        )

    monkeypatch.setattr(llm, "generate_json_async", fake_generate_json_async)
    payload = _generate_ok(
        gen_client, sourceKind="novel", gutenbergId=1342, chapter=1
    )
    detail = gen_client.get(f"/api/course/lessons/{payload['lessonId']}")
    assert detail.status_code == 200, detail.text
    lesson = detail.json()
    questions = [
        question
        for step in lesson["steps"]
        for question in (step.get("questions") or [])
    ]
    assert len(questions) == 6
    assert '"answer"' not in json.dumps(lesson)


def test_novel_generation_chapter_one(gen_client, llm_stub, novel_source):
    payload = _generate_ok(
        gen_client, sourceKind="novel", gutenbergId=1342, chapter=1
    )
    assert payload["sourceKind"] == "novel"
    assert payload["level"] == "orbit"
    detail = gen_client.get(f"/api/course/lessons/{payload['lessonId']}")
    assert detail.status_code == 200, detail.text
    lesson = detail.json()
    assert lesson["source"]["license"] == "Public domain in the US"
    assert lesson["source"]["sourceUrl"].startswith("https://www.gutenberg.org/")
    assert lesson["source"]["chapter"] == 1
    assert lesson["source"]["translation"] == "machine_translation"
    paragraphs = [
        paragraph
        for step in lesson["steps"]
        if step["type"] == "read"
        for paragraph in step["paragraphs"]
    ]
    assert paragraphs
    assert all(paragraph["zhSource"] == "machine_translation" for paragraph in paragraphs)
    assert all(paragraph["zh"] for paragraph in paragraphs)
    assert novel_source["count"] == 1
    # 同一次进程内缓存：换等级生成不应重新抓公版源。
    _generate_ok(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1, level="moonwalk")
    assert novel_source["count"] == 1


def test_novel_split_has_61_chapters():
    chapters = course_generator.split_novel_chapters(_make_novel_text())
    assert len(chapters) == 61
    assert set(chapters) == set(range(1, 62))
    assert chapters[1][0] == "Chapter I"
    assert chapters[61][0] == "Chapter LXI"
    assert chapters[1][1]


def test_novel_bad_chapter_and_book_are_400(gen_client, llm_stub, novel_source):
    for body in (
        {"sourceKind": "novel", "gutenbergId": 1342, "chapter": 62},
        {"sourceKind": "novel", "gutenbergId": 1342, "chapter": 0},
        {"sourceKind": "novel", "gutenbergId": 11, "chapter": 1},
    ):
        result = _generate(gen_client, **body)
        assert result["status"] == 400, result
    assert llm_stub.calls == 0


def test_novel_source_failure_is_502(gen_client, llm_stub, monkeypatch):
    def fail(*args, **kwargs):
        raise books.BookSourceUnavailable("network down")

    monkeypatch.setattr(books, "fetch_source_text", fail)
    course_generator.reset_caches()
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert "generation_failed" in result["body"]["detail"]
    assert _row_count() == 0


# ---------------------------------------------------------------------------
# 4. 严格校验
# ---------------------------------------------------------------------------

def test_validation_rejects_bad_answer_and_retries_once(
    gen_client, llm_stub, novel_source
):
    def bad_answer(payload: dict) -> None:
        payload["readSteps"][0]["questions"][0]["answer"] = "Z"

    llm_stub.mutator = bad_answer
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert "generation_failed" in result["body"]["detail"]
    assert llm_stub.calls == 2  # 首次 + 严格重试 1 次
    assert _row_count() == 0


def test_validation_rejects_evidence_not_in_source(gen_client, llm_stub, novel_source):
    def bad_evidence(payload: dict) -> None:
        payload["readSteps"][1]["questions"][0]["evidence"] = "This sentence is not in the text."

    llm_stub.mutator = bad_evidence
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert llm_stub.calls == 2
    assert _row_count() == 0


def test_validation_rejects_word_not_in_source(gen_client, llm_stub, novel_source):
    def bad_word(payload: dict) -> None:
        payload["words"][0]["word"] = "zzzznotinthetext"
        payload["words"][0]["evidence"] = "zzzznotinthetext"

    llm_stub.mutator = bad_word
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert _row_count() == 0


def test_validation_rejects_wrong_step_question_count(
    gen_client, llm_stub, novel_source
):
    def missing_questions(payload: dict) -> None:
        payload["readSteps"][0]["questions"] = payload["readSteps"][0]["questions"][:1]

    llm_stub.mutator = missing_questions
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert _row_count() == 0


def test_validation_rejects_word_count_out_of_range(
    gen_client, llm_stub, novel_source
):
    def too_short(payload: dict) -> None:
        ids = [step["paragraphIds"][0] for step in payload["readSteps"]]
        for step, paragraph_id in zip(payload["readSteps"], ids):
            step["paragraphIds"] = [paragraph_id]
        # 3 段 ×55 词 ≈165 词，低于 200 词下限。

    llm_stub.mutator = too_short
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert llm_stub.calls == 2


def test_validation_rejects_missing_machine_translation(
    gen_client, llm_stub, novel_source
):
    def drop_translations(payload: dict) -> None:
        payload["translations"] = {}

    llm_stub.mutator = drop_translations
    result = _generate(gen_client, sourceKind="novel", gutenbergId=1342, chapter=1)
    assert result["status"] == 502
    assert _row_count() == 0


def test_generation_retries_after_model_error(gen_client, llm_stub):
    _write_history(gen_client)
    llm_stub.fail_times = 1
    payload = _generate_ok(gen_client)
    assert payload["lessonId"].startswith("gen-")
    assert llm_stub.calls == 2


def test_generation_fails_after_two_model_errors(gen_client, llm_stub):
    _write_history(gen_client)
    llm_stub.fail_times = 10
    result = _generate(gen_client)
    assert result["status"] == 502
    assert "generation_failed" in result["body"]["detail"]
    assert _row_count() == 0


# ---------------------------------------------------------------------------
# 5. 缓存 / 配额
# ---------------------------------------------------------------------------

def test_second_generation_is_cached_and_free(gen_client, llm_stub):
    _write_history(gen_client)
    first = _generate_ok(gen_client)
    assert first["cached"] is False
    assert llm_stub.calls == 1
    assert _quota_used() == 1

    second = _generate_ok(gen_client)
    assert second["cached"] is True
    assert second["lessonId"] == first["lessonId"]
    assert llm_stub.calls == 1
    assert _quota_used() == 1
    assert _row_count() == 1


def test_cache_is_isolated_by_level(gen_client, llm_stub):
    _write_history(gen_client)
    first = _generate_ok(gen_client, level="orbit")
    second = _generate_ok(gen_client, level="moonwalk")
    assert first["lessonId"] != second["lessonId"]
    assert second["cached"] is False
    assert llm_stub.calls == 2
    assert _row_count() == 2


def test_cache_is_isolated_by_user(gen_client, second_client, llm_stub):
    _write_history(gen_client)
    first = _generate_ok(gen_client)
    # 第二个用户没有字幕缓存 → 409，不会拿到别人的课程。
    result = _generate(second_client)
    assert result["status"] == 409
    assert llm_stub.calls == 1
    assert first["lessonId"]


def test_concurrent_same_key_generates_once(gen_client, llm_stub):
    _write_history(gen_client)
    llm_stub.delay = 0.05

    async def run_twice():
        return await asyncio.gather(
            course_generator.generate_course(
                gen_client.user_id,
                source_kind="youtube",
                video_id=VIDEO_ID,
                level="orbit",
                target_lang="zh-CN",
            ),
            course_generator.generate_course(
                gen_client.user_id,
                source_kind="youtube",
                video_id=VIDEO_ID,
                level="orbit",
                target_lang="zh-CN",
            ),
        )

    token = storage.current_user_id.set(gen_client.user_id)
    try:
        first, second = asyncio.run(run_twice())
    finally:
        storage.current_user_id.reset(token)
    assert first["lessonId"] == second["lessonId"]
    assert {first["cached"], second["cached"]} == {False, True}
    assert llm_stub.calls == 1
    assert _row_count() == 1
    assert _quota_used() == 1


def test_quota_limit_returns_429(gen_client, llm_stub, monkeypatch):
    _write_history(gen_client)
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_COURSE_GENERATION", 1, raising=False)
    first = _generate_ok(gen_client, level="orbit")
    assert first["cached"] is False
    result = _generate(gen_client, level="moonwalk")
    assert result["status"] == 429, result
    assert _row_count() == 1
    assert llm_stub.calls == 1


# ---------------------------------------------------------------------------
# 6. API / 权限 / 动态课程
# ---------------------------------------------------------------------------

def test_generate_requires_login(gen_client, make_client, llm_stub):
    _write_history(gen_client)
    with make_client() as guest:
        response = guest.post(
            "/api/course/generate",
            json={"sourceKind": "youtube", "videoId": VIDEO_ID},
        )
    assert response.status_code == 403
    assert response.json().get("code") == "login_required"
    assert llm_stub.calls == 0


def test_generate_accepts_cefr_level(gen_client, llm_stub):
    _write_history(gen_client)
    payload = _generate_ok(gen_client, level="B1")
    assert payload["level"] == "B1"
    # 默认等级 orbit。
    default = _generate_ok(gen_client, level=None)
    assert default["level"] == "orbit"


def test_generate_invalid_params_are_400(gen_client, llm_stub):
    for body in (
        {"sourceKind": "article", "videoId": VIDEO_ID},
        {"sourceKind": "youtube", "videoId": None},
        {"sourceKind": "youtube", "videoId": "bad id!"},
        {"sourceKind": "youtube", "videoId": VIDEO_ID, "level": "nope"},
    ):
        result = _generate(gen_client, **body)
        assert result["status"] == 400, (body, result)
    assert llm_stub.calls == 0


def test_generated_lesson_list_detail_and_attempt(
    gen_client, second_client, llm_stub
):
    _write_history(gen_client)
    payload = _generate_ok(gen_client)
    lesson_id = payload["lessonId"]

    listing = gen_client.get("/api/course/lessons")
    assert listing.status_code == 200
    lessons = listing.json()["lessons"]
    assert any(
        item["id"] == lesson_id and item["generated"] is True for item in lessons
    )

    detail = gen_client.get(f"/api/course/lessons/{lesson_id}")
    assert detail.status_code == 200, detail.text
    lesson = detail.json()
    assert '"answer"' not in json.dumps(lesson)
    assert all(
        "answer" not in question
        for step in lesson["steps"]
        for question in (step.get("questions") or [])
    )

    attempt = gen_client.post("/api/course/attempts", json={"lessonId": lesson_id})
    assert attempt.status_code == 200, attempt.text
    attempt_id = attempt.json()["attemptId"]
    answered = gen_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q1", "choice": "A"},
    )
    assert answered.status_code == 200, answered.text
    assert answered.json()["correct"] is True

    # 其他人看不到、也进不去。
    other_detail = second_client.get(f"/api/course/lessons/{lesson_id}")
    assert other_detail.status_code == 404
    other_start = second_client.post(
        "/api/course/attempts", json={"lessonId": lesson_id}
    )
    assert other_start.status_code == 404
    other_list = second_client.get("/api/course/lessons").json()["lessons"]
    assert all(item["id"] != lesson_id for item in other_list)


def test_static_lesson_still_works_for_everyone(gen_client, second_client):
    response = second_client.get("/api/course/lessons/ocean-noise-12min")
    assert response.status_code == 200
    assert response.json()["id"] == "ocean-noise-12min"


def test_generated_course_corrupt_row_is_503(gen_client, llm_stub):
    _write_history(gen_client)
    payload = _generate_ok(gen_client)
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "UPDATE generated_courses SET lesson_json = '{broken' WHERE id = ?",
            (payload["lessonId"],),
        )
    response = gen_client.get(f"/api/course/lessons/{payload['lessonId']}")
    assert response.status_code == 503
