"""自定义词表离线验收（specs/038-custom-wordlists，全离线）。

覆盖：

1. 导入 / 列表 / 详情 / 删除的完整生命周期与默认命名；
2. 服务端词条校验：英文/拉丁/变音/连字符/撇号/短语、纯数字/中文/符号/超长
   拒绝，CEFR 白名单，``skipped`` 计数；
3. ``NFC + casefold`` 去重（保留第一条原词形）；
4. 限额：每人 10 表、每表 5000 行、越界不落半张表；
5. 同名自动 ``(2)/(3)``、name ≤80、文件名默认名；
6. 分页 + 搜索（单词 / 释义 / 中文）；
7. 删除级联条目、跨用户隔离（越权 404）、游客 403。

数据库在 conftest 的 tmp_path 下，通过真实 Alembic CLI 迁移到 head；不联网。
"""
from __future__ import annotations

import sqlite3

import pytest

import config
import wordlists
from tests.migration_utils import assert_alembic_ok, run_alembic


@pytest.fixture()
def wl_db(client):
    """把当前用例的临时库迁到 head（0028/0029 就位），返回已登录客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (wordlists)"
    )
    return client


def _import(client, items, name=None, filename=None):
    body = {"items": items}
    if name is not None:
        body["name"] = name
    if filename is not None:
        body["filename"] = filename
    return client.post("/api/wordlists/import", json=body)


def _lists(client):
    response = client.get("/api/wordlists")
    assert response.status_code == 200, response.text
    return response.json()["lists"]


def _detail(client, list_id, **params):
    return client.get(f"/api/wordlists/{list_id}", params=params)


def _code(index: int) -> str:
    """下标 → 3 个拉丁字母（测试词里禁止出现数字，否则服务端按无效行拒绝）。"""
    letters = "abcdefghijklmnopqrstuvwxyz"
    high, rest = divmod(index, 26 * 26)
    mid, low = divmod(rest, 26)
    return f"{letters[high]}{letters[mid]}{letters[low]}"


def _db_rows(sql, params=()):
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


@pytest.fixture()
def other_client(make_client):
    """第二个登录用户（用于跨用户隔离）。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={
                "email": "wordlist-other@example.com",
                "password": "other-password-123",
            },
        )
        assert response.status_code == 201, response.text
        yield client


# ---------------------------------------------------------------------------
# 1. 生命周期
# ---------------------------------------------------------------------------

def test_import_list_detail_delete_lifecycle(wl_db):
    client = wl_db
    response = _import(
        client,
        [
            {
                "word": "apple",
                "translation": "苹果",
                "phonetic": "/ˈæpəl/",
                "cefr": "a1",
                "example": "An apple a day.",
            },
            {"word": "banana", "translation": "香蕉", "cefr": "C2"},
        ],
        filename="我的词表.csv",
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["skipped"] == 0
    created = body["list"]
    assert created["name"] == "我的词表"  # 没给 name → 文件名去扩展名
    assert created["itemCount"] == 2
    assert isinstance(created["createdAt"], int) and created["createdAt"] > 0
    list_id = created["id"]

    lists = _lists(client)
    assert [item["id"] for item in lists] == [list_id]
    assert lists[0]["name"] == "我的词表" and lists[0]["itemCount"] == 2

    detail = _detail(client, list_id).json()
    assert detail["id"] == list_id and detail["name"] == "我的词表"
    assert detail["total"] == 2 and detail["page"] == 1
    assert detail["pageSize"] == 50 and detail["hasMore"] is False
    assert [
        {
            "word": item["word"],
            "translation": item["translation"],
            "phonetic": item["phonetic"],
            "cefr": item["cefr"],
            "example": item["example"],
        }
        for item in detail["items"]
    ] == [
        {
            "word": "apple",
            "translation": "苹果",
            "phonetic": "/ˈæpəl/",
            "cefr": "A1",  # 小写 a1 规范成 A1
            "example": "An apple a day.",
        },
        {
            "word": "banana",
            "translation": "香蕉",
            "phonetic": None,
            "cefr": None,  # C2 不在白名单 → 忽略
            "example": None,
        },
    ]
    item_ids = [item["id"] for item in detail["items"]]
    assert all(isinstance(item_id, str) and item_id for item_id in item_ids)
    assert item_ids == [
        row["id"]
        for row in _db_rows(
            "SELECT id FROM user_wordlist_items WHERE list_id = ? ORDER BY position",
            (list_id,),
        )
    ]

    assert _detail(client, "does-not-exist").status_code == 404

    deleted = client.delete(f"/api/wordlists/{list_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {"status": "ok", "deleted": True}
    assert _lists(client) == []
    assert _detail(client, list_id).status_code == 404
    assert _db_rows(
        "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?", (list_id,)
    )[0]["n"] == 0


# ---------------------------------------------------------------------------
# 2. 游客 403
# ---------------------------------------------------------------------------

def test_guests_are_forbidden_on_every_endpoint(make_client):
    with make_client() as guest:
        assert guest.get("/api/wordlists").status_code == 403
        assert _import(guest, [{"word": "apple"}]).status_code == 403
        assert guest.get("/api/wordlists/any-id").status_code == 403
        assert guest.delete("/api/wordlists/any-id").status_code == 403
        assert (
            guest.patch("/api/wordlists/any-id", json={"name": "x"}).status_code
            == 403
        )
        assert (
            guest.request(
                "DELETE",
                "/api/wordlists/any-id/items",
                json={"itemIds": ["any-item"]},
            ).status_code
            == 403
        )


# ---------------------------------------------------------------------------
# 3. 校验与 skipped
# ---------------------------------------------------------------------------

def test_validation_skips_invalid_rows_but_imports_valid_ones(wl_db):
    client = wl_db
    items = [
        {"word": "hello"},
        {"word": "café"},
        {"word": "naïve"},
        {"word": "don't"},
        {"word": "mother-in-law"},
        {"word": "ice cream"},
        # 以下 5 行无效；6 有效 / 11 行 → 未超过 50%，允许导入。
        {"word": "123"},
        {"word": "中文"},
        {"word": "hello!"},
        {"word": "a" * 41},
        {"word": "one two three four five six"},
    ]
    response = _import(client, items, name="英文词表")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["list"]["itemCount"] == 6
    assert body["skipped"] == 5

    detail = _detail(client, body["list"]["id"]).json()
    assert [item["word"] for item in detail["items"]] == [
        "hello",
        "café",
        "naïve",
        "don't",
        "mother-in-law",
        "ice cream",
    ]


def test_all_invalid_or_over_half_invalid_is_rejected_without_side_effects(wl_db):
    client = wl_db
    assert _import(client, [{"word": "123"}, {"word": "中文"}]).status_code == 400
    assert _lists(client) == []

    # 2 有效 + 3 无效 = 60% 无效 → 阻止导入，且不落半张表。
    response = _import(
        client,
        [{"word": "apple"}, {"word": "banana"}, {"word": "1"}, {"word": "2"}, {"word": "3"}],
        name="不像英文",
    )
    assert response.status_code == 400
    assert "50%" in response.json()["detail"]
    assert _lists(client) == []
    assert _db_rows("SELECT COUNT(*) AS n FROM user_wordlists")[0]["n"] == 0
    assert _db_rows("SELECT COUNT(*) AS n FROM user_wordlist_items")[0]["n"] == 0

    # 空 items 也是 400（无有效词条）。
    assert _import(client, []).status_code == 400


def test_exactly_half_invalid_is_allowed(wl_db):
    client = wl_db
    response = _import(
        client,
        [{"word": "apple"}, {"word": "banana"}, {"word": "1"}, {"word": "2"}],
        name="一半无效",
    )
    assert response.status_code == 201, response.text
    assert response.json()["list"]["itemCount"] == 2
    assert response.json()["skipped"] == 2


def test_cefr_whitelist(wl_db):
    client = wl_db
    cefr_values = ["a1", "A2", "b1", "B2", "c1", "C2", "", "D1", None]
    items = [
        {"word": f"word{_code(index)}", "cefr": value}
        for index, value in enumerate(cefr_values)
    ]
    response = _import(client, items, name="CEFR")
    assert response.status_code == 201, response.text
    stored = [item["cefr"] for item in _detail(client, response.json()["list"]["id"]).json()["items"]]
    assert stored == ["A1", "A2", "B1", "B2", "C1", None, None, None, None]


# ---------------------------------------------------------------------------
# 4. 去重
# ---------------------------------------------------------------------------

def test_dedupes_on_nfc_and_casefold_keeping_first_word_form(wl_db):
    client = wl_db
    response = _import(
        client,
        [
            {"word": "Café", "translation": "第一条"},
            {"word": "cafe\u0301", "translation": "分解写法"},
            {"word": "CAFÉ", "translation": "大写"},
            {"word": "café", "translation": "重复"},
        ],
        name="去重",
    )
    assert response.status_code == 201, response.text
    assert response.json()["list"]["itemCount"] == 1
    assert response.json()["skipped"] == 3

    detail = _detail(client, response.json()["list"]["id"]).json()
    assert len(detail["items"]) == 1
    [item] = detail["items"]
    assert isinstance(item["id"], str) and item["id"]
    assert {
        key: item[key]
        for key in ("word", "translation", "phonetic", "cefr", "example")
    } == {
        "word": "Café",
        "translation": "第一条",
        "phonetic": None,
        "cefr": None,
        "example": None,
    }
    rows = _db_rows("SELECT word_key FROM user_wordlist_items")
    assert [row["word_key"] for row in rows] == ["café"]


# ---------------------------------------------------------------------------
# 5. 名称
# ---------------------------------------------------------------------------

def test_same_name_gets_suffix_and_name_is_capped(wl_db):
    client = wl_db
    first = _import(client, [{"word": "apple"}], name="我的词表").json()["list"]
    second = _import(client, [{"word": "banana"}], name="我的词表").json()["list"]
    third = _import(client, [{"word": "cherry"}], name="我的词表").json()["list"]
    assert [first["name"], second["name"], third["name"]] == [
        "我的词表",
        "我的词表 (2)",
        "我的词表 (3)",
    ]

    long_name = "长" * 100
    capped = _import(client, [{"word": "durian"}], name=long_name).json()["list"]
    assert len(capped["name"]) == 80

    # 文件名带路径/扩展名：只取 basename + 去扩展名。
    from_file = _import(
        client, [{"word": "elderberry"}], filename="C:\\Users\\me\\导出词表.csv"
    ).json()["list"]
    assert from_file["name"] == "导出词表"
    default_named = _import(client, [{"word": "fig"}]).json()["list"]
    assert default_named["name"] == "导入词表"

    # 列表按创建时间升序：新导入的排最后（同一毫秒也按插入顺序兜底）。
    assert [item["id"] for item in _lists(client)] == [
        first["id"],
        second["id"],
        third["id"],
        capped["id"],
        from_file["id"],
        default_named["id"],
    ]


# ---------------------------------------------------------------------------
# 6. 限额
# ---------------------------------------------------------------------------

def test_ten_lists_per_user_then_reject_eleventh(wl_db):
    client = wl_db
    for index in range(10):
        response = _import(client, [{"word": f"word{_code(index)}"}], name=f"表{index}")
        assert response.status_code == 201, response.text
    assert len(_lists(client)) == 10

    eleventh = _import(client, [{"word": "overflow"}], name="第 11 张")
    assert eleventh.status_code == 400
    assert "10" in eleventh.json()["detail"]
    assert len(_lists(client)) == 10


def test_five_thousand_rows_cap(wl_db):
    client = wl_db
    too_many = [{"word": f"word{_code(index)}"} for index in range(5001)]
    rejected = _import(client, too_many, name="超限")
    assert rejected.status_code == 400
    assert "5000" in rejected.json()["detail"]
    assert _lists(client) == []

    exact = [{"word": f"term{_code(index)}"} for index in range(5000)]
    accepted = _import(client, exact, name="上限内")
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["list"]["itemCount"] == 5000
    assert _detail(client, accepted.json()["list"]["id"], pageSize=1).json()["total"] == 5000


# ---------------------------------------------------------------------------
# 7. 分页 + 搜索
# ---------------------------------------------------------------------------

def test_pagination_and_search(wl_db):
    client = wl_db
    items = [
        {"word": f"term{_code(index)}", "translation": f"词{index:03d}"}
        for index in range(75)
    ]
    items[10]["translation"] = "苹果"
    list_id = _import(client, items, name="分页").json()["list"]["id"]

    first = _detail(client, list_id, page=1, pageSize=20).json()
    assert first["total"] == 75
    assert len(first["items"]) == 20
    assert first["items"][0]["word"] == f"term{_code(0)}"
    assert first["hasMore"] is True

    last = _detail(client, list_id, page=4, pageSize=20).json()
    assert len(last["items"]) == 15
    assert last["hasMore"] is False
    assert last["items"][-1]["word"] == f"term{_code(74)}"

    empty_page = _detail(client, list_id, page=5, pageSize=20).json()
    assert empty_page["items"] == []
    assert empty_page["hasMore"] is False

    # 单词子串搜索：termaa* = 下标 0–25 共 26 个。
    by_word = _detail(client, list_id, q="termaa", pageSize=50).json()
    assert by_word["total"] == 26
    assert {item["word"] for item in by_word["items"]} == {
        f"term{_code(index)}" for index in range(26)
    }
    # 释义搜索（中文也支持子串）。
    by_translation = _detail(client, list_id, q="苹果").json()
    assert by_translation["total"] == 1
    assert by_translation["items"][0]["word"] == f"term{_code(10)}"
    # 空白 q 视为不搜索。
    assert _detail(client, list_id, q="   ").json()["total"] == 75
    # 搜不到时返回空列表（不是 404）。
    assert _detail(client, list_id, q="zzzz").json()["total"] == 0

    assert _detail(client, list_id, page=0).status_code == 422
    assert _detail(client, list_id, pageSize=201).status_code == 422
    assert _detail(client, list_id, pageSize=0).status_code == 422


# ---------------------------------------------------------------------------
# 8. 级联删除与跨用户隔离
# ---------------------------------------------------------------------------

def test_delete_cascades_items_and_does_not_touch_other_users(wl_db, other_client):
    client = wl_db
    mine = _import(
        client, [{"word": "apple"}, {"word": "banana"}, {"word": "cherry"}], name="我的"
    ).json()["list"]

    # 另一个用户看不到、也删不掉我的词表（越权 404，不泄露存在性）。
    assert _lists(other_client) == []
    assert _detail(other_client, mine["id"]).status_code == 404
    assert other_client.delete(f"/api/wordlists/{mine['id']}").status_code == 404

    their = _import(other_client, [{"word": "durian"}], name="他的").json()["list"]
    assert [item["id"] for item in _lists(other_client)] == [their["id"]]

    # 删除我的表：条目级联清掉；另一个用户的词表不受影响。
    assert client.delete(f"/api/wordlists/{mine['id']}").status_code == 200
    assert _db_rows(
        "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?", (mine["id"],)
    )[0]["n"] == 0
    assert _db_rows(
        "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?", (their["id"],)
    )[0]["n"] == 1


# ---------------------------------------------------------------------------
# 9. 重命名 + 批量删除条目
# ---------------------------------------------------------------------------

def _rename(client, list_id, name):
    return client.patch(f"/api/wordlists/{list_id}", json={"name": name})


def _delete_items(client, list_id, item_ids):
    return client.request(
        "DELETE", f"/api/wordlists/{list_id}/items", json={"itemIds": item_ids}
    )


def _item_ids(list_id):
    """词条 id 未出现在 GET 响应里（spec §5 只暴露内容字段），测试直接读库。"""
    return [
        row["id"]
        for row in _db_rows(
            "SELECT id FROM user_wordlist_items WHERE list_id = ? "
            "ORDER BY position ASC, rowid ASC",
            (list_id,),
        )
    ]


def test_rename_wordlist_success_normalizes_and_is_idempotent(wl_db):
    client = wl_db
    created = _import(
        client, [{"word": "apple"}, {"word": "banana"}], name="旧名"
    ).json()["list"]

    renamed = _rename(client, created["id"], "  新  名  ")
    assert renamed.status_code == 200, renamed.text
    assert renamed.json() == {
        "list": {
            "id": created["id"],
            "name": "新 名",
            "itemCount": 2,
            "createdAt": created["createdAt"],
        }
    }
    assert _lists(client)[0]["name"] == "新 名"
    assert _detail(client, created["id"]).json()["name"] == "新 名"
    assert _db_rows(
        "SELECT name FROM user_wordlists WHERE id = ?", (created["id"],)
    )[0]["name"] == "新 名"

    # 改成自己当前的名字：幂等成功，不触发唯一约束。
    same = _rename(client, created["id"], "新 名")
    assert same.status_code == 200
    assert same.json()["list"]["name"] == "新 名"

    # 80 个字符刚好允许；81 个拒绝在下一个用例。
    eighty = "长" * 80
    assert _rename(client, created["id"], eighty).status_code == 200
    assert _lists(client)[0]["name"] == eighty


def test_rename_rejects_duplicate_and_invalid_names(wl_db):
    client = wl_db
    first = _import(client, [{"word": "apple"}], name="表一").json()["list"]
    second = _import(client, [{"word": "banana"}], name="表二").json()["list"]

    duplicate = _rename(client, second["id"], "表一")
    assert duplicate.status_code == 400
    assert "已存在" in duplicate.json()["detail"]
    assert _lists(client)[1]["name"] == "表二"

    for bad in ["", "   ", "长" * 81, 123, None, ["表三"]]:
        response = _rename(client, first["id"], bad)
        assert response.status_code == 400, (bad, response.text)
    # 缺 name 字段也是 400（不是 422）。
    assert client.patch(f"/api/wordlists/{first['id']}", json={}).status_code == 400
    assert _lists(client)[0]["name"] == "表一"


def test_rename_missing_or_other_users_list_is_404(wl_db, other_client):
    client = wl_db
    mine = _import(client, [{"word": "apple"}], name="我的").json()["list"]

    assert _rename(other_client, mine["id"], "偷改").status_code == 404
    assert _lists(client)[0]["name"] == "我的"
    assert _rename(client, "does-not-exist", "新名").status_code == 404


def test_delete_items_updates_count_and_keeps_remaining(wl_db):
    client = wl_db
    created = _import(
        client,
        [
            {"word": "apple"},
            {"word": "banana"},
            {"word": "cherry"},
            {"word": "durian"},
            {"word": "elderberry"},
        ],
        name="删条目",
    ).json()["list"]
    list_id = created["id"]
    ids = _item_ids(list_id)

    response = _delete_items(client, list_id, [ids[1], ids[3]])
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok", "deleted": 2, "itemCount": 3}
    assert _lists(client)[0]["itemCount"] == 3
    detail = _detail(client, list_id).json()
    assert detail["total"] == 3
    assert [item["word"] for item in detail["items"]] == [
        "apple",
        "cherry",
        "elderberry",
    ]
    assert _db_rows(
        "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?",
        (list_id,),
    )[0]["n"] == 3

    # 重复的 itemId 只删一次，deleted 按去重后计数。
    again = _delete_items(client, list_id, [ids[0], ids[0]])
    assert again.status_code == 200
    assert again.json() == {"status": "ok", "deleted": 1, "itemCount": 2}

    # 删到空表：词表本身保留（不是「删词表」）。
    rest = _item_ids(list_id)
    emptied = _delete_items(client, list_id, rest)
    assert emptied.status_code == 200
    assert emptied.json() == {"status": "ok", "deleted": 2, "itemCount": 0}
    assert _lists(client)[0]["itemCount"] == 0
    empty_detail = _detail(client, list_id)
    assert empty_detail.status_code == 200
    assert empty_detail.json()["total"] == 0


def test_detail_item_ids_feed_delete_items_directly(wl_db):
    """GET 详情返回的 id 是字符串，可直接当 ``DELETE /items`` 的 ``itemIds``。"""
    client = wl_db
    created = _import(
        client,
        [{"word": "apple"}, {"word": "banana"}, {"word": "cherry"}],
        name="详情 id",
    ).json()["list"]
    list_id = created["id"]

    detail = _detail(client, list_id).json()
    ids = [item["id"] for item in detail["items"]]
    assert all(isinstance(item_id, str) and item_id for item_id in ids)
    assert len(set(ids)) == 3
    assert ids == _item_ids(list_id)  # 与库内顺序一致

    response = _delete_items(client, list_id, ids[:2])
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok", "deleted": 2, "itemCount": 1}

    remaining = _detail(client, list_id).json()
    assert remaining["total"] == 1
    assert [item["word"] for item in remaining["items"]] == ["cherry"]
    assert remaining["items"][0]["id"] == ids[2]
    assert _lists(client)[0]["itemCount"] == 1


def test_delete_items_validation_leaves_everything_atomic(wl_db):
    client = wl_db
    created = _import(
        client,
        [{"word": "apple"}, {"word": "banana"}, {"word": "cherry"}],
        name="原子性",
    ).json()["list"]
    list_id = created["id"]
    ids = _item_ids(list_id)
    other = _import(client, [{"word": "fig"}], name="另一张").json()["list"]
    other_ids = _item_ids(other["id"])

    before = _db_rows(
        "SELECT id FROM user_wordlist_items WHERE list_id = ? ORDER BY position",
        (list_id,),
    )

    assert _delete_items(client, list_id, []).status_code == 400
    assert _delete_items(client, list_id, ids * 167).status_code == 400  # 501 个
    assert _delete_items(client, list_id, [ids[0], 123]).status_code == 400
    assert _delete_items(client, list_id, [ids[0], ""]).status_code == 400
    assert _delete_items(client, list_id, "not-a-list").status_code == 400
    # 缺 itemIds / 空 body → 400。
    assert (
        client.request("DELETE", f"/api/wordlists/{list_id}/items", json={}).status_code
        == 400
    )
    assert client.delete(f"/api/wordlists/{list_id}/items").status_code == 422

    # 部分 id 不存在 → 400，整笔不删（原子性）。
    missing = _delete_items(client, list_id, [ids[0], "missing-id"])
    assert missing.status_code == 400
    assert "整笔未删除" in missing.json()["detail"]
    # 混入另一张词表的 id → 400，同样整笔不删。
    foreign = _delete_items(client, list_id, [ids[0], other_ids[0]])
    assert foreign.status_code == 400
    assert "整笔未删除" in foreign.json()["detail"]

    after = _db_rows(
        "SELECT id FROM user_wordlist_items WHERE list_id = ? ORDER BY position",
        (list_id,),
    )
    assert after == before
    assert _lists(client)[0]["itemCount"] == 3
    assert _lists(client)[1]["itemCount"] == 1


def test_delete_items_missing_or_other_users_list_is_404(wl_db, other_client):
    client = wl_db
    created = _import(
        client, [{"word": "apple"}, {"word": "banana"}], name="我的"
    ).json()["list"]
    ids = _item_ids(created["id"])

    assert _delete_items(other_client, created["id"], ids).status_code == 404
    assert _delete_items(client, "does-not-exist", ["any-id"]).status_code == 404
    assert _db_rows(
        "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?",
        (created["id"],),
    )[0]["n"] == 2


# ---------------------------------------------------------------------------
# 10. 纯函数校验（不经 HTTP）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "word",
    ["hello", "café", "naïve", "Ångström", "tiếng", "don't", "mother-in-law",
     "ice cream", "rock’n’roll", "  hello  "],
)
def test_normalize_word_accepts_latin_words(word):
    normalized = wordlists.normalize_word(word)
    assert normalized == word.strip()


@pytest.mark.parametrize(
    "word",
    ["", "   ", "123", "中文", "日本語", "한국어", "русский", "hello!",
     "a" * 41, "-hello", "hello-", "hello--world", "one two three four five six"],
)
def test_normalize_word_rejects_non_english(word):
    with pytest.raises(ValueError):
        wordlists.normalize_word(word)


def test_normalize_cefr_and_word_key():
    assert wordlists.normalize_cefr(" a1 ") == "A1"
    assert wordlists.normalize_cefr("c1") == "C1"
    assert wordlists.normalize_cefr("C2") is None
    assert wordlists.normalize_cefr(None) is None
    assert wordlists.normalize_cefr(3) is None
    assert wordlists.word_key("CAFÉ") == "café"
    assert wordlists.word_key("cafe\u0301") == "café"
