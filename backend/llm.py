"""统一的大模型调用层：Gemini（google-genai）与 OpenAI 兼容端点（DeepSeek 等）。

调用方只关心「给我一段 JSON」或「给我一段文本」，不关心背后是哪一家：

    - `generate_json(prompt, model)`  要求模型回 JSON（解析交给调用方）
    - `generate_text(prompt, model)`  纯文本

模型的 provider / 端点 / Key 环境变量都写在 `config.MODEL_CATALOG` 里：
`kind = "google"` 走官方 SDK；`kind = "openai_compatible"` 走
`<base_url>/chat/completions`（DeepSeek、OpenAI、Qwen、Kimi、GLM、Ollama
等都兼容这套协议）。

AI 成本账本（M1）：
- 每次真实调用成功后读 provider 返回的 usage（``usage_metadata`` / ``usage``），
  在调用方用 :func:`usage_scope` 声明的功能与用户上下文里写一条 ``ai_usage``；
- **接口签名不变**：`usage_scope` 是额外的上下文管理器，不包也不会报错，只是
  这次调用不进账本；
- 全局开关 ``AI_USAGE_LOGGING=0``（或 ``config.AI_USAGE_LOGGING=False``）可关；
- 记账失败只记日志，绝不影响模型返回。
"""
import contextlib
import contextvars
import logging
import os

import httpx

import config
import languages
from ai import ledger
from config import DEFAULT_MODEL, MODEL_CATALOG

logger = logging.getLogger(__name__)

# 当前调用属于哪个 AI 功能/用户/目标语言；由调用方通过 ``usage_scope`` 设置。
# 放 ContextVar 是为了不改 generate/generate_json/generate_text 的签名
# （现有调用方与测试桩都不受影响），同时能穿过 ``asyncio.to_thread``。
_USAGE_CONTEXT: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "ln_llm_usage", default=None
)

# 「Key 已配但端点没配」的警告只打一次，避免每个请求刷屏。
_WARNED_UNAVAILABLE: set[str] = set()


class ModelUnavailable(RuntimeError):
    """该模型的 Key 没配置（或在配置里写错了）。"""


@contextlib.contextmanager
def usage_scope(
    feature: str | None,
    user_id: str | None = None,
    *,
    target_lang: str | None = None,
):
    """声明本次模型调用归属的功能/用户/目标语言，供 AI 成本账本记录。

    用法::

        with llm.usage_scope("translate", user_id, target_lang="vi-VN"):
            text = llm.generate_json(prompt, model=model)

    ``user_id`` 省略时由账本回落到 ``storage.active_user_id()``（请求上下文）；
    ``feature`` 为空时本次调用不记账。``target_lang`` 只进账本维度，
    **不参与配额限额**（P0 不按语言拆日限额）。
    """
    scope: dict = {"feature": feature, "user_id": user_id}
    if target_lang is not None:
        scope["target_lang"] = languages.normalize_code(target_lang) or languages.DEFAULT_TARGET_LANG
    token = _USAGE_CONTEXT.set(scope)
    try:
        yield
    finally:
        _USAGE_CONTEXT.reset(token)


def current_usage_scope() -> dict | None:
    """当前 ``usage_scope``（调试/测试用；没有则为 None）。"""
    return _USAGE_CONTEXT.get()


def _estimate_tokens(text: str) -> int:
    """provider 没回 usage 时的保守估算：按 2 字符/token 高估，避免少记成本。"""
    return max(1, len(text) // 2) if text else 0


def _record_usage(model_key: str, spec: dict, usage: dict | None, prompt: str, text: str) -> None:
    """把一次成功调用的 usage 写进账本（失败只记日志）。"""
    if not getattr(config, "AI_USAGE_LOGGING", True):
        return
    scope = _USAGE_CONTEXT.get()
    if not scope or not scope.get("feature"):
        return

    input_tokens = int((usage or {}).get("input_tokens") or 0)
    output_tokens = int((usage or {}).get("output_tokens") or 0)
    estimated = False
    if input_tokens <= 0 and prompt:
        input_tokens = _estimate_tokens(prompt)
        estimated = True
    if output_tokens <= 0 and text:
        output_tokens = _estimate_tokens(text)
        estimated = True
    if estimated:
        logger.debug("provider 未返回完整 usage，按字符数保守估算 tokens 后记账。")

    try:
        ledger.record_usage(
            scope.get("user_id"),
            scope["feature"],
            model_key,
            input_tokens,
            output_tokens,
            provider=spec.get("provider"),
            target_lang=scope.get("target_lang"),
        )
    except Exception:  # noqa: BLE001 - 记账失败绝不能影响本次生成
        logger.exception("AI usage 记账失败（已忽略，不影响模型返回）。")


def _spec(model: str | None) -> dict:
    """取模型配置；未知/缺省一律回落到默认模型，和 resolve_model 保持一致。"""
    if model and model in MODEL_CATALOG:
        return MODEL_CATALOG[model]
    return MODEL_CATALOG[DEFAULT_MODEL]


def api_key_for(spec: dict) -> str:
    return os.environ.get(spec.get("api_key_env", ""), "").strip()


def base_url_for(spec: dict) -> str:
    """模型端点：``base_url`` 优先，其次读 ``base_url_env`` 指向的环境变量。

    Qwen 等厂商国际站/大陆站端点不同，端点由部署环境提供，**不在调用点写死**。
    """
    base = str(spec.get("base_url") or "").strip()
    if base:
        return base
    env_name = str(spec.get("base_url_env") or "").strip()
    if env_name:
        return os.environ.get(env_name, "").strip()
    return ""


def is_available(model: str | None) -> bool:
    """模型是否可用——前端用它把「不可选」的模型置灰。

    - 必须配置了 Key；
    - ``openai_compatible`` 还必须有端点（``base_url`` 或 ``base_url_env``
      对应的环境变量），否则「只配了 Key 选中一个没有端点的模型」必失败。
    """
    spec = _spec(model)
    if not api_key_for(spec):
        return False
    if spec.get("kind") == "openai_compatible" and not base_url_for(spec):
        model_key = model if model in MODEL_CATALOG else DEFAULT_MODEL
        if model_key not in _WARNED_UNAVAILABLE:
            _WARNED_UNAVAILABLE.add(model_key)
            logger.warning(
                "%s 已配置 Key 但缺少端点（%s），视为不可用并在模型路线中跳过。",
                spec.get("name", model_key),
                spec.get("base_url_env", "base_url"),
            )
        return False
    return True


def recommended_models_for_target(target_lang: str | None = None) -> list[str]:
    """某目标语言路线中「Key/端点已配置」的模型 id 序列（保持路线顺序）。"""
    return [mid for mid in config.model_route_for(target_lang) if is_available(mid)]


def resolve_model_for_target(
    requested: str | None, target_lang: str | None = None
) -> str:
    """按目标语言解析要用的模型（specs/012 §5.5）。

    1. ``requested`` 在目录里且可用 → 用它（用户显式选择优先）；
    2. 该语言首选（``DEFAULT_MODEL_<LANG>``）可用 → 用它；
    3. 该语言路线里第一个可用模型；
    4. ``DEFAULT_MODEL``（全局兜底）可用 → 用它；
    5. 目录里第一个可用模型；
    6. 全不可用 → 返回 ``DEFAULT_MODEL``，让调用层抛出清晰的「未配置 Key」错误，
       **不假装成功**。
    """
    if requested and requested in MODEL_CATALOG and is_available(requested):
        return requested

    lang = languages.normalize_code(target_lang) or languages.DEFAULT_TARGET_LANG
    lang_default = config.default_model_for_target(lang)
    if lang_default in MODEL_CATALOG and is_available(lang_default):
        return lang_default

    for model_id in config.model_route_for(lang):
        if is_available(model_id):
            return model_id

    if is_available(config.DEFAULT_MODEL):
        return config.DEFAULT_MODEL

    for model_id in MODEL_CATALOG:
        if is_available(model_id):
            return model_id

    return config.DEFAULT_MODEL


def batch_pause(model: str | None) -> float:
    """批间停顿秒数：Gemini 免费档按 15 RPM 限流，别家快很多。"""
    return float(_spec(model).get("batch_pause", 4))


def _generate_google(prompt: str, spec: dict, json_mode: bool) -> tuple[str, dict]:
    from google import genai
    from google.genai import types

    client = genai.Client()
    config_ = types.GenerateContentConfig(response_mime_type="application/json") if json_mode else None
    response = client.models.generate_content(
        model=spec["model_id"], contents=prompt, config=config_
    )
    return response.text or "", ledger.usage_from_google_response(response)


def _generate_openai_compatible(prompt: str, spec: dict, json_mode: bool) -> tuple[str, dict]:
    key = api_key_for(spec)
    if not key:
        raise ModelUnavailable(f"{spec.get('name', spec['model_id'])} 未配置 {spec.get('api_key_env')}")

    base_url = base_url_for(spec)
    if not base_url:
        raise ModelUnavailable(
            f"{spec.get('name', spec['model_id'])} 未配置端点"
            f"（{spec.get('base_url_env', 'base_url')}）"
        )

    payload = {
        "model": spec["model_id"],
        "messages": [{"role": "user", "content": prompt}],
        "temperature": spec.get("temperature", 0.2),
        "stream": False,
    }
    if json_mode:
        # DeepSeek/OpenAI 都支持；prompt 里必须出现 "json" 字样（现有 prompt 已满足）。
        payload["response_format"] = {"type": "json_object"}

    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=spec.get("timeout", 180)) as client:
        response = client.post(url, json=payload, headers=headers)
        if response.status_code >= 400:
            # 把厂商报错压成一行，别让 401/429 的长 JSON 糊满日志。
            raise RuntimeError(
                f"{spec.get('name', spec['model_id'])} HTTP {response.status_code}: "
                f"{response.text[:300]}"
            )
        data = response.json()

    try:
        text = data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"无法解析 {spec.get('name')} 的响应: {e}")
    return text, ledger.usage_from_openai_response(data)


def generate(prompt: str, model: str | None = None, *, json_mode: bool = False) -> str:
    """按模型的 kind 分派；调用失败直接抛异常，由上层决定降级策略。"""
    spec = _spec(model)
    kind = spec.get("kind", "google")
    if kind == "google":
        text, usage = _generate_google(prompt, spec, json_mode)
    elif kind == "openai_compatible":
        text, usage = _generate_openai_compatible(prompt, spec, json_mode)
    else:
        raise ModelUnavailable(f"未知的 provider kind: {kind}")

    # 账本用目录 id 定价（model_key）；真实厂商模型名在 spec["model_id"]。
    model_key = model if model in MODEL_CATALOG else DEFAULT_MODEL
    _record_usage(model_key, spec, usage, prompt, text)
    return text


def generate_json(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=True)


def generate_text(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=False)
