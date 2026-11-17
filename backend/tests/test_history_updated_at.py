"""``GET /api/history`` 的 ``updatedAt``（历史 JSON mtime 的毫秒 UTC 时间戳）。

覆盖：

1. 有 mtime：每个条目的 ``updatedAt`` = 文件 mtime 毫秒（UTC 语义），
   现有字段（filename/videoId/metadata/model/modelName/studyCount/mtime/
   targetLang）一个不少，排序仍最新优先；
2. 无 mtime（stat 失败）：``updatedAt=0`` 且条目仍返回，排在有效时间之后；
3. 游客 + 非默认语言目录（``history/vi-VN/``）同样带 ``updatedAt``，
   默认语言目录互不串味。

全部离线：目录在 ``tmp_path``，外部调用由 conftest 统一拦截。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import guest
import routes_videos

EXISTING_FIELDS = {
    "filename",
    "videoId",
    "metadata",
    "model",
    "modelName",
    "studyCount",
    "mtime",
    "targetLang",
}


def _write_history(
    directory: Path,
    filename: str,
    *,
    video_id: str,
    model: str = "deepseek-chat",
    study_count: int = 0,
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_text(
        json.dumps(
            {
                "videoId": video_id,
                "metadata": {
                    "title": "Updated At",
                    "channel": "Test Channel",
                    "upload_date": "20240101",
                },
                "model": model,
                "studyCount": study_count,
                "transcript": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _set_mtime(path: Path, seconds: float) -> None:
    os.utime(path, (seconds, seconds))


def test_history_items_carry_updated_at_ms_and_keep_existing_fields(client, history_dir):
    older = _write_history(
        history_dir, "Video_20240101_older00001.json", video_id="older00001", study_count=2
    )
    newer = _write_history(
        history_dir, "Video_20240102_newer00002.json", video_id="newer00002"
    )
    # 用二进制可精确表示的秒数，避免浮点尾差把毫秒断言变成偶然。
    _set_mtime(older, 1_700_000_000.25)
    _set_mtime(newer, 1_700_000_100.5)

    response = client.get("/api/history")
    assert response.status_code == 200
    items = response.json()

    # 排序不回归：仍是最新优先（mtime desc）
    assert [item["filename"] for item in items] == [newer.name, older.name]
    for item in items:
        assert EXISTING_FIELDS <= set(item), "现有字段不能少"
        assert item["targetLang"] == "zh-CN"
        assert item["updatedAt"] > 0
        # updatedAt 与 mtime 同源：毫秒 = 秒 * 1000（截断）
        assert item["updatedAt"] == int(item["mtime"] * 1000)

    assert items[0]["updatedAt"] == int(1_700_000_100.5 * 1000)
    assert items[1]["updatedAt"] == int(1_700_000_000.25 * 1000)
    assert items[0]["mtime"] == pytest.approx(1_700_000_100.5)
    assert items[1]["metadata"]["title"] == "Updated At"
    assert items[1]["model"] == "deepseek-chat"
    assert items[1]["modelName"] == "DeepSeek-V4.1-Flash"
    assert items[1]["studyCount"] == 2


def test_history_updated_at_is_zero_when_mtime_unavailable(
    client, history_dir, monkeypatch
):
    timed = _write_history(history_dir, "Video_20240101_timed0001.json", video_id="timed0001")
    untimed = _write_history(history_dir, "Video_20240101_untimed1.json", video_id="untimed1")
    _set_mtime(timed, 1_700_000_300.0)

    real_getmtime = os.path.getmtime

    def fake_getmtime(path):
        if os.fspath(path) == str(untimed):
            raise OSError("stat failed (simulated)")
        return real_getmtime(path)

    # routes_videos 里是 ``os.path.getmtime``；在请求线程所属进程内生效。
    monkeypatch.setattr(routes_videos.os.path, "getmtime", fake_getmtime)

    items = client.get("/api/history").json()

    assert {item["filename"] for item in items} == {timed.name, untimed.name}, (
        "取不到 mtime 的条目仍要返回，不能整条丢掉"
    )
    by_name = {item["filename"]: item for item in items}
    assert by_name[timed.name]["updatedAt"] == int(1_700_000_300.0 * 1000)
    assert by_name[untimed.name]["updatedAt"] == 0, "无 mtime 用 0 表示未知"
    assert by_name[untimed.name]["mtime"] is None
    # 有效时间的条目排前面，0 沉底
    assert [item["filename"] for item in items] == [timed.name, untimed.name]
    # 其它字段照常可读
    assert by_name[untimed.name]["videoId"] == "untimed1"
    assert by_name[untimed.name]["targetLang"] == "zh-CN"


def test_history_updated_at_for_guest_and_non_default_language(make_client):
    with make_client() as guest_client:
        guest_client.get("/api/auth/me")  # 下发 ln_guest
        token = guest_client.cookies.get(guest.COOKIE_NAME)
        assert guest.is_valid_token(token)

        vi_dir = (
            Path(guest.guest_history_dir(guest.hash_token(token), create=True)) / "vi-VN"
        )
        vi_path = _write_history(vi_dir, "Vid_20240101_vi1.json", video_id="vi1")
        _set_mtime(vi_path, 1_700_000_400.75)

        vi_items = guest_client.get(
            "/api/history", params={"targetLang": "vi-VN"}
        ).json()
        defaults = guest_client.get("/api/history").json()

    assert len(vi_items) == 1
    assert vi_items[0]["filename"] == vi_path.name
    assert vi_items[0]["targetLang"] == "vi-VN"
    assert vi_items[0]["updatedAt"] == int(1_700_000_400.75 * 1000)
    assert defaults == [], "游客默认 zh-CN 目录不应看到 vi-VN 缓存"
