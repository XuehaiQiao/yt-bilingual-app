"""统一的大模型调用层：Gemini（google-genai）与 OpenAI 兼容端点（DeepSeek 等）。

调用方只关心「给我一段 JSON」或「给我一段文本」，不关心背后是哪一家：

    - `generate_json(prompt, model)`  要求模型回 JSON（解析交给调用方）
    - `generate_text(prompt, model)`  纯文本

模型的 provider / 端点 / Key 环境变量都写在 `config.MODEL_CATALOG` 里：
`kind = "google"` 走官方 SDK；`kind = "openai_compatible"` 走
`<base_url>/chat/completions`（DeepSeek、OpenAI、Qwen、Kimi、GLM、Ollama
等都兼容这套协议）。
"""
import os

import httpx

from config import DEFAULT_MODEL, MODEL_CATALOG


class ModelUnavailable(RuntimeError):
    """该模型的 Key 没配置（或在配置里写错了）。"""


def _spec(model: str | None) -> dict:
    """取模型配置；未知/缺省一律回落到默认模型，和 resolve_model 保持一致。"""
    if model and model in MODEL_CATALOG:
        return MODEL_CATALOG[model]
    return MODEL_CATALOG[DEFAULT_MODEL]


def api_key_for(spec: dict) -> str:
    return os.environ.get(spec.get("api_key_env", ""), "").strip()


def is_available(model: str | None) -> bool:
    """Key 是否已配置——前端用它把「不可选」的模型置灰。"""
    return bool(api_key_for(_spec(model)))


def batch_pause(model: str | None) -> float:
    """批间停顿秒数：Gemini 免费档按 15 RPM 限流，别家快很多。"""
    return float(_spec(model).get("batch_pause", 4))


def _generate_google(prompt: str, spec: dict, json_mode: bool) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client()
    config = types.GenerateContentConfig(response_mime_type="application/json") if json_mode else None
    response = client.models.generate_content(
        model=spec["model_id"], contents=prompt, config=config
    )
    return response.text or ""


def _generate_openai_compatible(prompt: str, spec: dict, json_mode: bool) -> str:
    key = api_key_for(spec)
    if not key:
        raise ModelUnavailable(f"{spec.get('name', spec['model_id'])} 未配置 {spec.get('api_key_env')}")

    payload = {
        "model": spec["model_id"],
        "messages": [{"role": "user", "content": prompt}],
        "temperature": spec.get("temperature", 0.2),
        "stream": False,
    }
    if json_mode:
        # DeepSeek/OpenAI 都支持；prompt 里必须出现 "json" 字样（现有 prompt 已满足）。
        payload["response_format"] = {"type": "json_object"}

    url = spec["base_url"].rstrip("/") + "/chat/completions"
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
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"无法解析 {spec.get('name')} 的响应: {e}")


def generate(prompt: str, model: str | None = None, *, json_mode: bool = False) -> str:
    """按模型的 kind 分派；调用失败直接抛异常，由上层决定降级策略。"""
    spec = _spec(model)
    kind = spec.get("kind", "google")
    if kind == "google":
        return _generate_google(prompt, spec, json_mode)
    if kind == "openai_compatible":
        return _generate_openai_compatible(prompt, spec, json_mode)
    raise ModelUnavailable(f"未知的 provider kind: {kind}")


def generate_json(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=True)


def generate_text(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=False)
