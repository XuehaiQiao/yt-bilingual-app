"""自定义词表 HTTP 路由（specs/038-custom-wordlists §5）。

全部端点**需登录**：游客/未登录统一 **403**（词表归属账号，否则换设备后无法
恢复；也不做本地导入）。校验/事务/落库都在 ``wordlists.py``，本模块只做参数
解析、错误码映射与响应序列化。

端点：

- ``POST   /api/wordlists/import``  导入一张词表（≤5000 行，整笔事务）→ 201
- ``GET    /api/wordlists``         当前用户全部词表（按创建时间升序）
- ``GET    /api/wordlists/{id}``    词表详情（page/pageSize/q 分页搜索）
- ``PATCH  /api/wordlists/{id}``    重命名词表（≤80、同用户唯一）
- ``DELETE /api/wordlists/{id}``    删除词表（条目级联删除；不影响收藏/复习）
- ``DELETE /api/wordlists/{id}/items``  按 id 批量删除词条（1–500、整笔事务）

错误语义：

- 400：无有效词条 / 无效行 > 50% / 超过 10 张表 / 超过 5000 行 / name 非法 /
  重名 / itemIds 数量越界或有不属于该词表的 id；
- 403：游客或未登录；
- 404：词表不存在或不属于当前用户（不泄露存在性）；
- 503：未跑 ``0028_user_wordlists`` 迁移。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

import wordlists

logger = logging.getLogger(__name__)

router = APIRouter(tags=["wordlists"])


class ImportItemIn(BaseModel):
    """单行词条；字段用 ``object`` 接，非法行交给服务端计入 ``skipped``。

    ``word`` 缺失/非字符串 / 中文 / 纯数字 / 超长等都按无效行处理（不是 422），
    这样「全无效 → 400」「无效 > 50% → 400」才有统一口径。
    """

    word: object = None
    translation: object = None
    phonetic: object = None
    cefr: object = None
    example: object = None


class ImportRequest(BaseModel):
    name: str | None = None
    filename: str | None = None
    items: list[ImportItemIn] = Field(default_factory=list)


class RenameRequest(BaseModel):
    """PATCH body；``name`` 用 ``object`` 接，非法类型统一 400（不是 422）。"""

    name: object = None


class DeleteItemsRequest(BaseModel):
    """DELETE body；``itemIds`` 用 ``object`` 接，数量/类型交给 service 判 400。"""

    itemIds: object = None


def _require_login(request: Request) -> dict:
    """词表必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="自定义词表需要登录后使用（词表保存在账号下，换设备可恢复）。",
        )
    return user


def _raise_wordlist_error(exc: Exception) -> None:
    """把 wordlists 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, wordlists.WordlistUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, wordlists.WordlistNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ValueError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.post("/api/wordlists/import", status_code=201)
def import_wordlist(payload: ImportRequest, request: Request):
    """导入一张自定义词表。

    - 需登录；游客 403；
    - 先做全量校验再去重（``NFC + casefold``，保留第一条原词形）；
    - 有效 0 行或校验失败 > 50% → 400，不落半张表；
    - 返回 ``{list:{id,name,itemCount,createdAt}, skipped}``；``skipped`` =
      无效行 + 重复行。
    """
    user = _require_login(request)
    try:
        result = wordlists.import_wordlist(
            user["id"],
            name=payload.name,
            filename=payload.filename,
            items=[item.model_dump() for item in payload.items],
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_wordlist_error(exc)
        raise  # pragma: no cover - _raise_wordlist_error 必抛
    return result


@router.get("/api/wordlists")
def list_wordlists(request: Request):
    """当前用户的词表列表（不含条目）；按创建时间升序，新导入的排最后。"""
    user = _require_login(request)
    try:
        return wordlists.list_wordlists(user["id"])
    except Exception as exc:  # noqa: BLE001
        _raise_wordlist_error(exc)
        raise  # pragma: no cover


@router.get("/api/wordlists/{list_id}")
def get_wordlist(
    list_id: str,
    request: Request,
    page: int = Query(default=1, ge=1, description="页码，从 1 开始"),
    pageSize: int = Query(default=50, ge=1, le=200, description="每页条数"),
    q: str | None = Query(default=None, description="搜索单词/释义（子串）"),
):
    """词表详情：分页 + 搜索；``items`` 每项含 ``id`` 与内容字段（可直接用于
    ``DELETE /api/wordlists/{id}/items`` 的 ``itemIds``）。

    - 需登录；游客 403；词表不存在/不属于当前用户 404；
    - ``q`` 同时匹配单词与释义；空串视为不搜索；
    - 返回 ``hasMore`` 供前端判断是否继续翻页；``total`` 是搜索过滤后的总数。
    """
    user = _require_login(request)
    try:
        return wordlists.get_wordlist(
            user["id"], list_id, page=page, page_size=pageSize, q=q
        )
    except Exception as exc:  # noqa: BLE001
        _raise_wordlist_error(exc)
        raise  # pragma: no cover


@router.delete("/api/wordlists/{list_id}")
def delete_wordlist(list_id: str, request: Request):
    """删除词表与条目；不影响已收藏/已加入复习的词（快照已存）。"""
    user = _require_login(request)
    try:
        wordlists.delete_wordlist(user["id"], list_id)
    except Exception as exc:  # noqa: BLE001
        _raise_wordlist_error(exc)
        raise  # pragma: no cover
    return {"status": "ok", "deleted": True}


@router.patch("/api/wordlists/{list_id}")
def rename_wordlist(list_id: str, payload: RenameRequest, request: Request):
    """重命名词表（≤80、同用户唯一）。

    - 空名/非字符串/超长/重名 → 400；
    - 词表不存在或不属于当前用户 → 404；
    - 返回 ``{list:{id,name,itemCount,createdAt}}``，不改变条目与创建时间。
    """
    user = _require_login(request)
    try:
        return wordlists.rename_wordlist(user["id"], list_id, payload.name)
    except Exception as exc:  # noqa: BLE001
        _raise_wordlist_error(exc)
        raise  # pragma: no cover


@router.delete("/api/wordlists/{list_id}/items")
def delete_wordlist_items(
    list_id: str, payload: DeleteItemsRequest, request: Request
):
    """按 id 批量删除词表条目（1–500，整笔事务），并同步 ``item_count``。

    - 词表不存在或不属于当前用户 → 404；
    - ``itemIds`` 数量越界/含非字符串/有不属于该词表的 id → 400，整笔不删；
    - 返回 ``{status:"ok",deleted:N,itemCount:M}``；删空后词表本身保留。
    """
    user = _require_login(request)
    try:
        return wordlists.delete_wordlist_items(
            user["id"], list_id, payload.itemIds
        )
    except Exception as exc:  # noqa: BLE001
        _raise_wordlist_error(exc)
        raise  # pragma: no cover
