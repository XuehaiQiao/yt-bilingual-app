"""自定义词表 HTTP 路由（specs/038-custom-wordlists §5）。

全部端点**需登录**：游客/未登录统一 **403**（词表归属账号，否则换设备后无法
恢复；也不做本地导入）。校验/事务/落库都在 ``wordlists.py``，本模块只做参数
解析、错误码映射与响应序列化。

端点：

- ``POST   /api/wordlists/import``  导入一张词表（≤10000 行，整笔事务）→ 201
- ``POST   /api/wordlists/apkg-parse`` 解析 Anki ``.apkg``（multipart ``file``，
  只读解析、不入库；≤50MB）→ decks/models/notes
- ``GET    /api/wordlists``         当前用户全部词表（按创建时间升序）
- ``GET    /api/wordlists/{id}``    词表详情（page/pageSize/q 分页搜索）
- ``PATCH  /api/wordlists/{id}``    重命名词表（≤80、同用户唯一）
- ``POST   /api/wordlists/{id}/backfill-cefr``  给存量空 CEFR 补 A1–C1
- ``DELETE /api/wordlists/{id}``    删除词表（条目级联删除；不影响收藏/复习）
- ``DELETE /api/wordlists/{id}/items``  按 id 批量删除词条（1–500、整笔事务）

错误语义：

- 400：无有效词条 / 无效行 > 50% / 超过 10 张表 / 超过 10000 行 / name 非法 /
  重名 / itemIds 数量越界或有不属于该词表的 id；APKG 非法/无 notes/格式不支持；
- 403：游客或未登录；
- 404：词表不存在或不属于当前用户（不泄露存在性）；
- 413：APKG 文件 > 50MB 或 collection 解压后超限；
- 503：未跑 ``0028_user_wordlists`` 迁移；APKG 所需 ``zstandard`` 依赖缺失；
  CEFR 回填时 10k 频表不可用。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

import apkg_import
import wordlists

logger = logging.getLogger(__name__)

router = APIRouter(tags=["wordlists"])

# APKG 上传按块读，超过上限立即 413（与本地 EPUB 上传同一策略）。
_APKG_READ_CHUNK = 1024 * 1024


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


def _human_size(value: int) -> str:
    if value >= 1024 * 1024:
        return f"{value // (1024 * 1024)}MB"
    return f"{max(1, value // 1024)}KB"


def _read_apkg_upload(upload: UploadFile | None) -> tuple[bytes, str]:
    """流式读取 multipart 文件并校验扩展名/大小；超限立即 413。"""
    if upload is None:
        raise HTTPException(status_code=400, detail="请选择要解析的 .apkg 文件。")
    filename = apkg_import.display_filename(upload.filename)
    if not filename.lower().endswith(".apkg"):
        raise HTTPException(status_code=400, detail="只支持 .apkg 格式的 Anki 导出包。")
    limit = apkg_import.max_upload_bytes()
    chunks: list[bytes] = []
    total = 0
    try:
        while True:
            chunk = upload.file.read(_APKG_READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(
                    status_code=413,
                    detail=f"APKG 文件超过 {_human_size(limit)} 上限。",
                )
            chunks.append(chunk)
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(
            status_code=400, detail="读取上传文件失败，请重试。"
        ) from exc
    if not chunks:
        raise HTTPException(status_code=400, detail="APKG 文件为空。")
    return b"".join(chunks), filename


@router.post("/api/wordlists/apkg-parse")
async def parse_apkg_upload(request: Request, file: UploadFile | None = File(None)):
    """解析 Anki ``.apkg`` 的牌组/笔记类型/notes（只读，不入库）。

    - 需登录（游客 403）；只接受 ``.apkg``，流式读取 ≤50MB（413）；
    - ZIP 只读 collection 成员，不解压媒体；``.anki21b`` 走 zstd；
    - 读取与解析都放在线程池，避免阻塞事件循环；
    - 返回 ``decks/models/notes/total/truncated``；没 notes/格式不支持 → 400，
      缺 ``zstandard`` → 503。
    """
    _require_login(request)
    data, filename = await asyncio.to_thread(_read_apkg_upload, file)
    try:
        return await asyncio.to_thread(apkg_import.parse_apkg, data, filename)
    except apkg_import.ApkgError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


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


@router.post("/api/wordlists/{list_id}/backfill-cefr")
def backfill_wordlist_cefr(list_id: str, request: Request):
    """给存量词表补全 CEFR（打开老词表时前端自动调用一次，也可手动触发）。

    - 需登录；游客 403；
    - 词表不存在或不属于当前用户 → 404（不泄露存在性）；
    - 只处理 ``cefr`` 为空的行，用 10k 频表批量匹配并只写 A1–C1；
      已有值不覆盖；``C1+``/未知/多词短语留空；整笔事务、幂等；
    - 无请求体（因此没有 400 入参分支；非法 id 按不存在处理）；
    - 频表不可用 → 503，不落半批；
    - 返回 ``{updated,total,remaining}``：本次更新数 / 表内总数 / 仍缺 CEFR 数。
    """
    user = _require_login(request)
    try:
        return wordlists.backfill_list_cefr(user["id"], list_id)
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
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
