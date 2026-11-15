"""用户页账号接口：改用户名 + 用户页摘要（V1 用户需求 1/2 / specs/023）。

两个端点都需要登录；游客/未登录统一 **403**（与复习/理解题/读文章/考试练习
一致：用户资料必须归属账号，游客 Cookie 换设备即丢）。

- ``PATCH /api/user/profile`` body ``{"username": "..."}``：
  校验 2–24 字符（中文/英文/数字/下划线/连字符，首尾不能空白）→ 更新
  ``users.username`` → ``{"user":{"id","email","username","credits","status"}}``。
  不要求全局唯一（显示名）；不改 email / 密码 / 余额 / 状态。
- ``GET /api/user/summary``：
  ``{"user":{id,email,username,credits,memberSince,status},
  "monthSpendUsd":0.0,"usageToday":{"minutes":0.0},"version":"…",
  "preliminary":false}``。``memberSince`` 是注册时间（毫秒 UTC）；本月花费
  取 ``ai_usage`` 当月 SUM（估算值）；今日分钟取 ``watch_events`` 当地今天
  ``watched_seconds`` ÷ 60；无数据为 0。``preliminary=true`` 表示统计源表
  缺失、数字是降级值（正常库为 false）。

错误语义：400 用户名不合法；403 游客/未登录；404 用户不存在（极少数竞态）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import account

router = APIRouter(prefix="/api/user", tags=["user-profile"])


class ProfileUpdate(BaseModel):
    """``PATCH /api/user/profile`` 只接受 username；多余字段忽略。

    用 object 而不是 str|None：非字符串也走 400（与注册一致），而不是 422。
    """

    username: object = None


def _require_login(request: Request) -> dict:
    """用户资料必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="用户资料需要登录后使用（游客数据不跨设备同步）。",
        )
    return user


@router.patch("/profile")
def update_profile(payload: ProfileUpdate, request: Request):
    """改用户名（唯一可改字段）；返回更新后的 user。"""
    user = _require_login(request)
    if "username" not in payload.model_fields_set:
        raise HTTPException(status_code=400, detail="请提供 username。")
    try:
        updated = account.update_username(user["id"], payload.username)
    except account.InvalidUsername as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except account.UserNotFound:
        raise HTTPException(status_code=404, detail="用户不存在。")
    return {"user": updated}


@router.get("/summary")
def user_summary(request: Request):
    """用户页数据：用户信息 / 余额 / 本月花费 / 今日学习 / 版本号。"""
    user = _require_login(request)
    try:
        return account.build_summary(user["id"])
    except account.UserNotFound:
        raise HTTPException(status_code=404, detail="用户不存在。")
