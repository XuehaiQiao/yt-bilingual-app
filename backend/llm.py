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
import asyncio
import contextlib
import contextvars
import json
import logging
import os
import time

import httpx

import alerts
import billing
import config
import languages
import observability
import storage
from ai import ledger
from config import DEFAULT_MODEL, MODEL_CATALOG

logger = logging.getLogger(__name__)
# 结构化可观测日志（JSON 行由 observability.JsonFormatter 统一格式化）。
_gate_logger = logging.getLogger("linguatrek.llm")

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

    ``user_id`` 省略时由账本回落到 ``storage.active_identity()``（请求上下文：
    登录用户 id 或游客 ``guest:<sha256>``）；
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


def _estimate_usage(usage: dict | None, prompt: str, text: str) -> tuple[int, int, str]:
    """provider usage → ``(input_tokens, output_tokens, token_source)``。

    provider 没回 usage 时按「2 字符/token」保守估算并如实标记：``provider``
    （全部来自 provider）/``mixed``（缺一部分）/``estimated``（全部估算）/
    ``unknown``（连内容都没有）。
    """
    input_tokens = int((usage or {}).get("input_tokens") or 0)
    output_tokens = int((usage or {}).get("output_tokens") or 0)
    estimated_in = False
    estimated_out = False
    if input_tokens <= 0 and prompt:
        input_tokens = _estimate_tokens(prompt)
        estimated_in = True
    if output_tokens <= 0 and text:
        output_tokens = _estimate_tokens(text)
        estimated_out = True
    if estimated_in or estimated_out:
        logger.debug(
            "provider 未返回完整 usage，按字符数保守估算 tokens（in=%s out=%s）。",
            estimated_in,
            estimated_out,
        )
    if estimated_in and estimated_out:
        return input_tokens, output_tokens, "estimated"
    if estimated_in or estimated_out:
        return input_tokens, output_tokens, "mixed"
    if input_tokens or output_tokens:
        return input_tokens, output_tokens, "provider"
    return input_tokens, output_tokens, "unknown"


def _billing_user(scope: dict | None) -> str | None:
    """计费归属的真实账号 id；游客``guest:<sha256>``/匿名返回 None（不计费）。"""
    candidate = (scope or {}).get("user_id")
    if candidate is None:
        candidate = storage.active_identity()
    if not isinstance(candidate, str) or not candidate:
        return None
    if candidate.startswith("guest:"):
        return None
    return candidate


def _billing_chain(feature: str, model_key: str) -> list[str]:
    """候选降级链（预占按链上最高价，防切到更贵模型时超支）。"""
    try:
        from ai import quota  # 延迟导入：quota 依赖 llm（避免模块级环）

        chain = quota.degradation_chain(feature, preferred_model=model_key)
    except Exception:  # noqa: BLE001 - 链只影响预占大小，不能挡住模型调用
        return [model_key]
    if model_key not in chain:
        chain = [model_key, *chain]
    return chain


def _billing_begin(scope: dict | None, model_key: str, prompt: str) -> dict:
    """调用前预占余额（M3a；M7a 起默认严格）。

    返回状态字典供 :func:`_billing_finish` / :func:`_billing_abort` 使用。
    严格模式（``config.BILLING_STRICT``，默认开）：

    - 没有登录 user（游客/匿名但带了 feature scope）→ 403 ``login_required``；
    - 计费表未迁移 → 503 ``billing_unavailable``；
    - 模型没有可核实单价 → 503 ``model_unpriced``（**绝不** billable=0 继续调）；
    - 余额不足 → 402（路由/全局处理器映射）。

    非严格模式只保留旧的降级行为（缺价/游客 billable=0），作为迁移前旧部署的
    临时回滚逃生门，生产不得关闭。
    """
    state: dict = {
        "enabled": False,
        "user": None,
        "hold": None,
        "price": None,
        "request_id": None,
        "schema": True,
        "degraded": False,
        "strict": billing.strict_mode(),
        "feature": None,
        "target_lang": None,
    }
    if not getattr(config, "AI_USAGE_LOGGING", True):
        return state
    if not scope or not scope.get("feature"):
        # 脚本/旧调用没有声明 scope：不记账（不是用户请求，路由鉴权已另行负责）。
        return state
    strict = state["strict"]
    state["feature"] = scope["feature"]
    state["target_lang"] = scope.get("target_lang")
    user = _billing_user(scope)
    if not user:
        if strict:
            # 游客/匿名不允许调用 AI：403 而不是 401（见 ai_auth.py 说明）。
            raise billing.LoginRequired()
        # 非严格（回滚）：游客/匿名只记账不扣费（旧行为）。
        state["enabled"] = True
        return state
    state["user"] = user
    state["request_id"] = observability.current_request_id()
    try:
        if not billing.schema_ready():
            if strict:
                raise billing.BillingUnavailable(
                    "计费表未就绪（未运行 `alembic upgrade head` / 0025），"
                    "严格计费已拒绝本次 AI 调用。"
                )
            state["schema"] = False
            return state
        state["enabled"] = True
        price = billing.price_for_model(model_key)
        state["price"] = price
        if price is None:
            if strict:
                raise billing.ModelUnpriced(model_key)
            # 非严格（回滚）：缺价模型 billable=0，不预占、不扣余额。
            logger.warning(
                "模型 %s 没有可核实单价：本次调用不扣余额（billable=0）；"
                "请在 model_prices 补价。",
                model_key,
            )
            return state
        estimate = billing.estimate_reserve(
            state["feature"], len(prompt or ""), _billing_chain(state["feature"], model_key)
        )
        state["estimate"] = estimate
        if estimate["amountMicroUsd"] > 0:
            state["hold"] = billing.reserve(
                user,
                estimate["amountMicroUsd"],
                feature=state["feature"],
                request_id=state["request_id"],
            )
            if estimate.get("capped"):
                logger.warning(
                    "单次预占达到上限 $0.50（%s）：实际用量可能超过预占，"
                    "结算允许 overrun。",
                    state["feature"],
                )
        return state
    except billing.BalanceNotFound as exc:
        # 用户行/余额行不存在（脚本/测试/已删除账号）：生产登录用户不该出现。
        if strict:
            raise billing.BillingUnavailable(
                "账户余额记录不存在，暂时无法进行计费调用；请联系管理员。"
            ) from exc
        state["degraded"] = True
        return state
    except billing.BillingError:
        # 402 / 403 / 503 必须让用户看到，不能降级成 mock 或免费调用。
        raise
    except Exception:  # noqa: BLE001 - 账务故障不能把 AI 功能打死（仅非严格）
        if strict:
            raise billing.BillingUnavailable(
                "计费预占失败，严格计费已拒绝本次 AI 调用。"
            )
        logger.exception("预占余额失败（按未计费继续，已记录 hold 状态）：user=%r", user)
        state["degraded"] = True
        return state


def _billing_abort(state: dict, *, reason: str) -> None:
    """调用失败：释放预占（不扣余额）。释放失败只告警，hold 会在 TTL 后过期。"""
    hold = state.get("hold")
    if not hold or not hold.get("id"):
        return
    try:
        billing.release(hold["id"], reason=reason)
    except Exception:  # noqa: BLE001
        logger.exception(
            "释放预占失败（hold 会在 %s 秒后过期）：hold=%r",
            int(getattr(config, "BILLING_HOLD_TTL_SECONDS", 1800)),
            hold.get("id"),
        )


def _billing_finish(
    state: dict,
    model_key: str,
    spec: dict,
    usage: dict | None,
    prompt: str,
    text: str,
) -> None:
    """调用成功：按真实用量结算（或按未计费落账）；失败只告警不影响返回。"""
    if not state.get("enabled"):
        return
    feature = state.get("feature")
    if not feature:
        return
    input_tokens, output_tokens, token_source = _estimate_usage(usage, prompt, text)
    user = state.get("user")
    hold = state.get("hold")
    price = state.get("price")

    if user and hold and price:
        actual = billing.token_cost_micro_usd(input_tokens, output_tokens, price)
        payload = {
            "feature": feature,
            "model_id": model_key,
            "provider": spec.get("provider"),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "calls": 1,
            "occurred_at": ledger.now_ms(),
            "target_lang": state.get("target_lang"),
            "token_source": token_source,
            "request_id": state.get("request_id"),
        }
        try:
            billing.settle(hold["id"], actual, usage=payload)
            return
        except Exception as exc:  # noqa: BLE001 - 结算失败保留 hold + 告警，不能丢扣费
            logger.exception(
                "AI 计费结算失败（保留 hold 待重试，账本按 settle_failed 落一条）："
                "hold=%r user=%r actual_micro_usd=%s",
                hold.get("id"),
                user,
                actual,
            )
            # 飞书 P0（M5）：结算写库失败是数据/资金风险，立即告警；告警本身
            # 不抛异常，也不改变「保留 hold + 兜底落 settle_failed」的处理。
            try:
                alerts.notify_billing_settle_failed(
                    hold_id=str(hold.get("id") or ""),
                    user_id=user if isinstance(user, str) else str(user or ""),
                    actual_micro_usd=actual,
                    error_type=type(exc).__name__,
                )
            except Exception:  # noqa: BLE001
                logger.warning("发送结算失败告警失败（已忽略）。")
            try:
                ledger.record_usage(
                    user,
                    feature,
                    model_key,
                    input_tokens,
                    output_tokens,
                    provider=spec.get("provider"),
                    target_lang=state.get("target_lang"),
                    cost_micro_usd=actual,
                    input_price_micro_usd_per_mtok=price[
                        "inputMicroUsdPerMtok"
                    ],
                    output_price_micro_usd_per_mtok=price[
                        "outputMicroUsdPerMtok"
                    ],
                    price_version=price["priceVersion"],
                    price_source="settle_failed",
                    token_source=token_source,
                    billable=1,
                    billing_status="settle_failed",
                    hold_id=hold.get("id"),
                    request_id=state.get("request_id"),
                )
            except Exception:  # noqa: BLE001
                logger.exception("结算失败后的兜底用量写入也失败（hold 仍在）。")
            return

    # 未计费路径（缺价 / 游客 / 匿名 / 降级）：照常记用量，明确标 billable=0。
    if not state.get("schema"):
        # 未迁移 0025：保持旧口径（只写基础列），不假装计费字段存在。
        ledger.record_usage(
            user,
            feature,
            model_key,
            input_tokens,
            output_tokens,
            provider=spec.get("provider"),
            target_lang=state.get("target_lang"),
        )
        return

    price_source = "ceiling_unknown"
    extra: dict = {}
    if price is not None:
        price_source = "billing_unavailable" if state.get("degraded") else "unbilled"
        extra = {
            "input_price_micro_usd_per_mtok": price["inputMicroUsdPerMtok"],
            "output_price_micro_usd_per_mtok": price["outputMicroUsdPerMtok"],
            "price_version": price["priceVersion"],
        }
    elif user is None:
        price_source = "no_account"
    ledger.record_usage(
        user,
        feature,
        model_key,
        input_tokens,
        output_tokens,
        provider=spec.get("provider"),
        target_lang=state.get("target_lang"),
        price_source=price_source,
        token_source=token_source,
        billable=0,
        billing_status="unbilled",
        request_id=state.get("request_id"),
        **extra,
    )


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


def is_usable(model: str | None) -> bool:
    """**严格计费下**可参与自动选路/降级链的模型。

    = Key/端点可用 + 有可核实单价（``model_prices``/目录价）。没有单价的模型
    只能在用户显式选择时由 ``_billing_begin`` 拒绝（503 ``model_unpriced``），
    不允许悄悄进入自动候选链变成「免费调用」。
    """
    if not is_available(model):
        return False
    if not billing.strict_mode():
        return True
    model_key = model if model in MODEL_CATALOG else DEFAULT_MODEL
    return billing.is_priced(model_key)


def recommended_models_for_target(target_lang: str | None = None) -> list[str]:
    """某目标语言路线中「Key/端点已配置且（严格计费下）有价」的模型 id 序列。"""
    return [mid for mid in config.model_route_for(target_lang) if is_usable(mid)]


def resolve_model_for_target(
    requested: str | None, target_lang: str | None = None
) -> str:
    """按目标语言解析要用的模型（specs/012 §5.5）。

    1. ``requested`` 在目录里且可用 → 用它（用户显式选择优先；显式选了缺价
       模型时由计费层 503 ``model_unpriced``，不静默换成别的模型）；
    2. 该语言首选（``DEFAULT_MODEL_<LANG>``）可用且有价 → 用它；
    3. 该语言路线里第一个可用且有价的模型；
    4. ``DEFAULT_MODEL``（全局兜底）可用且有价 → 用它；
    5. 目录里第一个可用且有价的模型；
    6. 全不可用 → 返回 ``DEFAULT_MODEL``，让调用层抛出清晰的「未配置 Key/缺价」错误，
       **不假装成功**。
    """
    if requested and requested in MODEL_CATALOG and is_available(requested):
        return requested

    lang = languages.normalize_code(target_lang) or languages.DEFAULT_TARGET_LANG
    lang_default = config.default_model_for_target(lang)
    if lang_default in MODEL_CATALOG and is_usable(lang_default):
        return lang_default

    for model_id in config.model_route_for(lang):
        if is_usable(model_id):
            return model_id

    if is_usable(config.DEFAULT_MODEL):
        return config.DEFAULT_MODEL

    for model_id in MODEL_CATALOG:
        if is_usable(model_id):
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
    if spec.get("thinking_disabled"):
        # P2-31：只有目录项显式标记 `thinking_disabled` 的模型才发这个字段
        # （目前仅 Qwen）。DeepSeek 等 provider 不发未验证的未知参数——有的
        # 端点会直接 400，不能拿主链路去试。
        payload["thinking"] = {"type": "disabled"}

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
    """按模型的 kind 分派；调用失败直接抛异常，由上层决定降级策略。

    M3a/M7a：调用前预占余额、调用后按 provider usage 结算。严格模式（默认）下：

    - 没有登录 user → 403 ``login_required``；
    - 模型没有可核实单价 → 503 ``model_unpriced``（不调用 provider）；
    - 余额不足 → 402 ``insufficient_balance``。

    这些异常都**不会被降级链当成模型失败**。``BILLING_STRICT=0`` 仅作迁移前
    旧部署的回滚逃生门（缺价/游客 billable=0，只记用量）。
    """
    spec = _spec(model)
    kind = spec.get("kind", "google")
    # 账本用目录 id 定价（model_key）；真实厂商模型名在 spec["model_id"]。
    model_key = model if model in MODEL_CATALOG else DEFAULT_MODEL
    scope = _USAGE_CONTEXT.get()
    state = _billing_begin(scope, model_key, prompt)
    try:
        if kind == "google":
            text, usage = _generate_google(prompt, spec, json_mode)
        elif kind == "openai_compatible":
            text, usage = _generate_openai_compatible(prompt, spec, json_mode)
        else:
            raise ModelUnavailable(f"未知的 provider kind: {kind}")
    except BaseException as exc:
        _billing_abort(state, reason=f"provider_error:{type(exc).__name__}")
        # 飞书 P1（M5）：只统计真正的模型失败；余额不足/取消不算 provider 故障。
        if not isinstance(exc, (billing.InsufficientBalance, asyncio.CancelledError)):
            try:
                alerts.record_llm_outcome(False, model=model_key)
            except Exception:  # noqa: BLE001 - 告警计数绝不能影响调用
                pass
        raise

    _billing_finish(state, model_key, spec, usage, prompt, text)
    try:
        alerts.record_llm_outcome(True, model=model_key)
    except Exception:  # noqa: BLE001
        pass
    return text


def generate_json(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=True)


def generate_text(prompt: str, model: str | None = None) -> str:
    return generate(prompt, model, json_mode=False)


# ---------------------------------------------------------------------------
# 全局 LLM 并发闸（M1 安全最小集，计划书 §7.6）
# ---------------------------------------------------------------------------
#
# provider 调用是同步阻塞的（单次 8–40s），走 ``asyncio.to_thread``。没有闸门时，
# 一次涌进几十个长请求会把默认线程池和厂商限流同时打爆——既慢又容易被 429。
# 这里用一个进程级 ``asyncio.Semaphore``（``LLM_MAX_CONCURRENCY``，默认 4）把
# 「真正在跑的 provider 调用」限制住；排队的请求只占一个协程，不占线程。
#
# 调用方一律改用 :func:`generate_json_async` / :func:`generate_text_async`；
# 同步的 :func:`generate` 仍保留给脚本/测试（不受闸门影响）。
#
# 可观测：
# - 每次入闸/出闸更新 :func:`concurrency_snapshot`（active/peak/等待直方图）；
# - 等待超过 100ms 输出一行结构化 JSON 到 ``linguatrek.llm``：
#   ``{"event":"llm_concurrency_wait","wait_ms":…,"active":…,"limit":…}``。
#
# 取消语义：客户端断开导致协程被取消时，底层线程还在跑 provider 请求。此时
# **不立刻**释放信号量，而是等线程真正结束（``inner.add_done_callback``）再
# 释放，否则取消几次就能绕过并发上限。

_gate_semaphore: asyncio.Semaphore | None = None
_gate_loop: asyncio.AbstractEventLoop | None = None
_gate_limit = 0

_WAIT_LOG_THRESHOLD_MS = 100.0
_HISTOGRAM_BOUNDS_MS = (50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0)
_histogram_labels = tuple(
    [f"<={int(bound)}" for bound in _HISTOGRAM_BOUNDS_MS]
    + [f">{int(_HISTOGRAM_BOUNDS_MS[-1])}"]
)

_gate_stats: dict = {
    "active": 0,
    "peak": 0,
    "acquired": 0,
    "waited": 0,
    "wait_ms_total": 0.0,
    "wait_ms_max": 0.0,
    "wait_ms_histogram": {label: 0 for label in _histogram_labels},
}


def concurrency_limit() -> int:
    """当前并发上限（读 config，运行中可改；0 = 不限）。"""
    try:
        return max(0, int(getattr(config, "LLM_MAX_CONCURRENCY", 4) or 0))
    except (TypeError, ValueError):
        return 4


def _semaphore_for(limit: int) -> asyncio.Semaphore:
    """取当前事件循环的闸门；事件循环/上限变化时重建（测试与多 loop 安全）。"""
    global _gate_semaphore, _gate_loop, _gate_limit
    loop = asyncio.get_running_loop()
    if (
        _gate_semaphore is None
        or _gate_loop is not loop
        or _gate_limit != limit
    ):
        _gate_semaphore = asyncio.Semaphore(limit)
        _gate_loop = loop
        _gate_limit = limit
    return _gate_semaphore


def _histogram_bucket(wait_ms: float) -> str:
    for bound, label in zip(_HISTOGRAM_BOUNDS_MS, _histogram_labels[:-1]):
        if wait_ms <= bound:
            return label
    return _histogram_labels[-1]


def _record_acquire(wait_ms: float, limit: int) -> None:
    stats = _gate_stats
    stats["active"] += 1
    stats["peak"] = max(stats["peak"], stats["active"])
    stats["acquired"] += 1
    stats["wait_ms_total"] += wait_ms
    stats["wait_ms_max"] = max(stats["wait_ms_max"], wait_ms)
    stats["wait_ms_histogram"][_histogram_bucket(wait_ms)] += 1
    if wait_ms >= _WAIT_LOG_THRESHOLD_MS:
        stats["waited"] += 1
        _gate_logger.info(
            json.dumps(
                {
                    "event": "llm_concurrency_wait",
                    "wait_ms": round(wait_ms, 2),
                    "active": stats["active"],
                    "limit": limit,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )


def _record_release(semaphore: asyncio.Semaphore) -> None:
    semaphore.release()
    if _gate_stats["active"] > 0:
        _gate_stats["active"] -= 1


def concurrency_snapshot() -> dict:
    """并发闸快照（只读；调试/日报/测试用）。"""
    stats = _gate_stats
    return {
        "limit": concurrency_limit(),
        "active": stats["active"],
        "peak": stats["peak"],
        "acquired": stats["acquired"],
        "waited": stats["waited"],
        "wait_ms_total": round(stats["wait_ms_total"], 2),
        "wait_ms_max": round(stats["wait_ms_max"], 2),
        "wait_ms_histogram": dict(stats["wait_ms_histogram"]),
    }


def reset_concurrency_gate() -> None:
    """清空闸门与统计（测试用；运行中调用会让正在排队的请求使用新闸门）。"""
    global _gate_semaphore, _gate_loop, _gate_limit
    _gate_semaphore = None
    _gate_loop = None
    _gate_limit = 0
    _gate_stats.update(
        {
            "active": 0,
            "peak": 0,
            "acquired": 0,
            "waited": 0,
            "wait_ms_total": 0.0,
            "wait_ms_max": 0.0,
            "wait_ms_histogram": {label: 0 for label in _histogram_labels},
        }
    )


async def _run_llm_in_thread(func, *args, **kwargs):
    """在 worker 线程跑同步 provider 调用，并把并发数限制在 ``LLM_MAX_CONCURRENCY``。"""
    limit = concurrency_limit()
    if limit <= 0:
        return await asyncio.to_thread(func, *args, **kwargs)

    semaphore = _semaphore_for(limit)
    started = time.perf_counter()
    await semaphore.acquire()
    wait_ms = (time.perf_counter() - started) * 1000
    _record_acquire(wait_ms, limit)

    # shield：外层取消时不取消线程任务；等线程结束再释放许可（见文件头说明）。
    inner = asyncio.ensure_future(asyncio.to_thread(func, *args, **kwargs))
    try:
        result = await asyncio.shield(inner)
    except asyncio.CancelledError:
        inner.add_done_callback(lambda _future: _record_release(semaphore))
        raise
    except BaseException:
        _record_release(semaphore)
        raise
    _record_release(semaphore)
    return result


async def generate_json_async(prompt: str, model: str | None = None) -> str:
    """``generate_json`` 的异步入口：受全局并发闸保护，在 worker 线程执行。"""
    return await _run_llm_in_thread(generate_json, prompt, model=model)


async def generate_text_async(prompt: str, model: str | None = None) -> str:
    """``generate_text`` 的异步入口：受全局并发闸保护，在 worker 线程执行。"""
    return await _run_llm_in_thread(generate_text, prompt, model=model)
