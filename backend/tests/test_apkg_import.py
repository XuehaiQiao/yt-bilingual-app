"""Anki ``.apkg`` 解析离线验收（specs/046-apkg-import §2/§4）。

覆盖：

1. legacy ``collection.anki2`` 与 ``collection.anki21``、新版 schema 的
   ``collection.anki21b``（zstd）三种合成 APKG；
2. 牌组/笔记类型/字段/notes 契约、deck noteCount、字段映射
   （单词/音标/解释 → word/phonetic/translation）；
3. HTML 清洗（``<br>``、标签、``[sound:…]``、entity、空白压缩）；
4. 10000 notes 截断、10001 全量计数；
5. 损坏 ZIP / 无 collection / 无 notes / 不支持 schema / 路径穿越 / 加密成员；
6. 50MB 上传流式限制（413）与 30MB 真实体量不误杀；
7. ``.anki21b`` 缺 ``zstandard`` → 503、zstd 损坏 → 400、解压上限 → 413；
8. 媒体不解压（只打开 collection 成员）；
9. 未登录 403、扩展名 400；
10. 7512 notes（GRE 真实体量）解析后全量走 ``/api/wordlists/import``。

全部离线；不依赖真实 Anki 文件。
"""
from __future__ import annotations

import io
import json
import sqlite3
import zipfile

import pytest

import apkg_import
import config
from tests.migration_utils import assert_alembic_ok, run_alembic

# ---------------------------------------------------------------------------
# 合成 APKG
# ---------------------------------------------------------------------------

LEGACY_FIELDS = ["单词", "音标", "解释", "例句"]
LEGACY_MODELS = {
    "1001": {
        "id": 1001,
        "name": "红宝书",
        "flds": [{"name": name, "ord": index} for index, name in enumerate(LEGACY_FIELDS)],
    },
    "2002": {
        "id": 2002,
        "name": "Basic",
        "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
    },
}
LEGACY_DECKS = {
    "1": {"id": 1, "name": "Default"},
    "2": {"id": 2, "name": "GRE 核心"},
}
LEGACY_NOTES = [
    (
        1001,
        "apple\x1f/ˈæpəl/\x1f苹果\x1fAn <b>apple</b><br>a day &amp; more",
        2,
    ),
    (2002, "banana\x1f香蕉<br>[sound:banana.mp3]", 2),
    (2002, "cherry\x1f樱桃<div>red</div>", 1),
]


def _legacy_db(path, notes=LEGACY_NOTES) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT);
            CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);
            """
        )
        conn.execute(
            "INSERT INTO col (models, decks) VALUES (?, ?)",
            (
                json.dumps(LEGACY_MODELS, ensure_ascii=False),
                json.dumps(LEGACY_DECKS, ensure_ascii=False),
            ),
        )
        for mid, fields, did in notes:
            cursor = conn.execute(
                "INSERT INTO notes (mid, flds) VALUES (?, ?)", (mid, fields)
            )
            conn.execute(
                "INSERT INTO cards (nid, did) VALUES (?, ?)", (cursor.lastrowid, did)
            )
        conn.commit()
    finally:
        conn.close()


def _new_schema_db(path, notes=((7, "abandon\x1f放弃"),)) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE notetypes (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE fields (ntid INTEGER, ord INTEGER, name TEXT);
            CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT);
            CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);
            """
        )
        conn.execute("INSERT INTO notetypes (id, name) VALUES (7, 'New Basic')")
        conn.executemany(
            "INSERT INTO fields (ntid, ord, name) VALUES (7, ?, ?)",
            [(0, "Front"), (1, "Back")],
        )
        conn.execute("INSERT INTO decks (id, name) VALUES (1, 'Default')")
        for mid, fields in notes:
            cursor = conn.execute(
                "INSERT INTO notes (mid, flds) VALUES (?, ?)", (mid, fields)
            )
            conn.execute(
                "INSERT INTO cards (nid, did) VALUES (?, 1)", (cursor.lastrowid,)
            )
        conn.commit()
    finally:
        conn.close()


def _apkg(collection_member: str, collection_bytes: bytes, *, extra=()) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("media", "{}")
        archive.writestr("0", b"\x00" * 2048)  # 假媒体：解析时不应被读取
        for name, payload in extra:
            archive.writestr(name, payload)
        archive.writestr(collection_member, collection_bytes)
    return buffer.getvalue()


def _legacy_apkg(tmp_path, member="collection.anki2", notes=LEGACY_NOTES) -> bytes:
    path = tmp_path / f"{member}.sqlite"
    _legacy_db(path, notes)
    return _apkg(member, path.read_bytes())


def _new_schema_apkg(tmp_path, member="collection.anki21b", notes=None) -> bytes:
    path = tmp_path / "new.sqlite"
    _new_schema_db(path, notes) if notes is not None else _new_schema_db(path)
    return _apkg(member, path.read_bytes())


def _zstd(data: bytes) -> bytes:
    zstandard = pytest.importorskip("zstandard")
    return zstandard.ZstdCompressor().compress(data)


def _zstd_apkg(tmp_path) -> bytes:
    path = tmp_path / "new.sqlite"
    _new_schema_db(path)
    return _apkg("collection.anki21b", _zstd(path.read_bytes()))


def _post(client, data: bytes, filename="deck.apkg"):
    return client.post(
        "/api/wordlists/apkg-parse",
        files={"file": (filename, data, "application/octet-stream")},
    )


# ---------------------------------------------------------------------------
# 1–2. 三种 collection + 契约
# ---------------------------------------------------------------------------

def test_parse_legacy_anki2_contract(client, tmp_path):
    response = _post(client, _legacy_apkg(tmp_path), filename="GRE 核心.apkg")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["fileName"] == "GRE 核心.apkg"
    assert body["total"] == 3 and body["truncated"] is False
    assert body["decks"] == [
        {"id": "1", "name": "Default", "noteCount": 1},
        {"id": "2", "name": "GRE 核心", "noteCount": 2},
    ]
    assert body["models"] == [
        {"id": "1001", "name": "红宝书", "fields": LEGACY_FIELDS},
        {"id": "2002", "name": "Basic", "fields": ["Front", "Back"]},
    ]
    first, second, third = body["notes"]
    assert first["deckId"] == "2" and first["modelId"] == "1001"
    assert first["fields"] == [
        "apple",
        "/ˈæpəl/",
        "苹果",
        "An apple a day & more",
    ]
    assert (first["word"], first["translation"], first["phonetic"]) == (
        "apple",
        "苹果",
        "/ˈæpəl/",
    )
    # Front/Back 模型：按字段名映射。
    assert (second["word"], second["translation"], second["phonetic"]) == (
        "banana",
        "香蕉",
        "",
    )
    assert second["fields"] == ["banana", "香蕉"]
    # 块级标签换空格、多个空白压缩。
    assert third["fields"] == ["cherry", "樱桃 red"]
    assert third["deckId"] == "1"


def test_parse_collection_anki21(client, tmp_path):
    response = _post(client, _legacy_apkg(tmp_path, "collection.anki21"))
    assert response.status_code == 200, response.text
    assert response.json()["total"] == 3


def test_parse_anki21b_zstd_new_schema(client, tmp_path):
    response = _post(client, _zstd_apkg(tmp_path))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decks"] == [{"id": "1", "name": "Default", "noteCount": 1}]
    assert body["models"] == [
        {"id": "7", "name": "New Basic", "fields": ["Front", "Back"]}
    ]
    assert body["notes"] == [
        {
            "deckId": "1",
            "modelId": "7",
            "fields": ["abandon", "放弃"],
            "word": "abandon",
            "translation": "放弃",
            "phonetic": "",
        }
    ]


def test_collection_member_priority_prefers_anki21b(client, tmp_path):
    new_path = tmp_path / "new.sqlite"
    _new_schema_db(new_path, notes=((7, "zstdword\x1fzstd释义"),))
    legacy_path = tmp_path / "legacy.sqlite"
    _legacy_db(legacy_path)
    archive = _apkg(
        "collection.anki2",
        legacy_path.read_bytes(),
        extra=[
            ("collection.anki21", legacy_path.read_bytes()),
            ("collection.anki21b", _zstd(new_path.read_bytes())),
        ],
    )
    body = _post(client, archive).json()
    assert [deck["name"] for deck in body["decks"]] == ["Default"]
    assert body["notes"][0]["word"] == "zstdword"


def test_clean_html_rules():
    assert apkg_import.clean_html("<b>word</b><br>meaning") == "word meaning"
    assert apkg_import.clean_html("a<br/>b<br >c") == "a b c"
    assert apkg_import.clean_html("<div>a</div><p>b</p>") == "a b"
    assert apkg_import.clean_html("[sound:/tmp/a.mp3] apple") == "apple"
    assert apkg_import.clean_html("Tom &amp; Jerry &lt;3") == "Tom & Jerry <3"
    assert apkg_import.clean_html("  a\n\t b\u00a0c  ") == "a b c"
    assert apkg_import.clean_html(None) == ""


# ---------------------------------------------------------------------------
# 3. 截断（上限 10000）
# ---------------------------------------------------------------------------

def test_truncates_at_10000_notes(tmp_path):
    path = tmp_path / "many.sqlite"
    _new_schema_db(path, notes=())
    conn = sqlite3.connect(path)
    try:
        conn.executemany(
            "INSERT INTO notes (mid, flds) VALUES (7, ?)",
            [(f"w{index:05d}\x1f释义{index}",) for index in range(10001)],
        )
        conn.executemany(
            "INSERT INTO cards (nid, did) VALUES (?, 1)",
            [(index,) for index in range(1, 10002)],
        )
        conn.commit()
    finally:
        conn.close()
    result = apkg_import.parse_apkg(
        _apkg("collection.anki21", path.read_bytes()), "many.apkg"
    )
    assert result["total"] == 10001
    assert result["truncated"] is True
    assert len(result["notes"]) == 10000
    assert result["decks"][0]["noteCount"] == 10001
    assert result["notes"][-1]["word"] == "w09999"


# ---------------------------------------------------------------------------
# 4. 损坏 / 格式不支持 / 空 notes / 安全
# ---------------------------------------------------------------------------

def test_corrupt_zip_400(client):
    response = _post(client, b"definitely not a zip")
    assert response.status_code == 400
    assert "APKG" in response.json()["detail"]


@pytest.mark.parametrize("payload", [b"", b"SQLite format 3\x00garbage"])
def test_invalid_payload_400(client, payload):
    response = _post(client, _apkg("collection.anki2", payload))
    assert response.status_code == 400


def test_missing_collection_400(client):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("media", "{}")
        archive.writestr("0", b"media")
    response = _post(client, buffer.getvalue())
    assert response.status_code == 400
    assert "collection" in response.json()["detail"]


def test_unsupported_schema_400(client, tmp_path):
    path = tmp_path / "unknown.sqlite"
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE something (x INTEGER)")
        conn.commit()
    finally:
        conn.close()
    response = _post(client, _apkg("collection.anki2", path.read_bytes()))
    assert response.status_code == 400
    assert "不支持" in response.json()["detail"]


def test_empty_notes_400(client, tmp_path):
    path = tmp_path / "empty.sqlite"
    _legacy_db(path, notes=[])
    response = _post(client, _apkg("collection.anki2", path.read_bytes()))
    assert response.status_code == 400
    assert "notes" in response.json()["detail"]


def test_path_traversal_member_rejected(client, tmp_path):
    archive = _apkg(
        "collection.anki2",
        _legacy_apkg(tmp_path),
        extra=[("../evil.txt", b"x")],
    )
    response = _post(client, archive)
    assert response.status_code == 400
    assert "路径" in response.json()["detail"]


def test_encrypted_member_rejected(tmp_path):
    # 手工翻转 ZIP 本地/中央目录的加密位，模拟加密成员。
    data = bytearray(_legacy_apkg(tmp_path))
    for signature in (b"PK\x03\x04", b"PK\x01\x02"):
        offset = data.find(signature)
        assert offset >= 0
        if signature == b"PK\x03\x04":
            data[offset + 6] |= 0x01  # general purpose bit flag 低字节
        else:
            data[offset + 8] |= 0x01
    with pytest.raises(apkg_import.ApkgInvalid):
        apkg_import.parse_apkg(bytes(data), "x.apkg")


def test_media_member_never_opened(monkeypatch, tmp_path):
    archive = _legacy_apkg(tmp_path)
    opened: list[str] = []
    real_open = zipfile.ZipFile.open

    def spy(self, name, *args, **kwargs):
        opened.append(name if isinstance(name, str) else name.filename)
        return real_open(self, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "open", spy)
    result = apkg_import.parse_apkg(archive, "x.apkg")
    assert result["total"] == 3
    assert opened == ["collection.anki2"]


# ---------------------------------------------------------------------------
# 5. zstd 依赖 / 损坏 / 解压上限
# ---------------------------------------------------------------------------

def test_zstd_missing_returns_503(client, monkeypatch, tmp_path):
    archive = _zstd_apkg(tmp_path)

    def missing():
        raise apkg_import.ApkgUnavailable("服务器缺少 zstandard 依赖。")

    monkeypatch.setattr(apkg_import, "_load_zstd", missing)
    response = _post(client, archive)
    assert response.status_code == 503
    assert "zstandard" in response.json()["detail"]


def test_corrupt_zstd_returns_400(client):
    response = _post(client, _apkg("collection.anki21b", b"not zstd data"))
    assert response.status_code == 400
    assert ".anki21b" in response.json()["detail"]


def test_zstd_decompression_limit_413(monkeypatch, tmp_path):
    path = tmp_path / "new.sqlite"
    _new_schema_db(path)
    archive = _apkg("collection.anki21b", _zstd(path.read_bytes()))
    monkeypatch.setattr(apkg_import, "MAX_COLLECTION_BYTES", 128)
    with pytest.raises(apkg_import.ApkgTooLarge) as excinfo:
        apkg_import.parse_apkg(archive, "x.apkg")
    assert excinfo.value.status_code == 413


def test_collection_member_limit_413(monkeypatch, tmp_path):
    monkeypatch.setattr(apkg_import, "MAX_COLLECTION_BYTES", 128)
    monkeypatch.setattr(apkg_import, "MAX_UPLOAD_BYTES", 1024 * 1024)
    with pytest.raises(apkg_import.ApkgTooLarge):
        apkg_import.parse_apkg(_legacy_apkg(tmp_path), "x.apkg")


# ---------------------------------------------------------------------------
# 6. 上传层：50MB / 扩展名 / 未登录
# ---------------------------------------------------------------------------

def test_upload_over_limit_413(client, monkeypatch):
    monkeypatch.setattr(apkg_import, "MAX_UPLOAD_BYTES", 1024)
    response = _post(client, b"x" * 2048)
    assert response.status_code == 413
    assert "上限" in response.json()["detail"]


def test_default_upload_limit_is_50mb():
    assert apkg_import.MAX_UPLOAD_BYTES == 50 * 1024 * 1024


def test_non_apkg_extension_400(client, tmp_path):
    response = _post(client, _legacy_apkg(tmp_path), filename="deck.zip")
    assert response.status_code == 400
    assert ".apkg" in response.json()["detail"]


def test_anonymous_403(make_client):
    with make_client() as anonymous:
        response = _post(anonymous, b"anything")
    assert response.status_code == 403


def test_missing_file_400(client):
    response = client.post("/api/wordlists/apkg-parse")
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 7. 真实体量：7512 notes + 30MB APKG 不误杀 + 全量导入
# ---------------------------------------------------------------------------

GRE_COUNT = 7512


def _letters(index: int) -> str:
    letters = "abcdefghijklmnopqrstuvwxyz"
    high, rest = divmod(index, 26 * 26)
    mid, low = divmod(rest, 26)
    return f"{letters[high]}{letters[mid]}{letters[low]}"


def _gre_like_db(path) -> None:
    models = {
        "1373551545417": {
            "id": 1373551545417,
            "name": "红宝书",
            "flds": [
                {"name": "单词", "ord": 0},
                {"name": "音标", "ord": 1},
                {"name": "解释", "ord": 2},
                {"name": "红宝书", "ord": 3},
            ],
        }
    }
    decks = {
        "1": {"id": 1, "name": "Default"},
        "1448927191118": {"id": 1448927191118, "name": "极品GRE红宝书"},
    }
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE col (id INTEGER PRIMARY KEY, models TEXT, decks TEXT);
            CREATE TABLE notes (id INTEGER PRIMARY KEY, mid INTEGER, flds TEXT);
            CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER);
            """
        )
        conn.execute(
            "INSERT INTO col (models, decks) VALUES (?, ?)",
            (json.dumps(models, ensure_ascii=False), json.dumps(decks)),
        )
        conn.executemany(
            "INSERT INTO notes (mid, flds) VALUES (1373551545417, ?)",
            [
                (f"w{_letters(index)}\x1f[{index}]\x1f释义{index}\x1f记忆索引{index}",)
                for index in range(GRE_COUNT)
            ],
        )
        conn.executemany(
            "INSERT INTO cards (nid, did) VALUES (?, 1448927191118)",
            [(index,) for index in range(1, GRE_COUNT + 1)],
        )
        conn.commit()
    finally:
        conn.close()


def test_gre_like_7512_notes_30mb_and_full_import(client, tmp_path):
    db_path = tmp_path / "gre.sqlite"
    _gre_like_db(db_path)
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (apkg)"
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("media", "{}")
        # 媒体用 STORED 撑到 30MB 量级：解析只读 collection，不应 413。
        archive.writestr(
            "0", b"\x00" * (30 * 1024 * 1024), compress_type=zipfile.ZIP_STORED
        )
        archive.writestr(
            "collection.anki2",
            db_path.read_bytes(),
            compress_type=zipfile.ZIP_DEFLATED,
        )
    package = buffer.getvalue()
    assert len(package) > 30 * 1024 * 1024

    response = _post(client, package, filename="GRE.apkg")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == GRE_COUNT
    assert body["truncated"] is False
    assert len(body["notes"]) == GRE_COUNT
    assert body["decks"] == [
        {"id": "1", "name": "Default", "noteCount": 0},
        {"id": "1448927191118", "name": "极品GRE红宝书", "noteCount": GRE_COUNT},
    ]
    first = body["notes"][0]
    assert (first["word"], first["translation"], first["phonetic"]) == (
        "waaa",
        "释义0",
        "[0]",
    )

    items = [
        {"word": note["word"], "translation": note["translation"]}
        for note in body["notes"]
    ]
    imported = client.post(
        "/api/wordlists/import", json={"name": "GRE", "items": items}
    )
    assert imported.status_code == 201, imported.text
    assert imported.json()["list"]["itemCount"] == GRE_COUNT
    assert imported.json()["skipped"] == 0
