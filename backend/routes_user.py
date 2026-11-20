"""用户数据路由：点查词典、收藏、订阅。

查词顺序：`dictionary_cache.json`（按小写词缓存大模型释义）→ 本地 ECDICT
（`local_dict.lookup`，命中直接返回、不花钱）→ 大模型候选链（结果才写缓存）。
本地词典是可选数据，没装时行为与以前完全一致。
收藏已从「整文件 PUT」升级为按条 API（POST / DELETE），旧 PUT 仅作兼容保留；
订阅仍是简单的整存整取 JSON 文件。
"""
import contextlib
import hashlib
import json
import math
import os
import tempfile
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import AliasChoices, BaseModel, Field

try:  # Unix 下用 fcntl 做跨进程文件锁；Windows 退化为进程内线程锁。
    import fcntl
except ImportError:  # pragma: no cover - 项目只在 macOS/Linux 上跑
    fcntl = None

import ai_auth
import languages
import llm
import local_dict
import storage
from ai import quota
from config import DEFAULT_MODEL, MODEL_CATALOG, model_route_for, resolve_model

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
    """把来源不明的义项规整成契约形状；没有任何释义的条目丢弃。

    ``zh`` 是历史字段名，值是**当前目标语言**的释义（规格 §5.3）。
    ``pos_label`` / ``example_translation`` 是可选新增字段：只有模型返回了
    非空值才写进响应，避免给中文旧链路塞一堆空字段。
    """
    if not isinstance(raw, dict):
        return None
    sense = {
        "pos": _clean_field(raw.get("pos")),
        "zh": _clean_field(raw.get("zh")),
        "definition_en": _clean_field(raw.get("definition_en")),
    }
    if not sense["zh"] and not sense["definition_en"]:
        return None
    pos_label = _clean_field(raw.get("pos_label"))
    if pos_label:
        sense["pos_label"] = pos_label
    example_translation = _clean_field(raw.get("example_translation"))
    if example_translation:
        sense["example_translation"] = example_translation
    return sense


def _top_level_sense(entry: dict) -> dict:
    sense = {
        "pos": _clean_field(entry.get("pos")),
        "zh": _clean_field(entry.get("zh")),
        "definition_en": _clean_field(entry.get("definition_en")),
    }
    for field in ("pos_label", "example_translation"):
        value = _clean_field(entry.get(field))
        if value:
            sense[field] = value
    return sense


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
    # 可选新增字段（pos_label / example_translation）：同样「首条 = 顶层」，
    # 但只有真的存在才写，避免给旧中文链路塞空字段。
    for field in ("pos_label", "example_translation"):
        top = _clean_field(normalized.get(field))
        if top:
            first[field] = top
        elif _clean_field(first.get(field)):
            normalized[field] = first[field]
        else:
            normalized.pop(field, None)
            first.pop(field, None)

    normalized["senses"] = senses
    if not _clean_field(normalized.get("word")):
        normalized["word"] = fallback_word
    if not _clean_field(normalized.get("lemma")):
        normalized["lemma"] = normalized.get("word", "")
    for field in ("ipa", "example"):
        normalized[field] = _clean_field(normalized.get(field))
    for field in ("pos_label", "example_translation"):
        value = _clean_field(normalized.get(field))
        if value:
            normalized[field] = value
        else:
            normalized.pop(field, None)
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
    # M7a：自动候选只收有可核实单价的模型；显式选择走 _dict_models_for_request。
    return [m for m in deduped if llm.is_usable(m)]


def _dict_candidates_for_target(target_lang: str | None = None) -> list:
    """按目标语言排「已配 Key」的词典候选链。

    - zh-CN：完全沿用旧候选链（``_dict_model_candidates``），既有语义不变；
    - 其他语言：该语言首选 → 该语言路线（Gemini → Qwen → DeepSeek）→
      词典小模型 → 全局默认 → 目录其余；没配 Key 的自动跳过，所以只有
      DeepSeek Key 的用户仍能查越南语（降级到 DeepSeek）。
    """
    lang = languages.resolve_target_lang(target_lang)
    if lang == languages.DEFAULT_TARGET_LANG:
        return _dict_model_candidates()
    ordered = [llm.resolve_model_for_target(None, lang)]
    ordered += list(model_route_for(lang))
    ordered += [DICT_MODEL, DICT_FALLBACK_MODEL]
    ordered += list(MODEL_CATALOG)
    deduped = list(dict.fromkeys(ordered))
    return [m for m in deduped if llm.is_usable(m)]


def _dict_models_for_request(preferred: str | None, target_lang: str | None = None) -> list:
    """请求指定的模型（必须已确认存在于目录且已配 Key）排第一，其余沿用候选链并去重。

    请求模型不存在或未传时 `preferred` 为 None，此时直接用候选链（首位是
    该语言的推荐模型）；模型存在但没配 Key 时也会退回原候选链。两种情况
    都不该导致 502。
    """
    candidates = _dict_candidates_for_target(target_lang)
    if preferred and llm.is_available(preferred):
        return [preferred] + [m for m in candidates if m != preferred]
    return candidates


def _model_display_name(model_id: str) -> str:
    """模型 id → 目录里的展示名；目录里没有时原样返回，不编造。"""
    spec = MODEL_CATALOG.get(model_id)
    return spec["name"] if spec else model_id


def _target_lang_or_400(raw: str | None) -> str:
    """请求参数 → canonical 语言；缺省 zh-CN，非法 400。"""
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class DefineRequest(BaseModel):
    word: str
    context: str | None = None
    model: str | None = None
    # specs/012 §5.3/§5.6：camelCase 为主，snake_case 兼容脚本/旧客户端。
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


def _cache_entry_matches_lang(entry: dict, target_lang: str) -> bool:
    """缓存条目语言是否匹配：缺字段的旧中文缓存按 zh-CN 兼容（规格 §5.10）。"""
    entry_lang = languages.normalize_code(entry.get("target_lang")) or languages.DEFAULT_TARGET_LANG
    return entry_lang == target_lang


def _api_dict_entry(entry: dict, target_lang: str) -> dict:
    """缓存/内部条目 → HTTP 响应：去掉 snake_case 语言字段，加 camelCase targetLang。"""
    data = {key: value for key, value in entry.items() if key != "target_lang"}
    data["targetLang"] = target_lang
    return data


def _load_dict_cache(target_lang: str | None = None) -> dict:
    cache_file = storage.dictionary_cache_file(target_lang)
    if os.path.exists(cache_file):
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            pass
    return {}


@router.post("/api/define")
async def define_word(request: DefineRequest, http_request: Request):
    """查词（会触发 AI）：M7a 起仅登录用户可用；游客/匿名 403 login_required。

    缓存/本地词典命中时不调用模型、不扣费，但仍要求登录（统一 AI 入口策略，
    前端 M7b 也据此在打开词典前先弹登录）。
    """
    user = ai_auth.require_ai_user(http_request)
    user_id = str(user["id"])
    lang = _target_lang_or_400(request.target_lang)
    word = request.word.strip()
    if not word or len(word) > 100:
        raise HTTPException(status_code=400, detail="无效的查询词。")

    # 缓存键 = (target_lang, NFC(casefold(word)))：语言靠文件目录隔离，同词不同
    # 语言互不命中；同词换模型仍命中旧缓存（与现状一致，不重复付费）。
    cache = _load_dict_cache(lang)
    key = languages.normalize(word).casefold()
    cached = cache.get(key)
    if isinstance(cached, dict) and _cache_entry_matches_lang(cached, lang):
        # 旧版缓存没有 senses：读取时用顶层字段补一条，不报错、不返回空。
        # 缓存命中不声称「本次用了模型」：model / modelName 只在真正调用
        # 大模型生成的那次响应里出现，也不写进 dictionary_cache.json。
        return _api_dict_entry(_normalize_dict_entry(cached, fallback_word=word), lang)

    # 本地词典（ECDICT 英汉）**只服务 zh-CN**：越南语即使本机装了 ECDICT 也
    # 绝不返回中文静态释义（规格 §5.6），直接走大模型。
    # 本地命中不写 dictionary_cache.json —— 那里存的是「结合语境生成」的模型
    # 释义；把静态词典释义混进去，会让后续同词查询拿到错位的缓存。
    if languages.uses_local_dictionary(lang):
        local_entry = local_dict.lookup(word)
        if local_entry is not None:
            entry = _normalize_dict_entry(local_entry, fallback_word=word)
            # 本地词典没有调用任何模型：显式标来源，且不带 model / modelName，
            # 免得前端把静态释义误标成「由某个模型生成」。
            entry["source"] = "local"
            return _api_dict_entry(entry, lang)

    target_name = languages.prompt_name(lang)
    context_part = f'It appears in this sentence: "{request.context.strip()}"' if request.context else ""
    prompt = f"""You are an English–{target_name} dictionary for {target_name} learners of English.
Explain the English word or phrase "{word}". {context_part}
Return ONLY a JSON object with exactly these fields:
{{
  "word": "{word}",
  "lemma": "base/dictionary form",
  "ipa": "IPA pronunciation like /ˈwɜːrd/",
  "pos": "part of speech abbreviation of the FIRST sense (n. / v. / adj. / adv. / phrase ...)",
  "pos_label": "full part-of-speech name of the FIRST sense in {target_name} (e.g. noun / động từ)",
  "zh": "the FIRST sense explained in {target_name} (keep it under 20 words)",
  "definition_en": "concise English definition of the FIRST sense (one sentence)",
  "example": "one short, natural example sentence in English",
  "example_translation": "the example sentence translated into {target_name}",
  "senses": [
    {{"pos": "n.", "pos_label": "full part-of-speech name in {target_name}", "zh": "sense in {target_name}", "definition_en": "concise English definition (one sentence)", "example_translation": "optional example translation in {target_name}"}}
  ]
}}
Rules for "senses":
- 2-5 common senses ordered by how common they are; merge rare / long-tail senses instead of listing them all.
- Each sense is a distinct meaning; change "pos" when the part of speech changes.
- Every "zh" / "pos_label" / "example_translation" value MUST be in {target_name}; "definition_en" and "example" stay in English.
- The first item MUST match the top-level "pos" / "pos_label" / "zh" / "definition_en" exactly.
- A word with only one common meaning may have a single item.
- If a context sentence is given, put the meaning used in that sentence first."""

    result = None
    used_model = None
    # 只有确实存在于目录里的模型才参与优先排序；不存在的模型交给
    # `_dict_models_for_request()` 原候选链兜底，而不是挤掉候选链首位。
    preferred = request.model if request.model in MODEL_CATALOG else None

    # AI 硬闸：词典是每用户 200 次/日的第三层配额之一；超限 429（前端提示
    # 「今天的 AI 额度用完了」）。预算超限（BudgetExceeded 是其子类）同走这里。
    # 目标语言只进账本维度，不拆限额；配额异常由 main.py 统一映射成
    # code=quota_exceeded/budget_exceeded（M7a 稳定错误码）。
    # 账本归属必须是真实登录用户（M7a：游客在没有 user 时已在上方 403）。
    quota.check_and_consume_quota(user_id, "define", target_lang=lang)

    for model_id in _dict_models_for_request(preferred, lang):
        try:
            # 模型 SDK 是同步阻塞调用；并发闸 + 线程封装在 llm.generate_json_async 内。
            with llm.usage_scope("define", user_id, target_lang=lang):
                parsed = json.loads(
                    await llm.generate_json_async(prompt, model=model_id)
                )
            if isinstance(parsed, list):
                parsed = parsed[0] if parsed else {}
            if not isinstance(parsed, dict):
                raise ValueError(f"模型返回的不是 JSON 对象（{type(parsed).__name__}）")
            parsed.setdefault("word", word)
            # 模型漏返 senses 时，_normalize_dict_entry 会用顶层字段补一条。
            result = _normalize_dict_entry(parsed, fallback_word=word)
            result["target_lang"] = lang
            used_model = model_id
            break
        except Exception as e:
            quota.rethrow_billing_error(e)  # 402 不能被当成查词失败
            print(f"Dictionary lookup failed for '{word}' with {model_id}: {e}")

    if result is None:
        raise HTTPException(status_code=502, detail="查词失败，请稍后重试。")

    cache[key] = result
    try:
        with open(storage.dictionary_cache_file(lang), "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"Failed to persist dictionary cache: {e}")
    # 透明度：在既有字段之外补上这次**实际成功使用**的模型（可能是候选链
    # 降级后的那个）。这两个字段只进响应、不写缓存，既有前端字段不受影响。
    return {
        **_api_dict_entry(result, lang),
        "model": used_model,
        "modelName": _model_display_name(used_model),
    }


# --- Favorites persistence (per authenticated user; legacy fallback in storage) ---
#
# M1 ④：从「GET/PUT 整文件」升级为「按条 POST/DELETE；GET 保留；旧 PUT 兼容」。
# 存储仍是每个用户一个 JSON 数组文件（不改 Alembic/SQLite），但：
# - 所有写入都经过同一把「进程内线程锁 + fcntl 文件锁」串行化，读-改-写不会
#   互相覆盖；落盘用 tmp + os.replace 原子替换，读方永远看到完整文件。
# - 旧文件里没有 id 的收藏，读取时按内容指纹补一个稳定 id（不改文件）；拿到
#   GET 返回的 id 后可以直接 DELETE。
# - POST 幂等：先按 id、再按内容指纹去重；重复提交返回已存在的条目。
# - 删除写旁路墓碑文件 favorites_tombstones.json，`GET ?since=` 可做增量同步；
#   旧代码/回滚后的旧版本不会读墓碑文件，互不影响。

FAVORITES_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
MAX_TOMBSTONES = 5000
FAVORITE_TYPES = ("sentence", "vocabulary")
# 只有「像收藏」的旧记录才补 id / 参与幂等判断；其他 JSON 对象原样保留，
# 让把 favorites.json 当任意 JSON 用的旧测试/旧客户端不受影响。
_FAVORITE_MARKER_FIELDS = (
    "en_text", "text", "zh_text", "translation",
    "videoId", "video_id", "start", "time",
    "highlights", "context_en", "context_zh",
)
_FAVORITE_CONSUMED_FIELDS = {
    "id", "type", "kind", "text", "en_text", "translation", "zh_text",
    "videoId", "video_id", "time", "start", "added_at", "addedAt",
    "updated_at", "meta", "highlights", "context_en", "context_zh",
}
_FAVORITES_THREAD_LOCKS: dict[str, threading.Lock] = {}
_FAVORITES_LOCKS_GUARD = threading.Lock()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _first_text(record: dict, *keys: str) -> str:
    for key in keys:
        text = _clean_text(record.get(key))
        if text:
            return text
    return ""


def _coerce_ms(value, default: int) -> int:
    """宽松地把客户端时间戳转成毫秒整数；非法值用 default，不因脏数据 500。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return int(value)
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return default
        if math.isfinite(parsed):
            return int(parsed)
    return default


def _coerce_seconds(value) -> float:
    """收藏时间点（秒）：接受数字或数字字符串，非法值归 0。"""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return 0.0
        if math.isfinite(parsed):
            return parsed
    return 0.0


def _favorite_kind(record: dict) -> str:
    return _clean_text(record.get("type")) or _clean_text(record.get("kind"))


def _favorite_video_id(record: dict) -> str:
    return _clean_text(record.get("videoId")) or _clean_text(record.get("video_id"))


def _favorite_added_at(record: dict) -> int:
    value = record["added_at"] if "added_at" in record else record.get("addedAt")
    return _coerce_ms(value, 0)


def _looks_like_favorite(record) -> bool:
    """旧 JSON 里的记录是否像一条收藏（用于只给收藏补 id）。"""
    return isinstance(record, dict) and any(
        field in record for field in _FAVORITE_MARKER_FIELDS
    )


def _favorite_fingerprint(record: dict) -> str:
    """内容指纹：同一收藏在不同设备/旧文件里生成同一个稳定 id。"""
    payload = {
        "type": _favorite_kind(record) or "sentence",
        "videoId": _favorite_video_id(record),
        "start": round(_coerce_seconds(record["time"] if "time" in record else record.get("start")), 3),
        "en_text": _first_text(record, "en_text", "text"),
        "zh_text": _first_text(record, "zh_text", "translation"),
        "context_en": _clean_text(record.get("context_en")),
        "context_zh": _clean_text(record.get("context_zh")),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "fav-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _normalize_favorite_input(raw, *, require_text: bool) -> dict:
    """把按条 API / 旧 PUT 的任意条目规整成内部收藏结构。

    接受两套字段名：新 API 的 `type/kind`、`text`、`translation`、`time`、
    `meta`，以及旧前端的 `en_text` / `zh_text` / `start` / `added_at`。
    `meta` 里的字段展开到顶层，顶层同名字段优先。未知字段保留，避免丢数据。
    """
    if not isinstance(raw, dict):
        raise ValueError("收藏条目必须是 JSON 对象。")
    data = dict(raw)
    meta = data.pop("meta", None)
    if meta is not None:
        if not isinstance(meta, dict):
            raise ValueError("meta 必须是 JSON 对象。")
        merged = dict(meta)
        merged.update(data)  # 顶层字段优先
        data = merged

    kind = _favorite_kind(data) or "sentence"
    if kind not in FAVORITE_TYPES:
        raise ValueError("收藏类型必须是 sentence 或 vocabulary。")

    text = _first_text(data, "text", "en_text")
    if require_text and not text:
        raise ValueError("收藏缺少 text 字段。")
    translation = _first_text(data, "translation", "zh_text")
    video_id = _favorite_video_id(data)
    start = _coerce_seconds(data["time"] if "time" in data else data.get("start"))

    entered_id = _clean_text(data.get("id"))
    if len(entered_id) > 300:
        raise ValueError("收藏 id 过长。")
    favorite_id = entered_id or _favorite_fingerprint(data)

    added_at = _coerce_ms(
        data["added_at"] if "added_at" in data else data.get("addedAt"),
        _now_ms(),
    )

    item = {
        "id": favorite_id,
        "type": kind,
        "videoId": video_id,
        "start": start,
        "en_text": text,
        "zh_text": translation,
        "added_at": added_at,
    }
    # 可选字段：有就保留，避免把旧收藏的语境/高亮丢掉。
    highlights = data.get("highlights")
    if isinstance(highlights, list):
        item["highlights"] = highlights
    for key in ("context_en", "context_zh"):
        value = _clean_text(data.get(key))
        if value:
            item[key] = value
    # 未知字段原样保留（例如 targetLang 或以后新增的元数据）。
    for key, value in data.items():
        if key not in _FAVORITE_CONSUMED_FIELDS:
            item[key] = value
    return item


def _with_missing_ids(records: list) -> list:
    """给旧收藏补稳定 id；返回内存副本，不修改磁盘文件。"""
    result = []
    used: set[str] = set()
    for raw in records:
        if not isinstance(raw, dict):
            result.append(raw)
            continue
        item = dict(raw)
        if _looks_like_favorite(item):
            current = item.get("id")
            if not (isinstance(current, str) and current.strip()):
                base = _favorite_fingerprint(item)
                candidate = base
                suffix = 2
                while candidate in used:
                    candidate = f"{base}-{suffix}"
                    suffix += 1
                item["id"] = candidate
            current = item.get("id")
            if isinstance(current, str) and current:
                used.add(current)
        result.append(item)
    return result


def _favorite_sort_key(record):
    if not isinstance(record, dict):
        return (0.0, "")
    return (-float(_favorite_added_at(record)), str(record.get("id") or ""))


def _sort_favorites(records: list) -> list:
    """最新收藏在前；同一时间戳按 id 稳定排序。"""
    return sorted(records, key=_favorite_sort_key)


def _load_favorites_unlocked(path: str) -> list:
    """读取收藏数组；不存在的文件 = 空收藏，损坏/形状不对 = 500。"""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500, detail="收藏数据文件损坏，无法读取。"
        ) from exc
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail="收藏数据文件格式异常。")
    return data


def _atomic_write_json(path: str, data) -> None:
    """tmp + os.replace 原子写：读方要么看到旧文件，要么看到完整新文件。"""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".favorites-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


def _write_favorites_unlocked(path: str, records: list) -> None:
    _atomic_write_json(path, records)


@contextlib.contextmanager
def _favorites_file_lock(path: str):
    """同一收藏文件的读-改-写串行化：线程锁（同进程）+ fcntl（跨进程）。"""
    with _FAVORITES_LOCKS_GUARD:
        lock = _FAVORITES_THREAD_LOCKS.get(path)
        if lock is None:
            lock = threading.Lock()
            _FAVORITES_THREAD_LOCKS[path] = lock
    with lock:
        lock_path = f"{path}.lock"
        os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
        with open(lock_path, "a+", encoding="utf-8") as lock_file:
            if fcntl is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _load_tombstones_unlocked(path: str) -> dict[str, int]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: _coerce_ms(value, 0)
        for key, value in data.items()
        if isinstance(key, str) and key
    }


def _prune_tombstones(tombstones: dict[str, int], now: int) -> dict[str, int]:
    cutoff = now - FAVORITES_TOMBSTONE_TTL_MS
    kept = {key: value for key, value in tombstones.items() if value >= cutoff}
    if len(kept) > MAX_TOMBSTONES:
        newest = sorted(kept.items(), key=lambda item: item[1], reverse=True)
        kept = dict(newest[:MAX_TOMBSTONES])
    return kept


def _write_tombstones_unlocked(path: str, tombstones: dict[str, int]) -> None:
    """墓碑是旁路同步数据：写失败只告警，不让收藏主数据写入失败。"""
    tombstones = _prune_tombstones(tombstones, _now_ms())
    try:
        if tombstones:
            _atomic_write_json(path, tombstones)
        else:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(path)
    except OSError as exc:
        print(f"Failed to persist favorites tombstones: {exc}")


def _clear_tombstone_unlocked(favorite_id: str) -> None:
    path = storage.favorites_tombstones_file()
    tombstones = _load_tombstones_unlocked(path)
    if favorite_id in tombstones:
        tombstones.pop(favorite_id, None)
        _write_tombstones_unlocked(path, tombstones)


def _find_duplicate_favorite(
    records: list, incoming: dict, incoming_fingerprint: str
) -> dict | None:
    """按 id → 内容指纹去重；返回已存在的条目（没有则 None）。"""
    for item in records:
        if isinstance(item, dict) and item.get("id") == incoming["id"]:
            return item
    for item in records:
        if not _looks_like_favorite(item):
            continue
        if _favorite_fingerprint(item) == incoming_fingerprint:
            return item
    return None


def _normalize_snapshot_items(raw_items: list) -> list:
    """旧 PUT 的整份快照：收藏条目走同一套规整，其他 JSON 对象原样保留。"""
    normalized = []
    for raw in raw_items:
        if not _looks_like_favorite(raw):
            normalized.append(raw)
            continue
        try:
            item = _normalize_favorite_input(raw, require_text=False)
        except ValueError:
            # 旧文件里的异常记录不阻断整份快照写入；原样保留（读取时补 id）。
            normalized.append(raw)
            continue
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(normalized)
                if isinstance(existing, dict) and existing.get("id") == item["id"]
            ),
            None,
        )
        if duplicate_index is None:
            normalized.append(item)
        else:
            normalized[duplicate_index] = item
    return normalized


def _favorite_ids(records: list) -> set[str]:
    return {
        item["id"]
        for item in records
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"]
    }


@router.get("/api/favorites")
def get_favorites(since: int | None = None):
    """收藏列表（最新在前）。

    不带 `since` 时返回数组，保持旧前端契约；带 `since`（毫秒时间戳）时返回
    `{favorites, deleted, since, serverTime}` 供增量同步，`deleted` 是墓碑。
    """
    favorites = _sort_favorites(
        _with_missing_ids(_load_favorites_unlocked(storage.favorites_file()))
    )
    if since is None:
        return favorites

    now = _now_ms()
    tombstones = _prune_tombstones(
        _load_tombstones_unlocked(storage.favorites_tombstones_file()), now
    )
    deleted = [
        {"id": favorite_id, "deleted_at": deleted_at}
        for favorite_id, deleted_at in tombstones.items()
        if deleted_at >= since
    ]
    deleted.sort(key=lambda entry: (-entry["deleted_at"], entry["id"]))
    return {
        "favorites": [
            item
            for item in favorites
            if isinstance(item, dict) and _favorite_added_at(item) >= since
        ],
        "deleted": deleted,
        "since": since,
        "serverTime": now,
    }


@router.post("/api/favorites")
def add_favorite(request: dict, response: Response):
    """新增一条收藏；按 id 或内容指纹幂等（重复提交返回已有条目）。"""
    try:
        incoming = _normalize_favorite_input(request, require_text=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    path = storage.favorites_file()
    fingerprint = _favorite_fingerprint(incoming)
    with _favorites_file_lock(path):
        records = _with_missing_ids(_load_favorites_unlocked(path))
        existing = _find_duplicate_favorite(records, incoming, fingerprint)
        if existing is not None:
            _clear_tombstone_unlocked(str(existing.get("id") or incoming["id"]))
            response.status_code = 200
            return {"status": "ok", "created": False, "favorite": existing}
        records.append(incoming)
        _write_favorites_unlocked(path, records)
        _clear_tombstone_unlocked(incoming["id"])
    response.status_code = 201
    return {"status": "ok", "created": True, "favorite": incoming}


@router.delete("/api/favorites/{favorite_id:path}")
def delete_favorite(favorite_id: str):
    """按 id 删除一条收藏；不存在时 404。"""
    favorite_id = favorite_id.strip()
    if not favorite_id:
        raise HTTPException(status_code=404, detail="收藏不存在。")

    path = storage.favorites_file()
    with _favorites_file_lock(path):
        records = _with_missing_ids(_load_favorites_unlocked(path))
        remaining = [
            item
            for item in records
            if not (isinstance(item, dict) and item.get("id") == favorite_id)
        ]
        if len(remaining) == len(records):
            raise HTTPException(status_code=404, detail="收藏不存在。")
        _write_favorites_unlocked(path, remaining)
        tombstones = _load_tombstones_unlocked(storage.favorites_tombstones_file())
        tombstones[favorite_id] = _now_ms()
        _write_tombstones_unlocked(storage.favorites_tombstones_file(), tombstones)
    return {"status": "ok", "deleted": True, "id": favorite_id}


@router.put("/api/favorites")
def save_favorites(request: dict):
    """旧整文件 PUT（兼容保留）：整份快照语义，内部走同一套归并/原子写。

    旧前端仍可整份提交；不在快照里的已有收藏会记墓碑。新前端默认不再使用
    这个端点（改用 POST/DELETE 按条更新）。
    """
    favorites = request.get("favorites")
    if not isinstance(favorites, list):
        raise HTTPException(status_code=400, detail="favorites 必须是数组。")

    path = storage.favorites_file()
    with _favorites_file_lock(path):
        old_records = _with_missing_ids(_load_favorites_unlocked(path))
        new_records = _normalize_snapshot_items(favorites)
        _write_favorites_unlocked(path, new_records)

        old_ids = _favorite_ids(old_records)
        new_ids = _favorite_ids(new_records)
        tombstones = _load_tombstones_unlocked(storage.favorites_tombstones_file())
        now = _now_ms()
        for removed_id in old_ids - new_ids:
            tombstones[removed_id] = now
        for kept_id in new_ids:
            tombstones.pop(kept_id, None)
        _write_tombstones_unlocked(storage.favorites_tombstones_file(), tombstones)
    return {"status": "ok", "count": len(new_records)}


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
