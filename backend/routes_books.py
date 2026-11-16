"""公版书阅读库 HTTP 路由（用户需求：公版书系列阅读库）。

端点：

- ``GET /api/books``                         系列分组 + 每本可读章节数；
- ``GET /api/books/{book_id}``               单本元数据 + 已导入章节索引 + 同系列书目；
- ``GET /api/books/{book_id}/chapters/{n}``  **实时抓取**公版源原文，按段落与本地
  中译文对齐返回 ``paragraphs: [{index, en, zh}]``；译文缺失段落 ``zh: null``。

身份与缓存：

- 公开只读、免登录；``/api/books*`` 在 ``main.py`` 的公开白名单里，中间件不创建
  游客身份、不下发 Cookie（与 /api/library 一致）；
- 书单/详情是本地元数据，可缓存 5 分钟；**章节含实时抓取的英文原文，一律
  ``Cache-Control: no-store``**，不把公版源正文交给浏览器缓存；
- 章节抓取按 IP 限速（``RATE_LIMIT_BOOKS_PER_MINUTE``），避免把源站当 CDN。

错误语义：

- 404：书 id/章节号非法或未导入；
- 503：书单/译文损坏，或公版源抓取失败（超时、404、过大、编码/结构不可解析）。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import books

logger = logging.getLogger("linguatrek.books.routes")

router = APIRouter(tags=["books"])


def _json(payload: dict, *, max_age: int | None) -> JSONResponse:
    headers: dict[str, str] = {}
    if max_age is None:
        headers["Cache-Control"] = "no-store, max-age=0"
        headers["Pragma"] = "no-cache"
    else:
        headers["Cache-Control"] = f"public, max-age={max_age}"
    return JSONResponse(content=payload, headers=headers)


def _manifest_or_503() -> dict:
    try:
        return books.load_manifest()
    except books.BooksUnavailable as exc:
        logger.warning("读取公版书单失败：%s", exc)
        raise HTTPException(status_code=503, detail="公版书库暂时不可用。") from exc


@router.get("/api/books")
def get_books():
    """公版书系列清单；公开、无需登录、不抓取源站。"""
    manifest = _manifest_or_503()
    return _json(books.manifest_summary(manifest), max_age=300)


@router.get("/api/books/{book_id}")
def get_book(book_id: str):
    """单本元数据 + 已导入章节索引 + 同系列全部书目（含 coming_soon）。"""
    manifest = _manifest_or_503()
    try:
        book = books.find_book(manifest, book_id)
    except books.BookNotFound:
        raise HTTPException(status_code=404, detail="书籍不存在。") from None

    series = next(item for item in manifest["series"] if item["id"] == book["seriesId"])
    payload = {
        **books.book_summary(book),
        "series": {
            **books.series_summary(series),
            "books": [books.book_summary(item) for item in series["books"]],
        },
        "chapters": [
            {
                "n": chapter["n"],
                "title": chapter["title"],
                "titleZh": chapter.get("titleZh"),
                "translated": chapter.get("translated", False),
            }
            for chapter in book["chapters"]
        ],
    }
    if book["status"] == "coming_soon":
        payload["message"] = book.get("contentNote") or "这本书已列入系列计划，暂不提供正文。"
    return _json(payload, max_age=300)


@router.get("/api/books/{book_id}/chapters/{number}")
def get_book_chapter(book_id: str, number: int):
    """实时抓取公版源章节，并与本地中译文按段落对齐；不缓存原文。"""
    manifest = _manifest_or_503()
    try:
        payload = books.build_chapter_payload(manifest, book_id, number)
    except books.BookNotFound:
        raise HTTPException(status_code=404, detail="章节不存在或尚未导入。") from None
    except books.BooksUnavailable as exc:
        logger.warning("读取公版书译文失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(status_code=503, detail="本地译文损坏，暂时无法打开。") from exc
    except books.BookSourceUnavailable as exc:
        logger.warning("公版源抓取失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(
            status_code=503,
            detail="公版源暂时不可用，无法获取本章原文，请稍后重试。",
            headers={"Retry-After": "60"},
        ) from exc
    return _json(payload, max_age=None)
