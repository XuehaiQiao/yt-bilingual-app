"""本地剧集 → YouTube 视频映射（episodes.json）的离线测试。

覆盖 specs/006-local-shows 的冻结契约：
- episodes.json 正常读取、缺文件、损坏、非法单条、路径越界都只降级不报错；
- /api/process-subtitle 新处理与缓存命中都补 youtube_video_id（命中不重写缓存）；
- /api/history/{filename} 给本地剧集缓存补全，普通 YouTube 缓存保持不变。

外部依赖全部由 conftest 拦掉；SUBTITLES_DIR / HISTORY_DIR 都指向 tmp_path。
"""
import json
import sys
from pathlib import Path

import pytest

import config
import llm
import local_shows
import routes_content

SHOW_ID = "alpha-show"
VIDEO_ID = "3dT8Wm5oI_o"
VIDEO_TITLE = "Lecture 1: Introduction to China's History"

SRT_TEXT = """1
00:00:00,000 --> 00:00:02,000
Hello world.

2
00:00:02,500 --> 00:00:04,000
Learning English is fun.
"""

EPISODES = {
    "S01E01": {"videoId": VIDEO_ID, "title": VIDEO_TITLE},
}


@pytest.fixture()
def show_dir(tmp_path, monkeypatch):
    """tmp 下造一部剧：S01/E01.srt + episodes.json，并把 SUBTITLES_DIR 指过去。"""
    root = tmp_path / "subtitles"
    show = root / SHOW_ID
    (show / "S01").mkdir(parents=True)
    (show / "S01" / "E01.srt").write_text(SRT_TEXT, encoding="utf-8")
    (show / "episodes.json").write_text(
        json.dumps(EPISODES, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setattr(config, "SUBTITLES_DIR", str(root))
    monkeypatch.setattr(routes_content, "SUBTITLES_DIR", str(root))
    return show


@pytest.fixture()
def no_llm(monkeypatch):
    """process-subtitle 的翻译与批间停顿都换成本地 stub，保证全离线且不等待。"""

    async def fake_process_llm_batch(blocks, model=None, vocab_level=None, **kwargs):
        return [
            {"id": block["id"], "zh_text": "中文翻译", "highlights": []}
            for block in blocks
        ]

    monkeypatch.setattr(routes_content, "process_llm_batch", fake_process_llm_batch)
    monkeypatch.setattr(llm, "batch_pause", lambda model: 0)


def _local_cache_payload(extra_metadata: dict | None = None) -> dict:
    metadata = {
        "title": f"{SHOW_ID} S01E01",
        "channel": "测试频道",
        "upload_date": "",
        "thumbnail": "",
        "is_local_subtitle": True,
    }
    metadata.update(extra_metadata or {})
    return {
        "videoId": f"{SHOW_ID}-S01E01",
        "metadata": metadata,
        "transcript": [
            {
                "id": 1,
                "start": 0.0,
                "end": 2.0,
                "en_text": "Hello world.",
                "zh_text": "你好，世界。",
                "highlights": [],
            }
        ],
        "summary": "📺 测试频道 第1季 第1集",
        "model": "gemini-2.5-flash",
        "studyCount": 0,
    }


def _write_cache(history_dir: Path, filename: str, payload: dict) -> Path:
    path = history_dir / filename
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


# ----------------------------------------------------
# local_shows：读取与容错
# ----------------------------------------------------

def test_episode_video_map_reads_mapping(show_dir):
    assert local_shows.episode_video_map(SHOW_ID) == EPISODES
    assert local_shows.lookup_episode_video(SHOW_ID, 1, 1) == EPISODES["S01E01"]
    # 没有映射的集返回 None，而不是抛异常
    assert local_shows.lookup_episode_video(SHOW_ID, 1, 2) is None


def test_episode_video_map_missing_file_returns_empty(show_dir):
    (show_dir / "episodes.json").unlink()
    assert local_shows.episode_video_map(SHOW_ID) == {}
    assert local_shows.lookup_episode_video(SHOW_ID, 1, 1) is None
    # 整部剧目录不存在也一样
    assert local_shows.episode_video_map("no-such-show") == {}


def test_episode_video_map_corrupt_file_returns_empty(show_dir):
    (show_dir / "episodes.json").write_text("{ not valid json", encoding="utf-8")
    assert local_shows.episode_video_map(SHOW_ID) == {}


def test_episode_video_map_skips_invalid_entries(show_dir):
    (show_dir / "episodes.json").write_text(
        json.dumps(
            {
                "S01E01": {"videoId": VIDEO_ID, "title": VIDEO_TITLE},
                "S01E02": {"title": "缺少 videoId"},
                "S01E03": "不是对象",
                "nonsense": {"videoId": "abc123"},
                "S1E4": {"videoId": "plainkey"},  # 未补零的键也接受，统一成 S01E04
            }
        ),
        encoding="utf-8",
    )
    mapping = local_shows.episode_video_map(SHOW_ID)
    assert mapping == {
        "S01E01": {"videoId": VIDEO_ID, "title": VIDEO_TITLE},
        "S01E04": {"videoId": "plainkey"},
    }


def test_episode_video_map_rejects_path_escape(show_dir):
    assert local_shows.episode_video_map("../etc") == {}
    assert local_shows.episode_video_map("/tmp") == {}


# ----------------------------------------------------
# /api/process-subtitle：新处理与缓存命中
# ----------------------------------------------------

def test_process_subtitle_fresh_includes_youtube_video_id(client, show_dir, no_llm, history_dir):
    response = client.post(
        "/api/process-subtitle",
        json={"show_id": SHOW_ID, "season": 1, "episode": 1},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["metadata"]["youtube_video_id"] == VIDEO_ID
    assert data["metadata"]["youtube_title"] == VIDEO_TITLE
    # 新处理的结果照旧落盘（缓存里也带映射）
    cached = json.loads((history_dir / f"{SHOW_ID}_S01E01.json").read_text(encoding="utf-8"))
    assert cached["metadata"]["youtube_video_id"] == VIDEO_ID


def test_process_subtitle_fresh_without_mapping_keeps_shape(client, show_dir, no_llm):
    (show_dir / "episodes.json").unlink()
    response = client.post(
        "/api/process-subtitle",
        json={"show_id": SHOW_ID, "season": 1, "episode": 1},
    )
    assert response.status_code == 200
    metadata = response.json()["metadata"]
    assert "youtube_video_id" not in metadata
    assert "youtube_title" not in metadata


def test_process_subtitle_cache_hit_adds_youtube_video_id(client, show_dir, history_dir):
    cache_path = _write_cache(
        history_dir, f"{SHOW_ID}_S01E01.json", _local_cache_payload()
    )
    before = cache_path.read_bytes()

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": SHOW_ID, "season": 1, "episode": 1},
    )
    assert response.status_code == 200
    metadata = response.json()["metadata"]
    assert metadata["youtube_video_id"] == VIDEO_ID
    assert metadata["youtube_title"] == VIDEO_TITLE
    # 命中补全只作用于响应，不重写缓存文件
    assert cache_path.read_bytes() == before


# ----------------------------------------------------
# /api/history/{filename}：只补本地剧集缓存
# ----------------------------------------------------

def test_history_enriches_local_episode_cache(client, show_dir, history_dir):
    cache_path = _write_cache(
        history_dir, f"{SHOW_ID}_S01E01.json", _local_cache_payload()
    )

    response = client.get(f"/api/history/{SHOW_ID}_S01E01.json")
    assert response.status_code == 200
    metadata = response.json()["metadata"]
    assert metadata["youtube_video_id"] == VIDEO_ID
    assert metadata["youtube_title"] == VIDEO_TITLE

    # 补全不落盘：磁盘上的缓存没有这两个字段（映射更新后不会残留旧 id）
    on_disk = json.loads(cache_path.read_text(encoding="utf-8"))
    assert "youtube_video_id" not in on_disk["metadata"]


def test_history_leaves_youtube_cache_unchanged(client, history_dir):
    filename = "Test_Channel_20240101_abc123xyz.json"
    payload = {
        "videoId": "abc123xyz",
        "metadata": {
            "title": "Test Video",
            "channel": "Test Channel",
            "upload_date": "20240101",
            "thumbnail": "",
        },
        "transcript": [
            {
                "id": 1,
                "start": 0.0,
                "end": 2.0,
                "en_text": "Hello world.",
                "zh_text": "你好，世界。",
                "highlights": [],
            }
        ],
        "summary": "一段正常的总结",
        "model": "gemini-2.5-flash",
        "studyCount": 0,
    }
    _write_cache(history_dir, filename, payload)

    response = client.get(f"/api/history/{filename}")
    assert response.status_code == 200
    metadata = response.json()["metadata"]
    assert metadata == payload["metadata"]


# ----------------------------------------------------
# 导入脚本：episodes.json 幂等写/更新
# ----------------------------------------------------

def test_import_script_write_episodes_merges_and_stays_idempotent(tmp_path):
    scripts_dir = Path(__file__).resolve().parents[2] / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import import_playlist

    show_dir = tmp_path / "playlist-show"
    show_dir.mkdir()
    (show_dir / "episodes.json").write_text(
        json.dumps(
            {
                "S01E01": {"videoId": "old-id", "title": "Old title"},
                "S01E02": {"videoId": "keep-id", "title": "Keep me"},
            }
        ),
        encoding="utf-8",
    )

    # 同一集换了视频 -> 以新列表为准；不可用条目 -> 保留旧映射
    entries = [
        import_playlist.PlaylistEntry(1, "new-id", "New title"),
        import_playlist.PlaylistEntry(2, None, "(不可用的条目)"),
    ]
    path, count, changed = import_playlist.write_episodes(str(show_dir), entries)
    assert (count, changed) == (2, 1)
    assert json.loads(Path(path).read_text(encoding="utf-8")) == {
        "S01E01": {"videoId": "new-id", "title": "New title"},
        "S01E02": {"videoId": "keep-id", "title": "Keep me"},
    }

    # 原样再跑一遍：内容与字节都不变
    before = Path(path).read_bytes()
    _, count, changed = import_playlist.write_episodes(str(show_dir), entries)
    assert (count, changed) == (2, 0)
    assert Path(path).read_bytes() == before
