"""用户数据路由：点查词典、收藏、订阅。

查词顺序：`dictionary_cache.json`（按小写词缓存大模型释义）→ 本地 ECDICT
（`local_dict.lookup`，命中直接返回、不花钱）→ 大模型候选链（结果才写缓存）。
本地词典是可选数据，没装时行为与以前完全一致。
收藏与订阅是简单的整存整取 JSON 文件。
"""
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import local_dict
from config import HISTORY_DIR, MODEL_CATALOG

router = APIRouter()

# ====================================================
# Click-to-define dictionary
# ====================================================

DICT_CACHE_FILE = os.path.join(HISTORY_DIR, "dictionary_cache.json")
DICT_MODEL = "gemini-3.5-flash-lite"  # fast + cheap for single-word lookups
# 2.5 Flash-Lite 已对新用户下线（404），旧的配置会让 /api/define 直接 502。
DICT_FALLBACK_MODEL = "gemini-2.5-flash"  # 词典再挂时退到默认模型，别让查词直接失败


def _dict_model_candidates() -> list:
    """按优先级排出「已配置 Key」的候选模型。

    只有 DeepSeek Key 的用户也能查词：Gemini 候选没 Key 就自动跳过，
    退到清单里第一个可用的模型。
    """
    ordered = [DICT_MODEL, DICT_FALLBACK_MODEL]
    ordered += [m for m in MODEL_CATALOG if m not in ordered]
    return [m for m in ordered if llm.is_available(m)]


class DefineRequest(BaseModel):
    word: str
    context: str | None = None


def _load_dict_cache() -> dict:
    if os.path.exists(DICT_CACHE_FILE):
        try:
            with open(DICT_CACHE_FILE, "r", encoding="utf-8") as f:
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
    if key in cache:
        return cache[key]

    # 本地词典优先：常见词直接秒回，不花模型额度。
    # 本地命中**不写** dictionary_cache.json —— 那里存的是「结合语境生成」的
    # 模型释义；把静态词典释义混进去，会让后续同词查询拿到错位的缓存。
    local_entry = local_dict.lookup(word)
    if local_entry is not None:
        return local_entry

    context_part = f'It appears in this sentence: "{request.context.strip()}"' if request.context else ""
    prompt = f"""You are an English-Chinese dictionary for Chinese learners of English.
Explain the English word or phrase "{word}". {context_part}
Return ONLY a JSON object with exactly these fields:
{{
  "word": "{word}",
  "lemma": "base/dictionary form",
  "ipa": "IPA pronunciation like /ˈwɜːrd/",
  "pos": "part of speech abbreviation (n. / v. / adj. / adv. / phrase ...)",
  "zh": "简明中文释义，优先该语境下的含义，不超过 20 字",
  "definition_en": "concise English definition (one sentence)",
  "example": "one short, natural example sentence in English"
}}"""

    result = None
    for model_id in _dict_model_candidates():
        try:
            result = json.loads(llm.generate_json(prompt, model=model_id))
            if isinstance(result, list):
                result = result[0] if result else {}
            result.setdefault("word", word)
            break
        except Exception as e:
            print(f"Dictionary lookup failed for '{word}' with {model_id}: {e}")

    if result is None:
        raise HTTPException(status_code=502, detail="查词失败，请稍后重试。")

    cache[key] = result
    try:
        with open(DICT_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"Failed to persist dictionary cache: {e}")
    return result


# --- Favorites persistence ---
FAVORITES_FILE = os.path.join(HISTORY_DIR, "favorites.json")


@router.get("/api/favorites")
def get_favorites():
    if os.path.exists(FAVORITES_FILE):
        with open(FAVORITES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


@router.put("/api/favorites")
async def save_favorites(request: dict):
    favorites = request.get("favorites", [])
    with open(FAVORITES_FILE, "w", encoding="utf-8") as f:
        json.dump(favorites, f, ensure_ascii=False, indent=2)
    return {"status": "ok", "count": len(favorites)}


# --- Subscriptions persistence ---
SUBS_FILE = os.path.join(HISTORY_DIR, "subscriptions.json")


@router.get("/api/subscriptions")
def get_subscriptions():
    if os.path.exists(SUBS_FILE):
        with open(SUBS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


@router.put("/api/subscriptions")
async def save_subscriptions(request: dict):
    subs = request.get("subscriptions", [])
    with open(SUBS_FILE, "w", encoding="utf-8") as f:
        json.dump(subs, f, ensure_ascii=False, indent=2)
    return {"status": "ok", "count": len(subs)}
