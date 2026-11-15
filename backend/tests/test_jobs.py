"""M1 ⑤ ``jobs`` 表 + SSE 断线续传的离线验收（计划书 §7.3 A-4）。

覆盖：

1. 首次请求创建 job：SSE meta 带 jobId，每批落盘后 cursor 前进（20 → 40 → 45）；
2. 断线（流被取消）→ job 落成 partial、cursor 停在第 1 批，``GET /api/jobs/{id}``
   返回 canResume=true；
3. 带 jobId + from 续传：只补 ``[未翻译]`` 的句子，已落盘的 20 句不再调模型
   （断言 LLM 调用次数与 block id 都没有重复）；
4. 前端没带 jobId 直接重新提交 URL：复用同一条未完成 job（幂等），同样不重复生成；
5. 已完成的 job 再重连：只回放 meta/summary/done，不调模型；
6. 同一 job 并发请求：执行权被占用时 409，不产生额外 LLM 调用；
7. 并发 ``create_or_reuse``：8 个线程只产生一条未完成任务；
8. 纯缓存秒开（没有未翻译句）不建任务记录；
9. 游客（无会话）403（别人的 job）/ 403（jobId 不是自己的）/ 404（不存在）语义；
10. 旧库没跑 0005 迁移时降级：流照常可用，只是没有 jobId。

全部离线：字幕抓取 / 元数据 / LLM 全部 monkeypatch，数据库在 tmp_path。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

import config
import jobs
import llm
import routes_videos
import translate
from tests.migration_utils import assert_alembic_ok, run_alembic

URL = "https://www.youtube.com/watch?v=jobtest0001"
VIDEO_ID = "jobtest0001"
TOTAL_BLOCKS = 45
BATCH_SIZE = 20

METADATA = {
    "title": "Jobs Test",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "",
}

# 每句以句号结尾 → group_transcript_blocks 一句一个 block，共 TOTAL_BLOCKS 个。
TRANSCRIPT = [
    SimpleNamespace(text=f"Sentence number {index}.", start=float(index), duration=0.9)
    for index in range(TOTAL_BLOCKS)
]


# ---------------------------------------------------------------------------
# 夹具 / 桩
# ---------------------------------------------------------------------------

@pytest.fixture()
def migrated(client):
    """把当前用例的临时库迁到 head（jobs 表就位），返回已登录客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (jobs)"
    )
    return client


def _install_fakes(monkeypatch):
    """记录每批送进 LLM 的 block id；翻译/总结/抓字幕全部离线。"""
    calls: list[list[int]] = []

    async def fake_process_llm_batch(
        blocks,
        model=None,
        vocab_level=None,
        *,
        feature="translate",
        user_id=None,
        target_lang=None,
    ):
        calls.append([block["id"] for block in blocks])
        return [
            {
                "id": block["id"],
                "start": block["start"],
                "end": block["end"],
                "en_text": block["text"],
                "zh_text": f"译文{block['id']}",
                "highlights": [],
            }
            for block in blocks
        ]

    async def fake_summary(blocks, model=None, **_kwargs):
        return "测试总结"

    monkeypatch.setattr(translate, "process_llm_batch", fake_process_llm_batch)
    monkeypatch.setattr(routes_videos, "summarize_video_transcript", fake_summary)
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(
        routes_videos, "get_video_metadata", lambda url: dict(METADATA)
    )
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    return calls


def _install_interrupting_stream(monkeypatch):
    """第 1 批正常产出后取消流——模拟客户端断线（第 2 批不会开始）。"""
    real_stream = translate._stream_translate

    async def interrupted(*args, **kwargs):
        generator = real_stream(*args, **kwargs)
        first_batch = await generator.__anext__()
        yield first_batch
        await generator.aclose()
        raise asyncio.CancelledError()

    monkeypatch.setattr(routes_videos, "_stream_translate", interrupted)


def _restore_stream(monkeypatch):
    monkeypatch.setattr(routes_videos, "_stream_translate", translate._stream_translate)


def _events(response) -> list[tuple[str, dict]]:
    """把 SSE 响应拆成 [(event, data)]。"""
    events: list[tuple[str, dict]] = []
    current = None
    for line in response.text.splitlines():
        if line.startswith("event: "):
            current = line[len("event: "):]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[len("data: "):])))
            current = None
    return events


def _job_rows(**where) -> list[tuple]:
    query = "SELECT id, status, cursor, content_ref FROM jobs"
    values: tuple = ()
    if where:
        query += " WHERE " + " AND ".join(f"{key} = ?" for key in where)
        values = tuple(where.values())
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(query, values).fetchall()


def _start_partial_job(client, monkeypatch) -> tuple[str, list[list[int]]]:
    """跑一次「第 1 批成功后断线」的流，返回 (jobId, 每次 LLM 调用的 block id)。"""
    calls = _install_fakes(monkeypatch)
    _install_interrupting_stream(monkeypatch)
    response = client.post("/api/process-video-stream", json={"url": URL})
    assert response.status_code == 200, response.text
    events = _events(response)
    assert [name for name, _ in events] == ["meta", "batch"], events
    job_id = events[0][1]["jobId"]
    assert job_id
    return job_id, calls


# ---------------------------------------------------------------------------
# 1. 创建 / 游标推进 / 完成
# ---------------------------------------------------------------------------

def test_stream_creates_job_and_advances_cursor(migrated, monkeypatch):
    calls = _install_fakes(monkeypatch)

    response = migrated.post("/api/process-video-stream", json={"url": URL})
    assert response.status_code == 200, response.text
    events = _events(response)
    names = [name for name, _ in events]
    assert names[0] == "meta" and names[-1] == "done"

    meta = events[0][1]
    job_id = meta["jobId"]
    assert job_id, "首次请求应创建 job 并在 meta 里带 jobId"
    assert meta["total"] == TOTAL_BLOCKS
    assert meta["cursor"] == 0
    assert meta["resumed"] is False

    batches = [data for name, data in events if name == "batch"]
    assert [batch["cursor"] for batch in batches] == [20, 40, 45]
    assert [batch["jobId"] for batch in batches] == [job_id] * 3
    assert [len(block_ids) for block_ids in calls] == [20, 20, 5]

    snapshot = migrated.get(f"/api/jobs/{job_id}")
    assert snapshot.status_code == 200, snapshot.text
    data = snapshot.json()
    assert data["id"] == job_id
    assert data["status"] == "done"
    assert data["cursor"] == TOTAL_BLOCKS
    assert data["total"] == TOTAL_BLOCKS
    assert data["progress"] == {"done": TOTAL_BLOCKS, "total": TOTAL_BLOCKS}
    assert data["canResume"] is False
    assert data["active"] is False
    assert data["videoId"] == VIDEO_ID
    assert data["targetLang"] == "zh-CN"
    assert data["kind"] == "process_video"
    assert data["error"] is None
    assert _job_rows(content_ref=VIDEO_ID)[0][1] == "done"


# ---------------------------------------------------------------------------
# 2/3. 断线 → partial → 从游标续传，不重复生成
# ---------------------------------------------------------------------------

def test_resume_after_drop_only_generates_missing_blocks(migrated, monkeypatch):
    job_id, calls = _start_partial_job(migrated, monkeypatch)
    assert calls == [list(range(1, BATCH_SIZE + 1))], "断线前只应跑完第 1 批"

    snapshot = migrated.get(f"/api/jobs/{job_id}")
    assert snapshot.status_code == 200
    data = snapshot.json()
    assert data["status"] == "partial"
    assert data["cursor"] == BATCH_SIZE
    assert data["total"] == TOTAL_BLOCKS
    assert data["canResume"] is True
    assert data["active"] is False

    # 模拟刷新：前端先 GET job 判断状态，再带 jobId + from 重连。
    _restore_stream(monkeypatch)
    resumed = migrated.post(
        "/api/process-video-stream",
        json={"url": URL, "jobId": job_id, "from": data["cursor"]},
    )
    assert resumed.status_code == 200, resumed.text
    events = _events(resumed)
    names = [name for name, _ in events]
    assert names == ["meta", "batch", "batch", "stage", "summary", "done"], names
    meta = dict(events)["meta"]
    assert meta["resumed"] is True
    assert meta["jobId"] == job_id
    assert meta["cursor"] == BATCH_SIZE
    assert meta["from"] == BATCH_SIZE, "POST body 的 from 别名应被解析"

    # 续传只补第 21–45 句；第 1 批（1–20）一个都没再送进模型。
    resumed_ids = [block_id for batch in calls[1:] for block_id in batch]
    assert sorted(resumed_ids) == list(range(BATCH_SIZE + 1, TOTAL_BLOCKS + 1))
    assert len(calls) == 3, f"总调用批次应为 3（1 批断线前 + 2 批续传），实际 {calls}"
    assert [batch["cursor"] for name, batch in events if name == "batch"] == [40, TOTAL_BLOCKS]

    done = migrated.get(f"/api/jobs/{job_id}").json()
    assert done["status"] == "done"
    assert done["cursor"] == TOTAL_BLOCKS
    assert done["canResume"] is False
    # 没有产生第二条任务
    assert len(_job_rows(content_ref=VIDEO_ID)) == 1


def test_resume_after_drop_during_summary_skips_translation(migrated, monkeypatch):
    """字幕已全量落盘、只差总结时断线：续传只补总结，不重新翻译。"""
    calls = _install_fakes(monkeypatch)
    healthy_summary = routes_videos.summarize_video_transcript

    async def cancelled_summary(*_args, **_kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(routes_videos, "summarize_video_transcript", cancelled_summary)
    response = migrated.post("/api/process-video-stream", json={"url": URL})
    events = _events(response)
    assert [name for name, _ in events] == ["meta", "batch", "batch", "batch", "stage"]
    job_id = events[0][1]["jobId"]

    snapshot = migrated.get(f"/api/jobs/{job_id}").json()
    assert snapshot["status"] == "partial"
    assert snapshot["cursor"] == TOTAL_BLOCKS, "翻译已全量落盘"
    assert snapshot["canResume"] is True, "cursor==total 但总结未完成时仍可续"

    monkeypatch.setattr(routes_videos, "summarize_video_transcript", healthy_summary)
    calls_before = len(calls)
    resumed = migrated.post(
        "/api/process-video-stream",
        json={"url": URL, "jobId": job_id, "from": snapshot["cursor"]},
    )
    assert resumed.status_code == 200
    resumed_events = _events(resumed)
    assert [name for name, _ in resumed_events] == [
        "meta", "stage", "summary", "done",
    ]
    assert len(calls) == calls_before, "已翻好的字幕不能再送模型"
    assert migrated.get(f"/api/jobs/{job_id}").json()["status"] == "done"


# ---------------------------------------------------------------------------
# 4. 不带 jobId 的重新提交也复用未完成任务
# ---------------------------------------------------------------------------

def test_resubmit_without_job_id_reuses_unfinished_job(migrated, monkeypatch):
    job_id, calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)

    response = migrated.post("/api/process-video-stream", json={"url": URL})
    assert response.status_code == 200, response.text
    events = _events(response)
    meta = dict(events)["meta"]
    assert meta["jobId"] == job_id, "同一视频未完成时应复用原 job（幂等）"
    assert meta["resumed"] is True
    assert meta["cursor"] == BATCH_SIZE

    assert len(calls) == 3
    assert sorted(block_id for batch in calls for block_id in batch) == list(
        range(1, TOTAL_BLOCKS + 1)
    ), "每个 block 只应生成一次"
    assert len(_job_rows(content_ref=VIDEO_ID)) == 1
    assert migrated.get(f"/api/jobs/{job_id}").json()["status"] == "done"


# ---------------------------------------------------------------------------
# 5. 完成的 job 重连只回放
# ---------------------------------------------------------------------------

def test_done_job_reconnect_replays_without_calling_models(migrated, monkeypatch):
    calls = _install_fakes(monkeypatch)
    first = migrated.post("/api/process-video-stream", json={"url": URL})
    job_id = _events(first)[0][1]["jobId"]
    calls_before = len(calls)

    # 续传/回放只需要 jobId，url 可以省（job.payload 里已记 videoId）。
    replay = migrated.post(
        "/api/process-video-stream", json={"jobId": job_id}
    )
    assert replay.status_code == 200, replay.text
    events = _events(replay)
    assert [name for name, _ in events] == ["meta", "summary", "done"]
    assert dict(events)["meta"]["done"] is True
    assert dict(events)["summary"]["summary"] == "测试总结"
    assert len(calls) == calls_before, "已完成任务重连不能重新调模型"
    assert len(_job_rows(content_ref=VIDEO_ID)) == 1


# ---------------------------------------------------------------------------
# 6. 同一 job 并发：执行权被占用 → 409，且不产生额外调用
# ---------------------------------------------------------------------------

def test_concurrent_requests_for_same_job_do_not_double_pay(migrated, monkeypatch):
    job_id, calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)
    calls_before = len(calls)

    # 模拟另一条流正在生成这个 job（执行权被占用）。
    assert jobs.try_acquire(job_id) is True
    try:
        no_job_id = migrated.post("/api/process-video-stream", json={"url": URL})
        assert no_job_id.status_code == 409
        assert "正在处理" in no_job_id.json()["detail"]

        with_job_id = migrated.post(
            "/api/process-video-stream",
            json={"url": URL, "jobId": job_id, "from": BATCH_SIZE},
        )
        assert with_job_id.status_code == 409

        # GET 也应如实报告「正在别处生成」，不要引导前端重连
        snapshot = migrated.get(f"/api/jobs/{job_id}").json()
        assert snapshot["active"] is True
        assert snapshot["canResume"] is False
        assert len(calls) == calls_before, "并发请求不能产生额外 LLM 调用"
    finally:
        jobs.release(job_id)

    # 执行权释放后可以正常续传
    resumed = migrated.post(
        "/api/process-video-stream",
        json={"url": URL, "jobId": job_id, "from": BATCH_SIZE},
    )
    assert resumed.status_code == 200
    assert _events(resumed)[-1][0] == "done"


def test_race_backstop_emits_job_busy_without_generating(migrated, monkeypatch):
    """Handler 预检通过后执行权被抢：生成器兜底发 job_busy，不产生 LLM 调用。"""
    job_id, calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)
    calls_before = len(calls)

    assert jobs.try_acquire(job_id) is True
    try:
        # 模拟竞态：预检那一刻执行权还没被占，生成器启动时已被占。
        monkeypatch.setattr(routes_videos.jobs, "is_active", lambda _job_id: False)
        response = migrated.post(
            "/api/process-video-stream", json={"url": URL, "jobId": job_id}
        )
        assert response.status_code == 200
        events = _events(response)
        assert [name for name, _ in events] == ["error"]
        error = dict(events)["error"]
        assert error["code"] == "job_busy"
        assert error["jobId"] == job_id
        assert len(calls) == calls_before, "拿到执行权失败时不能调模型"
    finally:
        jobs.release(job_id)


def test_resume_failed_job_returns_409(migrated, monkeypatch):
    job_id, _calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)
    jobs.mark_failed(job_id, "模拟失败")

    response = migrated.post(
        "/api/process-video-stream", json={"url": URL, "jobId": job_id}
    )
    assert response.status_code == 409
    assert "失败" in response.json()["detail"]
    snapshot = migrated.get(f"/api/jobs/{job_id}").json()
    assert snapshot["status"] == "failed"
    assert snapshot["canResume"] is False


def test_create_or_reuse_is_idempotent_under_concurrency(migrated):
    def create(_index: int):
        return jobs.create_or_reuse(
            user_id=migrated.user_id,
            kind=jobs.KIND_PROCESS_VIDEO,
            content_ref="concurrentvid",
            target_lang="zh-CN",
            payload={"videoId": "concurrentvid"},
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(8)))

    created_ids = {job["id"] for job in results if job}
    assert len(created_ids) == 1, "8 个并发创建只应产生一条未完成任务"
    rows = _job_rows(content_ref="concurrentvid")
    assert len(rows) == 1
    assert rows[0][1] == "queued"


# ---------------------------------------------------------------------------
# 7. 纯缓存秒开不建任务；旧库降级
# ---------------------------------------------------------------------------

def test_cached_video_without_pending_does_not_create_job(migrated, monkeypatch, history_dir):
    _install_fakes(monkeypatch)
    migrated.post("/api/process-video-stream", json={"url": URL})
    assert len(_job_rows(content_ref=VIDEO_ID)) == 1

    calls = _install_fakes(monkeypatch)
    second = migrated.post("/api/process-video-stream", json={"url": URL})
    assert second.status_code == 200
    events = _events(second)
    meta = dict(events)["meta"]
    assert meta["cached"] is True
    assert meta["jobId"] is None, "没有未翻译句时不该新建任务"
    assert [name for name, _ in events] == ["meta", "summary", "done"]
    assert calls == []
    assert len(_job_rows(content_ref=VIDEO_ID)) == 1


def test_stream_still_works_without_jobs_table(client, monkeypatch):
    """旧库（没跑 0005_jobs）降级：流照常，只是没有 jobId（不阻断主流程）。"""
    calls = _install_fakes(monkeypatch)
    response = client.post("/api/process-video-stream", json={"url": URL})
    assert response.status_code == 200, response.text
    events = _events(response)
    assert [name for name, _ in events] == [
        "meta", "batch", "batch", "batch", "stage", "summary", "done",
    ]
    assert dict(events)["meta"]["jobId"] is None
    assert len(calls) == 3
    # 查任务/续传在旧库上也是明确 404，而不是 500。
    assert client.get("/api/jobs/whatever").status_code == 404
    assert client.post(
        "/api/process-video-stream", json={"jobId": "whatever"}
    ).status_code == 404


# ---------------------------------------------------------------------------
# 8. 认证 / 归属 / 不存在的语义
# ---------------------------------------------------------------------------

def test_job_endpoint_auth_and_ownership(migrated, make_client):
    job = jobs.create_or_reuse(
        user_id=migrated.user_id,
        kind=jobs.KIND_PROCESS_VIDEO,
        content_ref="authcheck001",
        target_lang="zh-CN",
        payload={"videoId": "authcheck001"},
    )
    assert job is not None

    assert migrated.get("/api/jobs/does-not-exist").status_code == 404

    with make_client() as anonymous:
        # M1 ⑧：无会话即游客（guest:<sha256>），不是 job 的所有者 → 403，
        # 不存在 → 404；游客拿不到任何别人的 job。
        assert anonymous.get("/api/jobs/does-not-exist").status_code == 404
        assert anonymous.get(f"/api/jobs/{job['id']}").status_code == 403
        assert anonymous.post(
            "/api/process-video-stream",
            json={"url": URL, "jobId": job["id"]},
        ).status_code == 403

    with make_client() as other:
        signup = other.post(
            "/api/auth/signup",
            json={"email": "other-jobs@example.com", "password": "other-password-123"},
        )
        assert signup.status_code == 201, signup.text
        assert other.get(f"/api/jobs/{job['id']}").status_code == 403
        assert other.post(
            "/api/process-video-stream",
            json={"url": URL, "jobId": job["id"]},
        ).status_code == 403


def test_get_stream_resume_endpoint(migrated, monkeypatch):
    """GET /api/process-video-stream?jobId=&from= 与 POST 等价（EventSource 可用）。"""
    job_id, _calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)

    response = migrated.get(
        "/api/process-video-stream",
        params={"jobId": job_id, "from": BATCH_SIZE},
    )
    assert response.status_code == 200, response.text
    events = _events(response)
    assert [name for name, _ in events] == [
        "meta", "batch", "batch", "stage", "summary", "done",
    ]
    assert dict(events)["meta"]["resumed"] is True
    assert migrated.get(f"/api/jobs/{job_id}").json()["status"] == "done"


def test_resume_rejects_language_mismatch_and_missing_artifact(
    migrated, monkeypatch, history_dir
):
    job_id, _calls = _start_partial_job(migrated, monkeypatch)
    _restore_stream(monkeypatch)

    mismatch = migrated.post(
        "/api/process-video-stream",
        json={"url": URL, "jobId": job_id, "targetLang": "vi-VN"},
    )
    assert mismatch.status_code == 400

    # 产物被删（用户清了缓存）：410，并把任务标成 failed（不再无限可续）。
    payload_files = list(history_dir.glob(f"*_{VIDEO_ID}.json"))
    assert payload_files, "断线后应已落盘一份带 [未翻译] 的缓存"
    for path in payload_files:
        path.unlink()
    gone = migrated.post(
        "/api/process-video-stream", json={"url": URL, "jobId": job_id}
    )
    assert gone.status_code == 410
    snapshot = migrated.get(f"/api/jobs/{job_id}").json()
    assert snapshot["status"] == "failed"
    assert snapshot["canResume"] is False
