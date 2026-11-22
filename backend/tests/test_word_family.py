"""CEFR 词族表 API 离线验收（specs/041-word-family-list / routes_vocabulary.py）。

覆盖：

- 规则 E 的数据契约：3,696 族 / 11,567 成员 / 10k 内 5,233 / 10k 外 6,334 /
  最大族 18；黑名单 17 条、allowlist 22 条；the/at 不在任何族；
- 指定族：decide 5 人、reflect 含 reflection（allowlist）、judge 不含
  adjudicate（黑名单删边后 7 人）、comprehend 最大族 18 人含 extend；
- API：总数、分页 50/页 + hasMore + 越界页、q 命中任一成员（含 10k 外）、
  level 筛选、sort=rank/alpha；
- 非法参数 400（page/pageSize/sort/level/q 长度）；旧 lemma-list 端点已删除；
- 游客可读、不签发游客 Cookie、公开缓存头、不调 AI、不写库；
- 词族/释义数据缺失或损坏 → 503；缺释义时 phonetic/translation 留空，不编造。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest

import vocabulary
import word_family

ENDPOINT = "/api/vocabulary/word-families"
DATA_PATH = Path(word_family.WORD_FAMILIES_PATH)
FREQUENCY_PATH = DATA_PATH.parent / "frequency_bands.v1.json"
LEVELS = ("A1", "A2", "B1", "B2", "C1")
EXPECTED = {
    "families": 3696,
    "members": 11567,
    "cefrMembers": 5233,
    "outsideMembers": 6334,
    "maxFamilySize": 18,
}


@pytest.fixture(autouse=True)
def fresh_index():
    """每个用例从同一份仓库只读数据重新建索引（测试间不共享缓存）。"""
    word_family.reset_cache()
    yield
    word_family.reset_cache()


def load_document() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def raw_families() -> list:
    return load_document()["families"]


def family_by_head(head: str) -> dict:
    return next(family for family in raw_families() if family["head"] == head)


def test_total_and_first_page(make_client):
    """3,696 族；默认按 head 词频升序，50/页，字段形状与 head 契约。"""
    with make_client() as client:
        response = client.get(ENDPOINT, params={"pageSize": 1})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["total"] == EXPECTED["families"]
        assert body["page"] == 1
        assert body["pageSize"] == 1
        assert body["hasMore"] is True
        assert len(body["items"]) == 1
        item = body["items"][0]
        # 全库 head rank 最小的族是 be（rank 2）。
        assert item["id"] == "F0001"
        assert item["head"] == "be"
        assert item["headRank"] == 2
        assert item["headLevel"] == "A1"
        assert set(item) == {
            "id", "head", "headRank", "headLevel", "headPhonetic",
            "headTranslation", "levels", "members",
        }
        assert item["head"] == item["members"][0]["lemma"]
        assert item["headRank"] == item["members"][0]["rank"]
        assert item["headLevel"] == item["members"][0]["level"]
        assert item["levels"] == [
            level for level in LEVELS
            if any(member["level"] == level for member in item["members"])
        ]
        assert len(item["members"]) >= 2
        for member in item["members"]:
            assert set(member) == {"lemma", "level", "rank"}
            assert member["level"] in LEVELS or member["level"] is None
            assert (member["level"] is None) == (member["rank"] is None)
    assert "ln_guest" not in response.cookies


def test_cross_boundary_members_have_empty_level(make_client):
    """10k 外成员保留在族里，level/rank 为 null（等级留空，不默认 A1）。"""
    with make_client() as client:
        body = client.get(ENDPOINT, params={"q": "largeness", "pageSize": 50}).json()
    assert body["total"] == 1, "q 命中 10k 外成员也要返回整族"
    family = body["items"][0]
    assert family["head"] == "large"
    assert len(family["members"]) == EXPECTED["maxFamilySize"]
    outside = [member for member in family["members"] if member["level"] is None]
    assert len(outside) == 10
    assert all(member["rank"] is None for member in outside)
    assert {member["lemma"] for member in outside} >= {"largeness", "extendible"}
    assert len([member for member in family["members"] if member["level"]]) == 8


def test_named_families_match_rule_e(make_client):
    """卡里点名的族：decide / reflect / judge / comprehend。"""
    with make_client() as client:
        decide = client.get(ENDPOINT, params={"q": "decide"}).json()
        reflect = client.get(ENDPOINT, params={"q": "reflection"}).json()
        judge = client.get(ENDPOINT, params={"q": "judge"}).json()
        comprehend = client.get(ENDPOINT, params={"q": "comprehend"}).json()

    decide_family = decide["items"][0]
    assert decide_family["head"] == "decide"
    assert len(decide_family["members"]) == 5
    assert {member["lemma"] for member in decide_family["members"]} == {
        "decide", "decision", "decisive", "deciding", "decisiveness",
    }

    # allowlist：WordNet 3.0 缺 reflect–reflection，规则 E 补上后同族。
    reflect_family = reflect["items"][0]
    assert reflect_family["head"] == "reflect"
    assert "reflection" in {member["lemma"] for member in reflect_family["members"]}

    # 黑名单：judge–adjudicate 删边后 adjudicate 不再入族；judgeship 等仍在。
    judge_family = judge["items"][0]
    lemmas = {member["lemma"] for member in judge_family["members"]}
    assert "judge" in lemmas
    assert "adjudicate" not in lemmas, "黑名单边 judge–adjudicate 必须已删除"
    assert len(judge_family["members"]) == 7
    assert judge_family["members"][0]["lemma"] == "judge"

    # 最大族：18 人，head=large，含 extend（审计 §3.5 的桥接结论）。
    assert len(comprehend["items"][0]["members"]) == EXPECTED["maxFamilySize"]
    assert {member["lemma"] for member in comprehend["items"][0]["members"]} >= {
        "large", "extend", "comprehend",
    }


def test_level_filter(make_client):
    """level 命中族内任一成员；total 与数据里含该等级的族数一致。"""
    families = raw_families()
    with make_client() as client:
        for level in LEVELS:
            expected = sum(1 for family in families if level in family["levels"])
            body = client.get(
                ENDPOINT, params={"level": level, "pageSize": 200}).json()
            assert body["total"] == expected
            assert all(level in item["levels"] for item in body["items"])
            assert all(
                any(member["level"] == level for member in item["members"])
                for item in body["items"]
            )
        # 大小写不敏感。
        lower = client.get(ENDPOINT, params={"level": "a1", "pageSize": 1}).json()
        upper = client.get(ENDPOINT, params={"level": "A1", "pageSize": 1}).json()
    assert lower == upper
    assert upper["total"] == sum(1 for family in families if "A1" in family["levels"])


def test_search_any_member_and_case_insensitive(make_client):
    """q 匹配任一成员（大小写不敏感子串），不是只匹配 head。"""
    with make_client() as client:
        # 10k 外成员命中 → 返回整族。
        outside = client.get(ENDPOINT, params={"q": "deciding"}).json()
        assert outside["total"] == 1
        assert outside["items"][0]["head"] == "decide"
        # 中间成员命中。
        middle = client.get(ENDPOINT, params={"q": "decision"}).json()
        assert [item["head"] for item in middle["items"]] == ["decide"]
        # 大小写不敏感。
        upper = client.get(ENDPOINT, params={"q": "DECISION"}).json()
        assert upper["items"] == middle["items"]
        # 黑名单删掉的 10k 外词不再属于任何族。
        dropped = client.get(ENDPOINT, params={"q": "adjudicate"}).json()
        assert dropped["total"] == 0
        assert dropped["items"] == []
        assert dropped["hasMore"] is False
        # 子串命中多族时按 rank 升序。
        broad = client.get(ENDPOINT, params={"q": "ref", "pageSize": 200}).json()
        assert broad["total"] > 1
        ranks = [item["headRank"] for item in broad["items"]]
        assert ranks == sorted(ranks)


def test_pagination_and_sort(make_client):
    """服务端 50/页、hasMore、越界页、rank/alpha 排序。"""
    families = raw_families()
    total = EXPECTED["families"]
    pages = (total + 49) // 50
    with make_client() as client:
        page1 = client.get(ENDPOINT, params={"page": 1, "pageSize": 50}).json()
        assert len(page1["items"]) == 50
        assert page1["total"] == total
        assert page1["hasMore"] is True
        page2 = client.get(ENDPOINT, params={"page": 2, "pageSize": 50}).json()
        assert page2["page"] == 2
        assert page2["items"][0]["head"] == families[50]["head"]
        assert page2["items"][0]["headRank"] == families[50]["headRank"]
        assert not ({item["id"] for item in page1["items"]}
                    & {item["id"] for item in page2["items"]})
        last = client.get(ENDPOINT, params={"page": pages, "pageSize": 50}).json()
        assert len(last["items"]) == total - (pages - 1) * 50
        assert last["hasMore"] is False
        beyond = client.get(ENDPOINT, params={"page": pages + 1, "pageSize": 50}).json()
        assert beyond["items"] == []
        assert beyond["total"] == total
        assert beyond["hasMore"] is False

        alpha = client.get(ENDPOINT, params={"sort": "alpha", "pageSize": 200}).json()
        heads = [item["head"] for item in alpha["items"]]
        assert heads == sorted(heads)
        assert heads[0] == "abandon"
        assert alpha["total"] == total
        # 排序只改变顺序，不改变 total；与默认 rank 顺序不同。
        default = client.get(ENDPOINT, params={"pageSize": 200}).json()
        assert [item["head"] for item in default["items"]] != heads
        alpha_a1 = client.get(
            ENDPOINT, params={"sort": "alpha", "level": "A1", "pageSize": 200}).json()
        assert alpha_a1["total"] == sum(
            1 for family in families if "A1" in family["levels"])


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},
        {"pageSize": 0},
        {"pageSize": 201},
        {"sort": "frequency"},
        {"level": "Z9"},
        {"level": "C2"},
        {"q": "x" * 65},
    ],
)
def test_invalid_parameters_are_400(make_client, params):
    with make_client() as client:
        response = client.get(ENDPOINT, params=params)
    assert response.status_code == 400, response.text
    assert response.json()["detail"]


def test_public_read_only_contract(make_client):
    """游客可读：不签发游客 Cookie、公开缓存头；旧 lemma-list 端点已删除。"""
    with make_client() as client:
        response = client.get(ENDPOINT, params={"q": "reflect", "level": "A2"})
        removed = client.get("/api/vocabulary/lemma-list")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert "ln_guest" not in response.cookies
    assert all(
        "ln_guest" not in header
        for header in response.headers.get_list("set-cookie")
    )
    assert removed.status_code == 404


def test_data_document_contract():
    """静态数据契约：来源/license/规则/人工清单/验收数字/无族词不出现。"""
    document = load_document()
    assert document["schema"] == "linguatrek.word-family.v1"
    assert document["ruleVersion"] == "E"
    assert document["version"] == "2026.11.23"
    assert "WordNet" in document["license"]
    assert document["source"]["wordnet"]["version"] == "3.0"
    expected_sha = hashlib.sha256(FREQUENCY_PATH.read_bytes()).hexdigest()
    assert document["source"]["frequencyBands"]["sha256"] == expected_sha
    assert document["source"]["frequencyBands"]["lemmas"] == 10000
    for key, value in EXPECTED.items():
        assert document["counts"][key] == value, key
    assert document["counts"]["cefrWithoutFamily"] == 4767
    assert document["counts"]["cefrCoveragePct"] == 52.33
    blacklist = document["blacklist"]
    allowlist = document["allowlist"]
    assert len(blacklist) == 17
    assert len(allowlist) == 22
    assert {entry["category"] for entry in blacklist} == {
        "semantic_split", "clear_error",
    }
    assert {entry["group"] for entry in blacklist} == {
        "inherited", "opened", "new",
    }
    assert len({(entry["a"], entry["b"]) for entry in blacklist}) == 17
    assert len({(entry["a"], entry["b"]) for entry in allowlist}) == 22
    assert ("reflect", "reflection") in {
        (entry["a"], entry["b"]) for entry in allowlist}
    # 无族词不进数据：the/at 不在任何族的成员里。
    members = {
        member["lemma"]
        for family in document["families"]
        for member in family["members"]
    }
    assert "the" not in members
    assert "at" not in members
    # family id 连续、head 是 members[0]、等级集合与成员一致。
    for index, family in enumerate(document["families"], start=1):
        assert family["id"] == f"F{index:04d}"
        assert family["head"] == family["members"][0]["lemma"]
        assert family["headRank"] == family["members"][0]["rank"]
        assert family["headLevel"] == family["members"][0]["level"]
        assert family["levels"] == [
            level for level in LEVELS if level in {
                member["level"] for member in family["members"]}]
        assert len(family["members"]) >= 2
        assert any(member["level"] for member in family["members"])


def test_missing_data_is_503(monkeypatch, make_client, tmp_path):
    """词族文件缺失 → 503（与 /lists 一致的错误语义），不是空列表。"""
    monkeypatch.setattr(
        word_family, "WORD_FAMILIES_PATH",
        str(tmp_path / "missing-word-families.json"), raising=False)
    word_family.reset_cache()
    with make_client() as client:
        response = client.get(ENDPOINT)
    assert response.status_code == 503
    assert "词族" in response.json()["detail"]


def test_corrupt_data_is_503():
    """完整性/结构校验失败 → 503，不带着坏索引继续服务。"""
    document = load_document()
    document["counts"]["families"] += 1
    with pytest.raises(word_family.WordFamilyUnavailable):
        word_family._build_index(document, key=("inline", (0, 0)))

    document = load_document()
    document["schema"] = "linguatrek.word-family.v0"
    with pytest.raises(word_family.WordFamilyUnavailable):
        word_family._build_index(document, key=("inline", (0, 0)))

    document = load_document()
    document["ruleVersion"] = "B"
    with pytest.raises(word_family.WordFamilyUnavailable):
        word_family._build_index(document, key=("inline", (0, 0)))


def test_missing_lexicon_entry_keeps_empty_fields(monkeypatch):
    """缺释义/音标时留空字符串，不编造。"""
    real = vocabulary.load_lexicon()
    stripped = replace(
        real,
        entries={key: value for key, value in real.entries.items() if key != "decide"},
    )
    monkeypatch.setattr(vocabulary, "load_lexicon", lambda: stripped)
    word_family.reset_cache()
    index = word_family.load_index()
    decide = next(family for family in index.families if family.head == "decide")
    assert decide.phonetic == ""
    assert decide.translation == ""
    assert decide.head_level == "A1"
    assert len(decide.members) == 5


def test_index_is_cached_and_resettable():
    first = word_family.load_index()
    second = word_family.load_index()
    assert first is second
    word_family.reset_cache()
    assert word_family.load_index() is not first


def test_warmup_swallows_unavailable_data(monkeypatch, tmp_path):
    """启动 warmup 不因数据缺失阻断应用（请求期再映射 503）。"""
    monkeypatch.setattr(
        word_family, "WORD_FAMILIES_PATH",
        str(tmp_path / "missing-word-families.json"), raising=False)
    word_family.reset_cache()
    word_family.warmup()  # 不抛
