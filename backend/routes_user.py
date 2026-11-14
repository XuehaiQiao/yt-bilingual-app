"""用户数据路由：点查词典、收藏、订阅。

查词顺序：`dictionary_cache.json`（按小写词缓存大模型释义）→ 本地 ECDICT
（`local_dict.lookup`，命中直接返回、不花钱）→ 大模型候选链（结果才写缓存）。
本地词典是可选数据，没装时行为与以前完全一致。
收藏与订阅是简单的整存整取 JSON 文件。
"""
import asyncio
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import local_dict
import storage
from ai import quota
from ai.ledger import QuotaExceeded
from config import DEFAULT_MODEL, MODEL_CATALOG, resolve_model

router = APIRouter()

# ====================================================
# Click-to-define dictionary
# ====================================================

DICT_MODEL = "gemini-3.5-flash-lite"  # fast + cheap for single-word lookups
# 2.5 Flash-Lite 已对新用户下线（404），旧的配置会让 /api/define 直接 502。
# 词典再挂时退到全局默认模型；直接引用 DEFAULT_MODEL，避免默认值在这里
# 再抄一遍而两边漂移（改 config 一处即可）。
DICT_FALLBACK_MODEL = DEFAULT_MODEL
# 一个词最多返回这么多义项：长尾词义（尤其多词性）不该撑爆响应。
MAX_SENSES = 12


def _clean_field(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clean_sense(raw) -> dict | None:
    """把来源不明的义项规整成契约形状；没有中文/英文释义的条目丢弃。"""
    if not isinstance(raw, dict):
        return None
    sense = {
        "pos": _clean_field(raw.get("pos")),
        "zh": _clean_field(raw.get("zh")),
        "definition_en": _clean_field(raw.get("definition_en")),
    }
    if not sense["zh"] and not sense["definition_en"]:
        return None
    return sense


def _top_level_sense(entry: dict) -> dict:
    return {
        "pos": _clean_field(entry.get("pos")),
        "zh": _clean_field(entry.get("zh")),
        "definition_en": _clean_field(entry.get("definition_en")),
    }


def _normalize_dict_entry(entry, fallback_word: str = "") -> dict:
    """把任意来源的释义规整成冻结契约：senses 1–12 条，首条 = 顶层字段。

    兼容旧版 `dictionary_cache.json`：没有 senses（或为空/非法）时用顶层字段
    构造一条，不报错也不返回空。顶层字段是既有前端的契约，因此首条义项以它
    为准；顶层缺失的字段反过来由首条义项补全。
    """
    if not isinstance(entry, dict):
        entry = {}
    normalized = dict(entry)

    senses = []
    raw_senses = normalized.get("senses")
    if isinstance(raw_senses, list):
        for raw in raw_senses:
            sense = _clean_sense(raw)
            if sense is not None:
                senses.append(sense)
    if not senses:
        senses = [_top_level_sense(normalized)]
    senses = senses[:MAX_SENSES]

    first = senses[0]
    for field in ("pos", "zh", "definition_en"):
        top = _clean_field(normalized.get(field))
        if top:
            first[field] = top
        else:
            normalized[field] = first[field]

    normalized["senses"] = senses
    if not _clean_field(normalized.get("word")):
        normalized["word"] = fallback_word
    if not _clean_field(normalized.get("lemma")):
        normalized["lemma"] = normalized.get("word", "")
    for field in ("ipa", "example"):
        normalized[field] = _clean_field(normalized.get(field))
    return normalized


def _dict_model_candidates() -> list:
    """按优先级排出「已配置 Key」的候选模型。

    首位是**全局默认模型**（`resolve_model(None)`）：请求没带 `model` 时，
    词典要跟随产品级默认（`DEFAULT_MODEL`），而不是被词典自己的小模型偏好
    截胡；`DICT_MODEL` 作为后续候选保留（更便宜，默认模型失败时再试）。
    只有 DeepSeek Key 的用户也能查词：没配 Key 的候选自动跳过，
    退到清单里第一个可用的模型。
    """
    ordered = [resolve_model(None), DICT_MODEL, DICT_FALLBACK_MODEL]
    ordered += [m for m in MODEL_CATALOG if m not in ordered]
    deduped = list(dict.fromkeys(ordered))  # DICT_FALLBACK_MODEL 现在是 DEFAULT_MODEL 的别名，去重
    return [m for m in deduped if llm.is_available(m)]


def _dict_models_for_request(preferred: str | None) -> list:
    """请求指定的模型（必须已确认存在于目录且已配 Key）排第一，其余沿用候选链并去重。

    请求模型不存在或未传时 `preferred` 为 None，此时直接用候选链（首位是
    默认模型）；模型存在但没配 Key 时也会退回原候选链。两种情况都不该导致 502。
    """
    candidates = _dict_model_candidates()
    if preferred and llm.is_available(preferred):
        return [preferred] + [m for m in candidates if m != preferred]
    return candidates


def _model_display_name(model_id: str) -> str:
    """模型 id → 目录里的展示名；目录里没有时原样返回，不编造。"""
    spec = MODEL_CATALOG.get(model_id)
    return spec["name"] if spec else model_id


class DefineRequest(BaseModel):
    word: str
    context: str | None = None
    model: str | None = None


def _load_dict_cache() -> dict:
    cache_file = storage.dictionary_cache_file()
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {}


@router.post("/api/define")
async def define_word(request: DefineRequest):
    word = request.word.strip()
    if not word or len(word) > 100:
        raise HTTPException(status_code=400, detail="无效的查询词。")

    # Cache by lowercase word; first lookup wins (context only refines the
    # initial generation — good enough and keeps repeat lookups free).
    cache = _load_dict_cache()
    key = word.lower()
    cached = cache.get(key)
    if isinstance(cached, dict):
        # 旧版缓存没有 senses：读取时用顶层字段补一条，不报错、不返回空。
        # 缓存命中不声称「本次用了模型」：model / modelName 只在真正调用
        # 大模型生成的那次响应里出现，也不写进 dictionary_cache.json。
        return _normalize_dict_entry(cached, fallback_word=word)

    # 本地词典优先：常见词直接秒回，不花模型额度。
    # 本地命中**不写** dictionary_cache.json —— 那里存的是「结合语境生成」的
    # 模型释义；把静态词典释义混进去，会让后续同词查询拿到错位的缓存。
    local_entry = local_dict.lookup(word)
    if local_entry is not None:
        entry = _normalize_dict_entry(local_entry, fallback_word=word)
        # 本地词典没有调用任何模型：显式标来源，且不带 model / modelName，
        # 免得前端把静态释义误标成「由某个模型生成」。
        entry["source"] = "local"
        return entry

    context_part = f'It appears in this sentence: "{request.context.strip()}"' if request.context else ""
    prompt = f"""You are an English-Chinese dictionary for Chinese learners of English.
Explain the English word or phrase "{word}". {context_part}
Return ONLY a JSON object with exactly these fields:
{{
  "word": "{word}",
  "lemma": "base/dictionary form",
  "ipa": "IPA pronunciation like /ˈwɜːrd/",
  "pos": "part of speech abbreviation of the FIRST sense (n. / v. / adj. / adv. / phrase ...)",
  "zh": "第一条义项的中文释义，不超过 20 字",
  "definition_en": "concise English definition of the FIRST sense (one sentence)",
  "example": "one short, natural example sentence in English",
  "senses": [
    {{"pos": "n.", "zh": "中文义项", "definition_en": "concise English definition (one sentence)"}}
  ]
}}
Rules for "senses":
- 2-5 common senses ordered by how common they are; merge rare / long-tail senses instead of listing them all.
- Each sense is a distinct meaning; change "pos" when the part of speech changes.
- The first item MUST match the top-level "pos" / "zh" / "definition_en" exactly.
- A word with only one common meaning may have a single item.
- If a context sentence is given, put the meaning used in that sentence first."""

    result = None
    used_model = None
    # 只有确实存在于目录里的模型才参与优先排序；不存在的模型交给
    # `_dict_model_candidates()` 原候选链兜底，而不是挤掉候选链首位。
    preferred = resolve_model(request.model) if request.model in MODEL_CATALOG else None

    # AI 硬闸：词典是每用户 200 次/日的第三层配额之一；超限返回 429（前端提示
    # 「今天的 AI 额度用完了」）。预算超限（BudgetExceeded 是其子类）同走这里。
    user_id = storage.active_user_id()
    try:
        quota.check_and_consume_quota(user_id, "define")
    except QuotaExceeded as e:
        raise HTTPException(
            status_code=getattr(e, "status_code", 429), detail=str(e)
        ) from e

    for model_id in _dict_models_for_request(preferred):
        try:
            # 模型 SDK 是同步阻塞调用；放进线程，别卡住事件循环（P0‑1）。
            with llm.usage_scope("define", user_id):
                parsed = json.loads(
                    await asyncio.to_thread(llm.generate_json, prompt, model=model_id)
                )
            if isinstance(parsed, list):
                parsed = parsed[0] if parsed else {}
            if not isinstance(parsed, dict):
                raise ValueError(f"模型返回的不是 JSON 对象（{type(parsed).__name__}）")
            parsed.setdefault("word", word)
            # 模型漏返 senses 时，_normalize_dict_entry 会用顶层字段补一条。
            result = _normalize_dict_entry(parsed, fallback_word=word)
            used_model = model_id
            break
        except Exception as e:
            print(f"Dictionary lookup failed for '{word}' with {model_id}: {e}")

    if result is None:
        raise HTTPException(status_code=502, detail="查词失败，请稍后重试。")

    cache[key] = result
    try:
        with open(storage.dictionary_cache_file(), "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"Failed to persist dictionary cache: {e}")
    # 透明度：在既有字段之外补上这次**实际成功使用**的模型（可能是候选链
    # 降级后的那个）。这两个字段只进响应、不写缓存，既有前端字段不受影响。
    return {
        **result,
        "model": used_model,
        "modelName": _model_display_name(used_model),
    }


# --- Favorites persistence (per authenticated user; legacy fallback in storage) ---


@router.get("/api/favorites")
def get_favorites():
    favorites_file = storage.favorites_file()
    if os.path.exists(favorites_file):
        with open(favorites_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


@router.put("/api/favorites")
async def save_favorites(request: dict):
    favorites = request.get("favorites", [])
    with open(storage.favorites_file(), "w", encoding="utf-8") as f:
        json.dump(favorites, f, ensure_ascii=False, indent=2)
    return {"status": "ok", "count": len(favorites)}


# --- Subscriptions persistence (per authenticated user) ---


@router.get("/api/subscriptions")
def get_subscriptions():
    subscriptions_file = storage.subscriptions_file()
    if os.path.exists(subscriptions_file):
        with open(subscriptions_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


@router.put("/api/subscriptions")
async def save_subscriptions(request: dict):
    subs = request.get("subscriptions", [])
    with open(storage.subscriptions_file(), "w", encoding="utf-8") as f:
        json.dump(subs, f, ensure_ascii=False, indent=2)
    return {"status": "ok", "count": len(subs)}
