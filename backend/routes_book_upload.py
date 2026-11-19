"""本地 EPUB 上传 HTTP 路由（specs/031 M1）。

端点：

- ``POST /api/books/upload/preview``  multipart ``file`` → 元数据/章节索引/封面
  DataURL/``uploadToken``（5 分钟 TTL，暂存到账号目录，不写数据库）；
- ``POST /api/books/upload``          multipart ``uploadToken`` + ``rightsAccepted=true``
  （或直接 ``file`` + ``rightsAccepted=true``）→ 入「我的书」；
- ``GET  /api/books/imported/{id}/cover``  本地封面（没有封面 404）。

身份：**全部需登录**（游客/未登录 401）。文件只保存到当前账号私有目录，
不生成公开 URL，也不进入公开书库。

幂等与配额：

- 同账号同 SHA-256 直接返回已有书（``existing=true``），不重复占日限；
- 每用户最多 20 本 / 100MB 章节文本；导入 10 次/天（``book_upload`` 日桶）；
- 上传/预览共用 ``/api/books/*`` 的每分钟 IP 桶（``main.py`` 中间件）。

错误语义：400 非 EPUB/损坏/缺文件/未勾选权利声明；401 未登录；404 书或封面
不存在；413 单文件/解压/章节数/单章超限；422 DRM/加密/非英文/无正文；
429 日限或账号配额用完；503 本地书库读写失败。

解析与存储细节在 ``local_epub.py``；数据库读写走 ``book_import.py``，本模块
只做 multipart 读取、配额检查、事务编排与错误映射。
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

import book_import
import config
import local_epub
import ratelimit

logger = logging.getLogger("linguatrek.book_upload.routes")

router = APIRouter(tags=["books"])

_READ_CHUNK = 1024 * 1024


def _require_login(request: Request) -> dict:
    """上传/预览必须归属登录账号；游客/未登录 401。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="上传 EPUB 需要登录（电子书只保存到你的账号下）。",
        )
    return user


def _max_upload_bytes() -> int:
    return local_epub.max_upload_bytes()


def _human_size(value: int) -> str:
    if value >= 1024 * 1024:
        return f"{value / (1024 * 1024):.0f}MB"
    return f"{max(1, value // 1024)}KB"


def _read_upload(upload: UploadFile | None) -> bytes:
    """流式读 multipart 文件，超过单文件上限立即 413（其余字节不再读）。"""
    if upload is None:
        raise HTTPException(status_code=400, detail="请选择要上传的 EPUB 文件。")
    limit = _max_upload_bytes()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = upload.file.read(_READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(
                    status_code=413,
                    detail=f"文件超过 {_human_size(limit)} 上限。",
                )
            chunks.append(chunk)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(
            status_code=400, detail="读取上传文件失败，请重试。"
        ) from exc
    return b"".join(chunks)


def _upload_filename(upload: UploadFile | None) -> str:
    raw = upload.filename if upload is not None else None
    if raw and not raw.lower().endswith(".epub"):
        raise HTTPException(
            status_code=400, detail="只支持 .epub 格式的英文电子书。"
        )
    return local_epub.safe_filename(raw)


def _parse_epub(data: bytes, filename: str) -> local_epub.ParsedEpub:
    try:
        return local_epub.parse_epub(data, filename=filename)
    except local_epub.LocalEpubError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _raise_local(exc: local_epub.LocalEpubError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _raise_book(exc: book_import.BookImportError) -> None:
    raise HTTPException(
        status_code=getattr(exc, "status_code", 400), detail=exc.detail
    ) from exc


def _book_summary(payload: dict, *, existing: bool) -> dict:
    return {
        "bookId": payload["bookId"],
        "title": payload["title"],
        "author": payload["author"],
        "language": payload.get("language"),
        "chapterCount": payload["chapterCount"],
        "sourceType": payload.get("sourceType", book_import.SOURCE_TYPE_LOCAL_EPUB),
        "existing": existing,
    }


def _check_quota(user_id: str, parsed: local_epub.ParsedEpub) -> None:
    """写库前检查每用户书数/总文本配额；超限 429（不占日限）。"""
    books, text_bytes = local_epub.book_usage(user_id)
    max_books = local_epub.max_books_per_user()
    if max_books > 0 and books >= max_books:
        raise HTTPException(
            status_code=429,
            detail=f"本地上传书已达上限（{max_books} 本），请先删除不再需要的书。",
        )
    max_text = local_epub.max_text_bytes_per_user()
    if max_text > 0 and text_bytes + parsed.text_bytes > max_text:
        raise HTTPException(
            status_code=429,
            detail=(
                f"本地书总文本已达上限（{_human_size(max_text)}），"
                "请先删除不再需要的书。"
            ),
        )


def _consume_daily_quota(user_id: str) -> None:
    limit = max(
        0, int(getattr(config, "RATE_LIMIT_BOOK_UPLOAD_PER_DAY", 10) or 0)
    )
    retry_after = ratelimit.consume_daily("book_upload", f"user:{user_id}", limit)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"今天的上传次数已用完（每天 {limit} 本），请明天再试。",
            headers={"Retry-After": str(retry_after)},
        )


# ---------------------------------------------------------------------------
# 预览 / 导入
# ---------------------------------------------------------------------------

@router.post("/api/books/upload/preview")
def preview_upload(request: Request, file: UploadFile = File(...)):
    """解析 EPUB 并暂存 5 分钟：返回元数据、章节索引、封面 DataURL 与凭证。"""
    user = _require_login(request)
    data = _read_upload(file)
    filename = _upload_filename(file)
    parsed = _parse_epub(data, filename)
    try:
        token = local_epub.stage_upload(user["id"], data, filename)
    except local_epub.LocalEpubError as exc:
        _raise_local(exc)
    return {
        "uploadToken": token,
        "fileName": filename,
        "title": parsed.title,
        "author": parsed.author,
        "language": parsed.language,
        "chapterCount": len(parsed.chapters),
        "chapters": [
            {
                "n": chapter.n,
                "title": chapter.title,
                "chars": sum(len(item) for item in chapter.paragraphs),
            }
            for chapter in parsed.chapters
        ],
        "coverDataUrl": local_epub.cover_data_url(parsed.cover),
        "sizeBytes": parsed.size_bytes,
    }


@router.post("/api/books/upload")
def upload_local_epub(
    request: Request,
    uploadToken: str | None = Form(None),
    rightsAccepted: bool | None = Form(None),
    file: UploadFile | None = File(None),
):
    """把本地 EPUB 加入当前用户「我的书」；同文件重复上传返回已有记录。"""
    user = _require_login(request)
    if not rightsAccepted:
        raise HTTPException(
            status_code=400,
            detail="请先确认你拥有该文件的使用权，且不会上传盗版或未授权内容。",
        )
    user_id = user["id"]
    if uploadToken:
        try:
            data, filename = local_epub.take_staged_upload(user_id, uploadToken)
        except local_epub.LocalEpubError as exc:
            _raise_local(exc)
    elif file is not None:
        data = _read_upload(file)
        filename = _upload_filename(file)
    else:
        raise HTTPException(
            status_code=400, detail="请先选择 EPUB 文件，或先调用预览获取 uploadToken。"
        )

    parsed = _parse_epub(data, filename)
    try:
        existing = book_import.find_local_book(user_id, parsed.sha256)
    except book_import.BookImportError as exc:
        _raise_book(exc)
    if existing is not None:
        return _book_summary(existing, existing=True)

    _check_quota(user_id, parsed)
    _consume_daily_quota(user_id)

    book_id = f"epub-{uuid.uuid4().hex}"
    try:
        chapters_json = local_epub.save_book(user_id, book_id, parsed)
    except local_epub.LocalEpubError as exc:
        _raise_local(exc)
    try:
        payload = book_import.create_local_book(
            user_id,
            book_id,
            sha256=parsed.sha256,
            title=parsed.title,
            author=parsed.author,
            language=parsed.language,
            chapters_json=chapters_json,
        )
    except book_import.BookImportError as exc:
        local_epub.delete_book(user_id, book_id)
        _raise_book(exc)
    except Exception:
        # 任何未预期的写库失败都不留下半本书（目录已原子写入正式位置）。
        local_epub.delete_book(user_id, book_id)
        raise
    return _book_summary(payload, existing=False)


@router.get("/api/books/imported/{book_id}/cover")
def get_local_book_cover(book_id: str, request: Request):
    """返回本地书的封面图；不是本地书或没有封面时 404（不泄露存在性）。"""
    user = _require_login(request)
    try:
        book = book_import.get_imported_book(user["id"], book_id)
    except book_import.BookImportError as exc:
        _raise_book(exc)
    if book.get("sourceType") != book_import.SOURCE_TYPE_LOCAL_EPUB:
        raise HTTPException(status_code=404, detail="这本书没有本地封面。")
    try:
        cover = local_epub.read_cover(user["id"], book_id)
    except local_epub.LocalEpubError as exc:
        _raise_local(exc)
    if cover is None:
        raise HTTPException(status_code=404, detail="这本书没有封面。")
    data, mime = cover
    return Response(
        content=data,
        media_type=mime,
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )
