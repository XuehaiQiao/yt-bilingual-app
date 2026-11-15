"""收藏按条 API 离线测试（M1 ④，全离线）。

覆盖：POST 新增 / GET 列表 / DELETE / 幂等 / 400 字段缺失 / 404 删除不存在 /
排序 / 旧文件无 id 兼容 / 旧 PUT 快照兼容 / ?since= 增量 / 并发两个请求不丢。

所有请求都走 conftest 的登录用户 + tmp_path 隔离目录，不联网、不碰真实 data/。
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import routes_user
import storage


SAMPLE = {
    "type": "sentence",
    "text": "Hello world.",
    "translation": "你好，世界。",
    "videoId": "abc123xyz01",
    "time": 12.5,
    "meta": {
        "highlights": [
            {"en_word": "Hello", "zh_word": "你好", "color": "text-blue-400"}
        ],
        "context_en": "Hello world.",
        "context_zh": "你好，世界。",
    },
}


def _favorites_path(client) -> Path:
    return Path(storage.user_data_dir(client.user_id)) / "favorites.json"


def _write_favorites(client, records) -> None:
    path = _favorites_path(client)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_favorites(client) -> list:
    return json.loads(_favorites_path(client).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 按条增删查
# ---------------------------------------------------------------------------

def test_post_get_delete_roundtrip(client):
    created_response = client.post("/api/favorites", json=SAMPLE)
    assert created_response.status_code == 201, created_response.text
    body = created_response.json()
    assert body["status"] == "ok"
    assert body["created"] is True

    favorite = body["favorite"]
    assert favorite["id"].startswith("fav-")
    assert favorite["type"] == "sentence"
    assert favorite["videoId"] == "abc123xyz01"
    assert favorite["start"] == 12.5
    assert favorite["en_text"] == "Hello world."
    assert favorite["zh_text"] == "你好，世界。"
    assert favorite["context_en"] == "Hello world."
    assert favorite["context_zh"] == "你好，世界。"
    assert favorite["highlights"][0]["en_word"] == "Hello"
    assert isinstance(favorite["added_at"], int)

    # 落盘是原子替换后的完整数组，并且为新 API 的规整形状。
    on_disk = _read_favorites(client)
    assert [item["id"] for item in on_disk] == [favorite["id"]]

    listed = client.get("/api/favorites")
    assert listed.status_code == 200
    assert listed.json() == [favorite]

    deleted = client.delete(f"/api/favorites/{favorite['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "ok", "deleted": True, "id": favorite["id"]}
    assert client.get("/api/favorites").json() == []
    assert _read_favorites(client) == []


def test_post_is_idempotent_by_content_and_id(client):
    first = client.post("/api/favorites", json=SAMPLE)
    second = client.post("/api/favorites", json=SAMPLE)
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["created"] is False
    assert second.json()["favorite"]["id"] == first.json()["favorite"]["id"]

    # 内容相同、客户端 id 不同：仍按内容指纹去重，不产生第二条。
    with_different_id = client.post(
        "/api/favorites", json={**SAMPLE, "id": "client-chosen-id"}
    )
    assert with_different_id.status_code == 200
    assert with_different_id.json()["created"] is False
    assert with_different_id.json()["favorite"]["id"] == first.json()["favorite"]["id"]
    assert len(client.get("/api/favorites").json()) == 1

    # 内容不同时正常新增。
    different = client.post(
        "/api/favorites", json={**SAMPLE, "text": "Another sentence."}
    )
    assert different.status_code == 201
    assert len(client.get("/api/favorites").json()) == 2


def test_post_missing_or_invalid_fields_returns_400(client):
    missing_text = client.post(
        "/api/favorites", json={"type": "sentence", "videoId": "abc123xyz01"}
    )
    assert missing_text.status_code == 400
    assert "text" in missing_text.json()["detail"]

    invalid_type = client.post(
        "/api/favorites", json={"type": "bogus", "text": "Hello."}
    )
    assert invalid_type.status_code == 400
    assert client.get("/api/favorites").json() == []


def test_delete_missing_returns_404(client):
    response = client.delete("/api/favorites/does-not-exist")
    assert response.status_code == 404
    assert response.json()["detail"] == "收藏不存在。"


def test_get_sorted_newest_first(client):
    payloads = [
        {"text": "oldest", "addedAt": 1_000},
        {"text": "newest", "addedAt": 3_000},
        {"text": "middle", "addedAt": 2_000},
    ]
    ids = {}
    for payload in payloads:
        response = client.post(
            "/api/favorites",
            json={"type": "sentence", "videoId": "vid00000001", **payload},
        )
        assert response.status_code == 201
        ids[payload["text"]] = response.json()["favorite"]["id"]

    listed = client.get("/api/favorites").json()
    assert [item["en_text"] for item in listed] == ["newest", "middle", "oldest"]
    assert [item["id"] for item in listed] == [
        ids["newest"], ids["middle"], ids["oldest"]
    ]


# ---------------------------------------------------------------------------
# 旧数据兼容
# ---------------------------------------------------------------------------

def test_legacy_records_without_id_are_readable_and_deletable(client):
    legacy = [
        {
            "videoId": "vid00000001",
            "start": 1.5,
            "en_text": "First sentence.",
            "zh_text": "第一句。",
            "added_at": 2_000,
            "type": "sentence",
        },
        {
            "type": "vocabulary",
            "videoId": "vid00000001",
            "start": 5.0,
            "en_text": "word",
            "zh_text": "词",
            "added_at": 1_000,
            "context_en": "This word appears here.",
            "highlights": [],
        },
    ]
    _write_favorites(client, legacy)
    before = _favorites_path(client).read_text(encoding="utf-8")

    first_read = client.get("/api/favorites")
    assert first_read.status_code == 200
    listed = first_read.json()
    assert [item["en_text"] for item in listed] == ["First sentence.", "word"]
    assert all(item["id"].startswith("fav-") for item in listed)
    generated_ids = [item["id"] for item in listed]

    # 读取不重写旧文件；重复 GET 生成相同 id。
    assert _favorites_path(client).read_text(encoding="utf-8") == before
    assert [item["id"] for item in client.get("/api/favorites").json()] == generated_ids

    # 旧记录原有的字段（语境/高亮/时间）不能丢。
    vocabulary = listed[1]
    assert vocabulary["context_en"] == "This word appears here."
    assert vocabulary["highlights"] == []

    # 用生成的 id 可以直接删除；文件里另一条保留。
    deleted = client.delete(f"/api/favorites/{generated_ids[1]}")
    assert deleted.status_code == 200
    remaining = client.get("/api/favorites").json()
    assert [item["en_text"] for item in remaining] == ["First sentence."]
    assert remaining[0]["id"] == generated_ids[0]


def test_legacy_put_snapshot_still_works_and_tombstones_removed(client):
    for favorite_id, text in (("keep-me", "Keep."), ("drop-me", "Drop.")):
        response = client.post(
            "/api/favorites",
            json={
                "id": favorite_id,
                "type": "sentence",
                "text": text,
                "translation": "。",
                "videoId": "vid00000001",
                "time": 3,
                "addedAt": 1_000,
            },
        )
        assert response.status_code == 201

    # 旧整文件 PUT：只保留 keep-me；旧行为是整份快照，drop-me 必须消失。
    put = client.put(
        "/api/favorites",
        json={
            "favorites": [
                {
                    "id": "keep-me",
                    "type": "sentence",
                    "videoId": "vid00000001",
                    "start": 3,
                    "en_text": "Keep.",
                    "zh_text": "。",
                    "added_at": 1_000,
                }
            ]
        },
    )
    assert put.status_code == 200
    assert put.json() == {"status": "ok", "count": 1}

    listed = client.get("/api/favorites").json()
    assert [item["id"] for item in listed] == ["keep-me"]

    # 删除墓碑可被 ?since= 增量读取看到。
    envelope = client.get("/api/favorites", params={"since": 0}).json()
    assert [item["id"] for item in envelope["favorites"]] == ["keep-me"]
    assert [item["id"] for item in envelope["deleted"]] == ["drop-me"]
    assert envelope["since"] == 0
    assert isinstance(envelope["serverTime"], int)


def test_legacy_put_preserves_non_favorite_json_exactly(client):
    """旧测试/旧客户端把 favorites.json 当任意 JSON 数组用时，行为不能变。"""
    response = client.put(
        "/api/favorites", json={"favorites": [{"word": "alpha"}]}
    )
    assert response.status_code == 200
    assert client.get("/api/favorites").json() == [{"word": "alpha"}]


def test_legacy_put_requires_favorites_list(client):
    response = client.put("/api/favorites", json={"favorites": "nope"})
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 增量同步与并发
# ---------------------------------------------------------------------------

def test_since_returns_updates_and_deletes(client):
    older = client.post(
        "/api/favorites",
        json={"type": "sentence", "text": "older", "addedAt": 500},
    ).json()["favorite"]
    newer = client.post(
        "/api/favorites",
        json={"type": "sentence", "text": "newer", "addedAt": 1_500},
    ).json()["favorite"]

    envelope = client.get("/api/favorites", params={"since": 1_000}).json()
    assert [item["id"] for item in envelope["favorites"]] == [newer["id"]]
    assert older["id"] not in [item["id"] for item in envelope["favorites"]]

    client.delete(f"/api/favorites/{older['id']}")
    envelope = client.get("/api/favorites", params={"since": 1_000}).json()
    assert [entry["id"] for entry in envelope["deleted"]] == [older["id"]]

    empty = client.get(
        "/api/favorites", params={"since": int(time.time() * 1000) + 60_000}
    ).json()
    assert empty["favorites"] == []
    assert empty["deleted"] == []


def test_concurrent_posts_do_not_lose_updates(client, monkeypatch):
    """两个并发的 POST：读-改-写被锁串行化，两条都必须落盘。

    把落盘前的写操作放慢，把「读到同一份旧数组」的竞态窗口放大；没有锁时
    第二个写会覆盖第一个，测试会稳定失败。
    """
    original_write = routes_user._write_favorites_unlocked

    def slow_write(path, records):
        time.sleep(0.05)
        original_write(path, records)

    monkeypatch.setattr(routes_user, "_write_favorites_unlocked", slow_write)
    barrier = threading.Barrier(2)

    def post(text):
        barrier.wait()
        return client.post(
            "/api/favorites",
            json={
                "type": "sentence",
                "text": text,
                "videoId": "vid00000001",
                "time": 0,
            },
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(post, ["concurrent one", "concurrent two"]))

    assert [response.status_code for response in responses] == [201, 201]
    listed = client.get("/api/favorites").json()
    assert sorted(item["en_text"] for item in listed) == [
        "concurrent one",
        "concurrent two",
    ]

    # 原子写不能留下临时文件。
    leftovers = list(_favorites_path(client).parent.glob(".favorites-*.tmp"))
    assert leftovers == []
