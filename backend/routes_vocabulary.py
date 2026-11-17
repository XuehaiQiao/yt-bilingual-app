"""单词本词表与等级 HTTP 路由（公开只读，无需登录）。

端点：

- ``GET /api/vocabulary/lists``：词表目录（短语 + 合并 CEFR 词表 +
  兼容用的 CEFR A1–C2 + GRE/CET4/CET6）；
- ``GET /api/vocabulary/lists/{id}?page=1&pageSize=50&q=&level=``：分页/
  搜索；``cefr`` 合并 A1–C1，可用 ``level`` 筛到单级；
- ``GET /api/vocabulary/phrases?page=1&pageSize=50&q=&level=&type=``：短语分页/
  搜索/按等级与类型筛选；
- ``GET /api/vocabulary/phrases/{id}``：短语详情；
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
    """词表目录：短语 + 合并 CEFR 词表 + 兼容的 A1–C1（C2 false）+ 考试词表。"""
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
    level: str | None = Query(
        None,
        description="A1 / A2 / B1 / B2 / C1；cefr 合并词表按等级筛选",
    ),
):
    """某个词表的分页条目；词表不存在/C2 → 404，参数非法 → 400，数据缺失 → 503。"""
    try:
        payload = vocabulary.list_page(list_id, page, page_size, q, level)
    except vocabulary.VocabularyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)


@router.get("/api/vocabulary/phrases")
def get_vocabulary_phrases(
    page: int = Query(1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(
        vocabulary.DEFAULT_PAGE_SIZE,
        ge=1,
        le=vocabulary.MAX_PAGE_SIZE,
        alias="pageSize",
        description=f"每页条数，1–{vocabulary.MAX_PAGE_SIZE}",
    ),
    q: str | None = Query(None, description="大小写不敏感：headword + 中文释义"),
    level: str | None = Query(
        None,
        description="A2 / B1 / B2 / C1 / C1+（C1+ 表示 C1 及以上）",
    ),
    phrase_type: str | None = Query(
        None,
        alias="type",
        description="phrasal_verb / idiom / collocation",
    ),
):
    """短语分页；level/type 非法 → 400，文件缺失/损坏 → 503。"""
    try:
        payload = vocabulary.phrase_page(
            page, page_size, q, level, phrase_type
        )
    except vocabulary.VocabularyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)


@router.get("/api/vocabulary/phrases/{phrase_id}")
def get_vocabulary_phrase_detail(phrase_id: str):
    """短语详情；id 不存在 → 404，文件缺失/损坏 → 503。"""
    try:
        payload = vocabulary.phrase_detail(phrase_id)
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
