"""P1-17 B1：内置公版书章节翻译「批次并行 + 计时 + 缓存写安全」的离线验收。

覆盖卡片 acceptance：

1. 默认 3 路并发（1–4 可调）；按批顺序合并；wall time 接近 max 而非 sum；
2. 成功批次立即落缓存、部分失败保留成功段、重试只补缺失段；
3. 整章无论多少批，每日限额只扣 1 次；
4. 缓存写串行化/加锁：并发快照只增不减，不互相覆盖；
5. 结构化日志 ``feature=book_translation`` 含 book/chapter、batch_count、
   每批 duration_ms、total_ms、concurrency。

全部离线：公版源替换 ``books.fetch_source_text``，模型批次替换
``book_translation._translate_batch``（带真实 ``asyncio.sleep`` 模拟耗时）；
数据库沿用 conftest 的 tmp SQLite + 真实 Alembic 迁移。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import book_translation
import books
import config
import llm
from tests.migration_utils import assert_alembic_ok, run_alembic

TEMPLATE_DB = "book-translation-parallel-template"
SOURCE_URL = "https://www.gutenberg.org/cache/epub/998/pg998.txt"

# 第 1 章 6 段（配合批大小 2 = 3 批），第 2/3 章各 2 段（限额用例）。
SOURCE = """*** START OF THE PROJECT GUTENBERG EBOOK PARALLEL TEST BOOK ***

Chapter One

One alpha.

One beta.

One gamma.

One delta.

One epsilon.

One zeta.

Chapter Two

Two alpha.

Two beta.

Chapter Three

Three alpha.

Three beta.

*** END OF THE PROJECT GUTENBERG EBOOK PARALLEL TEST BOOK ***
"""


def _manifest() -> dict:
    book = {
        "id": "parallel-book",
        "title": "Parallel Test Book",
        "titleZh": "并行测试书",
        "author": "Test Author",
        "year": 1901,
        "level": "B1",
        "status": "available",
        "source": "Project Gutenberg",
        "license": "Public domain in the US",
        "publicDomainBasis": "First published in 1901; US public domain as of 2026.",
        "sourceUrl": SOURCE_URL,
        "catalogUrl": "https://www.gutenberg.org/ebooks/998",
        "gutenbergId": 998,
        "words": 120,
        "totalChapters": 3,
        "parser": {"mode": "anchors"},
        "chapters": [
            {"n": 1, "title": "Chapter One", "anchor": "Chapter One"},
            {"n": 2, "title": "Chapter Two", "anchor": "Chapter Two"},
            {"n": 3, "title": "Chapter Three", "anchor": "Chapter Three"},
        ],
    }
    return {
        "_meta": {"schema": "books.v2"},
        "series": [
            {
                "id": "parallel-series",
                "title": "并行测试系列",
                "author": "Test Author",
                "description": "用于并行翻译离线测试的系列。",
                "excluded": [],
                "books": [book],
            }
        ],
    }


def _write_fixture(root: Path) -> Path:
    directory = root / "books-parallel"
    (directory / "parallel-book" / "chapters").mkdir(parents=True, exist_ok=True)
    (directory / "books.json").write_text(
        json.dumps(_manifest(), ensure_ascii=False), encoding="utf-8"
    )
    return directory


@pytest.fixture(scope="module")
def migrated_template_db(tmp_path_factory):
    path = tmp_path_factory.mktemp(TEMPLATE_DB) / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture(autouse=True)
def isolated_book_translation(
    isolated_data, tmp_path, migrated_template_db, monkeypatch
):
    """隔离书单/数据库/进程锁；公版源与批间停顿全部离线替换。"""
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    target = Path(config.AUTH_DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(migrated_template_db, target)
    books.reset_cache()
    book_translation.reset_locks()
    book_translation._warned_unavailable = False
    monkeypatch.setattr(
        books,
        "fetch_source_text",
        lambda url, timeout=None: (SOURCE, url),
    )
    monkeypatch.setattr(llm, "batch_pause", lambda model: 0.0)
    # 默认批大小 8 会让 6 段只有 1 批；这里固定 2 段/批 → 3 批，便于测并发。
    monkeypatch.setattr(book_translation, "TRANSLATE_BATCH_PARAGRAPHS", 2)
    yield directory
    books.reset_cache()
    book_translation.reset_locks()


class BatchRecorder:
    """替换 ``_translate_batch``：可配置延迟/失败段，并记录真实并发度。"""

    def __init__(self, *, delay: float = 0.0, fail_indices: set[int] | None = None) -> None:
        self.delay = delay
        self.fail_indices = fail_indices or set()
        self.calls: list[list[int]] = []
        self.active = 0
        self.max_active = 0

    async def __call__(self, batch, lang, user_id, candidates):
        indices = [idx for idx, _ in batch]
        self.calls.append(indices)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.fail_indices.intersection(indices):
                return {}, None, "fake batch failure"
            return (
                {idx: f"译文段落 {idx}" for idx in indices},
                "fake-model",
                None,
            )
        finally:
            self.active -= 1


def _translate(number: int, *, key: str = "ip:parallel") -> dict:
    manifest = books.load_manifest()
    return asyncio.run(
        book_translation.translate_chapter(
            manifest,
            "parallel-book",
            number,
            "zh-CN",
            rate_limit_key=key,
            user_id="parallel-user",
        )
    )


def _cache_rows() -> list[sqlite3.Row]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM book_chapter_translations ORDER BY chapter_no"
        ).fetchall()


def _cache_paragraphs(number: int) -> list[str | None]:
    rows = [row for row in _cache_rows() if row["chapter_no"] == number]
    assert len(rows) == 1, f"缺少缓存：chapter={number}"
    return json.loads(rows[0]["paragraphs_json"])


# ---------------------------------------------------------------------------
# 1. 并行：wall time ≈ max，不是 sum；按批顺序合并
# ---------------------------------------------------------------------------


def test_parallel_batches_wall_time_is_max_not_sum(monkeypatch, caplog):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 3, raising=False)
    recorder = BatchRecorder(delay=0.2)
    monkeypatch.setattr(book_translation, "_translate_batch", recorder)
    caplog.set_level(logging.INFO, logger="linguatrek.books.translation")

    started = time.perf_counter()
    payload = _translate(1)
    wall = time.perf_counter() - started

    assert payload["status"] == "done"
    assert payload["cached"] is False
    assert payload["batches"] == 3
    assert payload["failedParagraphs"] == 0
    assert [p["zh"] for p in payload["paragraphs"]] == [
        f"译文段落 {idx}" for idx in range(6)
    ]
    # 3 批各 0.2s：串行 sum=0.6s；并行 max≈0.2s（留出 CI 抖动余量）。
    assert recorder.max_active == 3, "3 批应同时在飞"
    assert wall >= 0.2
    assert wall < 0.45, f"wall={wall:.3f}s 接近 sum 而非 max，批次没有真正并行"
    print(f"[timing] parallel 3x200ms wall={wall * 1000:.0f}ms (serial sum=600ms)")
    assert sorted(idx for call in recorder.calls for idx in call) == list(range(6))

    # 结构化日志字段：feature=book_translation / book/chapter / batch_count /
    # 每批 duration_ms / total_ms / concurrency。
    records = [r.getMessage() for r in caplog.records if "feature=book_translation" in r.getMessage()]
    assert records, "缺少 feature=book_translation 计时日志"
    message = records[-1]
    assert "book=parallel-book" in message
    assert "chapter=1" in message
    assert "batch_count=3" in message
    assert "concurrency=3" in message
    match = re.search(r"total_ms=([0-9.]+)", message)
    assert match is not None and float(match.group(1)) >= 200
    timings = json.loads(re.search(r"batch_ms=(\[.*?\])\s", message).group(1))
    assert [item["batch"] for item in timings] == [0, 1, 2]
    assert all(item["duration_ms"] >= 190 for item in timings)
    assert all(item["ok"] for item in timings)


def test_concurrency_one_is_serial_and_keeps_batch_order(monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 1, raising=False)
    recorder = BatchRecorder(delay=0.1)
    monkeypatch.setattr(book_translation, "_translate_batch", recorder)

    started = time.perf_counter()
    payload = _translate(1)
    wall = time.perf_counter() - started

    assert recorder.max_active == 1
    assert wall >= 0.3, f"1 路应串行（sum≈0.3s），实际 {wall:.3f}s"
    print(f"[timing] serial 3x100ms wall={wall * 1000:.0f}ms (sum=300ms)")
    assert payload["status"] == "done"
    assert [p["zh"] for p in payload["paragraphs"]] == [
        f"译文段落 {idx}" for idx in range(6)
    ]
    assert recorder.calls == [[0, 1], [2, 3], [4, 5]]


def test_concurrency_config_is_clamped_to_1_4(monkeypatch):
    monkeypatch.delattr(config, "BOOK_TRANSLATE_CONCURRENCY", raising=False)
    monkeypatch.delenv("BOOK_TRANSLATE_CONCURRENCY", raising=False)
    assert book_translation.translate_concurrency() == 3  # 默认

    for raw, expected in ((0, 1), (-5, 1), (2, 2), (4, 4), (9, 4), ("bad", 3)):
        monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", raw, raising=False)
        assert book_translation.translate_concurrency() == expected, raw

    # config 未定义时回退环境变量（运维可调）。
    monkeypatch.delattr(config, "BOOK_TRANSLATE_CONCURRENCY", raising=False)
    monkeypatch.setenv("BOOK_TRANSLATE_CONCURRENCY", "2")
    assert book_translation.translate_concurrency() == 2


# ---------------------------------------------------------------------------
# 2. 部分失败：成功批次保留、顺序不乱、重试只补缺失段
# ---------------------------------------------------------------------------


def test_partial_failure_keeps_successful_batches_then_retry_only_missing(monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 3, raising=False)
    failing = BatchRecorder(fail_indices={2, 3})
    monkeypatch.setattr(book_translation, "_translate_batch", failing)

    first = _translate(1)
    assert first["status"] == "partial"
    assert first["failedIndices"] == [2, 3]
    assert first["failedParagraphs"] == 2
    assert [p["zh"] for p in first["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
        None,
        None,
        "译文段落 4",
        "译文段落 5",
    ]
    # 成功批次已落缓存（进度不丢），失败段留 null 等下次补。
    assert _cache_paragraphs(1) == [
        "译文段落 0",
        "译文段落 1",
        None,
        None,
        "译文段落 4",
        "译文段落 5",
    ]
    calls_first = len(failing.calls)
    assert calls_first == 3

    retry = BatchRecorder()
    monkeypatch.setattr(book_translation, "_translate_batch", retry)
    second = _translate(1)
    assert second["status"] == "done"
    assert second["cached"] is False
    assert retry.calls == [[2, 3]], "重试只能补缺失段，不能重复付费"
    assert [p["zh"] for p in second["paragraphs"]] == [
        f"译文段落 {idx}" for idx in range(6)
    ]
    assert _cache_paragraphs(1) == [f"译文段落 {idx}" for idx in range(6)]


def test_all_batches_failing_is_502_without_half_written_row(monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 3, raising=False)
    recorder = BatchRecorder(fail_indices={0, 1, 2, 3, 4, 5})
    monkeypatch.setattr(book_translation, "_translate_batch", recorder)

    with pytest.raises(book_translation.BookTranslationFailed):
        _translate(1)
    assert _cache_rows() == []


# ---------------------------------------------------------------------------
# 3. 每日限额：整章只扣 1 次（与批数/并发无关）
# ---------------------------------------------------------------------------


def test_daily_limit_charged_once_per_chapter_with_parallel_batches(monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 3, raising=False)
    monkeypatch.setattr(config, "RATE_LIMIT_BOOK_TRANSLATE_PER_DAY", 1, raising=False)
    recorder = BatchRecorder()
    monkeypatch.setattr(book_translation, "_translate_batch", recorder)

    first = _translate(1, key="ip:limit-parallel")
    assert first["status"] == "done"
    assert first["batches"] == 3
    assert len(recorder.calls) == 3
    # 3 批只占 1 个每日名额：同一 IP 的第 2 章被限流，且没有再调模型。
    with pytest.raises(book_translation.BookTranslationRateLimited):
        _translate(2, key="ip:limit-parallel")
    assert len(recorder.calls) == 3
    assert [row["chapter_no"] for row in _cache_rows()] == [1]


# ---------------------------------------------------------------------------
# 4. 缓存写安全：并发快照只增不减、不互相覆盖
# ---------------------------------------------------------------------------


def test_cache_snapshots_are_serialized_and_monotonic(monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_CONCURRENCY", 3, raising=False)
    recorder = BatchRecorder(delay=0.05)
    monkeypatch.setattr(book_translation, "_translate_batch", recorder)

    real_save = book_translation.save_cache
    snapshots: list[int] = []

    def spy_save(book_id, number, lang, values, model):
        snapshots.append(sum(1 for value in values if isinstance(value, str) and value.strip()))
        real_save(book_id, number, lang, values, model)

    monkeypatch.setattr(book_translation, "save_cache", spy_save)

    payload = _translate(1)
    assert payload["status"] == "done"
    # 3 批各自落库（快照 2/4/6）+ 最终按批顺序整章写一次（6）；
    # 快照只增不减 = 后写没有覆盖先写的成功批次。
    assert snapshots == sorted(snapshots), f"快照被覆盖：{snapshots}"
    assert snapshots[-1] == 6
    assert len(_cache_rows()) == 1
    assert _cache_paragraphs(1) == [f"译文段落 {idx}" for idx in range(6)]


def test_save_cache_is_thread_safe_under_concurrent_writers():
    manifest = books.load_manifest()
    payload = books.build_chapter_payload(
        manifest, "parallel-book", 1, target_lang="zh-CN"
    )
    total = len(payload["paragraphs"])
    values = [f"线程译文 {idx}" for idx in range(total)]

    def writer(_: int) -> None:
        book_translation.save_cache("parallel-book", 1, "zh-CN", values, "thread-model")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(writer, range(8)))

    rows = _cache_rows()
    assert len(rows) == 1
    assert json.loads(rows[0]["paragraphs_json"]) == values
