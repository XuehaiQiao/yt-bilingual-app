"""AI 入口统一鉴权（M7a）：所有会调用大模型的公开/游客入口都必须先登录。

产品策略（specs/036-ai-login-billing）：

- 游客/未登录：任何会触发 AI 的接口返回 **403** ``{detail, code:"login_required"}``。
  不用 401：前端把 401 当成「会话过期」直接登出，游客本就没有会话，正确的
  交互是弹登录框；
- 登录用户可以继续使用；每笔调用由 ``llm._billing_begin`` 绑定 user_id 并
  预占/结算余额（缺价模型 503 ``model_unpriced``）；
- **纯缓存/原文读取不在这里拦**：公开书章节 GET、历史缓存列表等不调用 AI 的
  路径保持公开；只有 ``POST`` 生成入口与「GET 会触发生成」的入口才调用本模块。

为什么单独一个模块：路由层只做一件事——在函数入口插一行
``ai_auth.require_ai_user(request)``，异常由 ``main.py`` 的 BillingError
处理器统一映射，避免每个路由各写一套 403 文案/形状。
"""
from __future__ import annotations

from fastapi import Request

import billing


def ai_user(request: Request) -> dict | None:
    """当前请求的登录用户；游客/匿名返回 None（不抛）。"""
    user = getattr(request.state, "user", None)
    if isinstance(user, dict) and user.get("id"):
        return user
    return None


def require_ai_user(request: Request, *, detail: str | None = None) -> dict:
    """AI 生成入口的登录闸：未登录/游客抛 ``billing.LoginRequired``（403）。

    返回登录 user 字典（含 ``id``/``email``/…），调用方用它给账本/配额归属，
    不要在后台线程/SSE 生成器里再依赖请求 ContextVar。``detail`` 可保留各
    功能自己的提示文案（错误码始终是 ``login_required``）。
    """
    user = ai_user(request)
    if user is None:
        raise billing.LoginRequired(detail)
    return user


def require_ai_user_id(request: Request, *, detail: str | None = None) -> str:
    """同上，只返回 user id（多数路由只需要 id）。"""
    return str(require_ai_user(request, detail=detail)["id"])


__all__ = ["ai_user", "require_ai_user", "require_ai_user_id"]
