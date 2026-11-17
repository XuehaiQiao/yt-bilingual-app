"""单词本词表与等级 HTTP 路由（公开只读，无需登录）。

端点：

- ``GET /api/vocabulary/lists``：词表目录（CEFR A1–C2 + GRE/CET4/CET6）；
- ``GET /api/vocabulary/lists/{id}?page=1&pageSize=50&q=``：分页/搜索；
- ``GET /api/vocabulary/level?words=a,b,c``：词 → A1–C1 / ``C1+`` / ``null``。

数据来自 ``content/wordlists/`` 与 ``content/wordlist/`` 的只读 JSON，没有
数据库迁移；文件缺失/损坏由 ``vocabulary`` 抛 ``VocabularyUnavailable`` → 503。
公开只读端点在 ``main.py`` 的 ``_PUBLIC_API_PREFIXES`` 里，不会签发游客 Cookie。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

import vocabulary

router = APIRouter(tags=["vocabulary"])

PUBLIC_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}


def _handle_error(exc: vocabulary.VocabularyError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/api/vocabulary/lists")
def get_vocabulary_lists():
    """词表目录：CEFR A1–C1（C2 标 available:false）+ GRE/CET4/CET6。"""
    try:
        payload = vocabulary.list_catalog()
    except vocabulary.VocabularyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)


@router.get("/api/vocabulary/lists/{list_id}")
def get_vocabulary_list(
    list_id: str,
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(
        vocabulary.DEFAULT_PAGE_SIZE,
        ge=1,
        le=vocabulary.MAX_PAGE_SIZE,
        alias="pageSize",
        description=f"每页条数，1–{vocabulary.MAX_PAGE_SIZE}",
    ),
    q: str | None = Query(None, description="大小写不敏感的前缀/包含搜索"),
):
    """某个词表的分页条目；词表不存在/C2 → 404，数据文件缺失 → 503。"""
    try:
        payload = vocabulary.list_page(list_id, page, page_size, q)
    except vocabulary.VocabularyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)


@router.get("/api/vocabulary/level")
def get_vocabulary_level(
    words: list[str] | None = Query(
        None,
        description="逗号分隔的单词（≤100；也可重复传 words=...）",
    ),
):
    """词级 CEFR：在频表 → A1–C1；合法但不在频表 → C1+；非法 token → null。"""
    tokens: list[str] = []
    for raw in words or []:
        for chunk in str(raw).split(","):
            token = chunk.strip()
            if token:
                tokens.append(token)
    try:
        payload = vocabulary.level_for_words(tokens)
    except vocabulary.VocabularyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)
