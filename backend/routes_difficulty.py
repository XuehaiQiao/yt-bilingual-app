"""内容难度 HTTP 路由（CEFR M2，计划书 §7.4 / specs/026）。

端点：

- ``GET  /api/content/difficulty?kind=video&ref=...&band=A2``：公开单条内容难度；
- ``GET  /api/content/difficulty/batch?items=kind:ref,kind:ref&band=A2``：公开批量
  （≤50 条；``items`` 也可重复传参）；
- ``POST /api/admin/content-difficulty/recompute``：管理员重算（鉴权同
  ``/api/admin/*``：未登录 401、非管理员 403）。

行为：

- 有 ``content_difficulty`` 行 → ``source=computed``，返回 ``difficulty.v1``
  features、``cefrInput`` 等；
- 行缺失/表未迁移 → 回退内容自身编辑 ``level``（``source=legacy``，HTTP 200）；
- 内容本身不存在 → 404（不泄露存在性）；
- 可选 ``band``（用户词汇低带 A1–C1）→ 返回 ``utrBand`` 与 ``bucket``
  （「生词约 X%（桶）」，按该带估算）；
- 公开响应 ``Cache-Control: public, max-age=3600``。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import difficulty
import routes_admin

router = APIRouter(tags=["difficulty"])

PUBLIC_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}
MAX_BATCH = 50
MAX_REF_CHARS = 120


class RecomputeTarget(BaseModel):
    """单条重算目标。"""

    kind: str
    ref: str


class RecomputeRequest(BaseModel):
    """``{items:[{kind, ref}]}`` 或 ``{kind, ref}``。"""

    items: list[RecomputeTarget] | None = None
    kind: str | None = None
    ref: str | None = None


def _validate_kind(kind: str) -> str:
    if kind not in difficulty.CONTENT_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"kind 必须是 {', '.join(difficulty.CONTENT_KINDS)} 之一",
        )
    return kind


def _validate_ref(ref: str) -> str:
    value = (ref or "").strip()
    if not value or len(value) > MAX_REF_CHARS:
        raise HTTPException(status_code=400, detail="ref 必须是 1–120 字符")
    return value


def _validate_band(band: str | None) -> str | None:
    if band is None:
        return None
    if band not in difficulty.CEFR_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=f"band 必须是 {', '.join(difficulty.CEFR_LEVELS)} 之一",
        )
    return band


def _parse_items(items: list[str]) -> list[tuple[str, str]]:
    """``["video:id", "curated:abc"]`` → 去重后的 (kind, ref) 列表。"""
    raw_pairs: list[tuple[str, str]] = []
    for raw in items:
        for chunk in str(raw or "").split(","):
            if not chunk.strip():
                continue
            if ":" not in chunk:
                raise HTTPException(
                    status_code=400, detail="items 每项必须是 kind:ref（例如 curated:abc）"
                )
            kind, ref = chunk.split(":", 1)
            raw_pairs.append((_validate_kind(kind.strip()), _validate_ref(ref)))
    if not raw_pairs:
        raise HTTPException(status_code=400, detail="items 不能为空")
    if len(raw_pairs) > MAX_BATCH:
        raise HTTPException(
            status_code=400, detail=f"批量最多 {MAX_BATCH} 条（收到 {len(raw_pairs)} 条）"
        )
    parsed: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for pair in raw_pairs:
        if pair in seen:
            continue
        seen.add(pair)
        parsed.append(pair)
    return parsed


def _handle_error(exc: difficulty.DifficultyError) -> HTTPException:
    if isinstance(exc, difficulty.DifficultyNotFound):
        return HTTPException(status_code=404, detail="内容不存在")
    if isinstance(exc, difficulty.DifficultyUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/api/content/difficulty")
def get_content_difficulty(
    kind: str = Query(..., description="video / article / curated / local_show"),
    ref: str = Query(..., description="内容引用（library id 或 YouTube videoId）"),
    band: str | None = Query(None, description="用户词汇带上界（A1–C1，可选）"),
):
    """公开单条内容难度；缺失难度行时回退旧 level。"""
    try:
        payload = difficulty.difficulty_payload(
            _validate_kind(kind), _validate_ref(ref), band=_validate_band(band)
        )
    except difficulty.DifficultyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(content=payload, headers=PUBLIC_CACHE_HEADERS)


@router.get("/api/content/difficulty/batch")
def get_content_difficulty_batch(
    items: list[str] = Query(..., description="kind:ref，逗号分隔或重复传参（≤50）"),
    band: str | None = Query(None, description="用户词汇带上界（A1–C1，可选）"),
):
    """公开批量难度；任一条内容不存在 → 404（整批失败，不返回半批）。"""
    parsed = _parse_items(items)
    try:
        payloads = difficulty.batch_payload(parsed, band=_validate_band(band))
    except difficulty.DifficultyError as exc:
        raise _handle_error(exc) from exc
    return JSONResponse(
        content={"schema": difficulty.SCHEMA, "items": payloads},
        headers=PUBLIC_CACHE_HEADERS,
    )


@router.post("/api/admin/content-difficulty/recompute")
def recompute_content_difficulty(
    request: Request,
    body: RecomputeRequest,
    _user: dict = Depends(routes_admin.require_admin),
):
    """管理员重算 1–50 条内容难度并 upsert（幂等）。"""
    targets: list[RecomputeTarget] = list(body.items or [])
    if body.kind or body.ref:
        if not body.kind or not body.ref:
            raise HTTPException(status_code=400, detail="kind 与 ref 必须同时提供")
        targets.append(RecomputeTarget(kind=body.kind, ref=body.ref))
    if not targets:
        raise HTTPException(status_code=400, detail="items 不能为空")
    if len(targets) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"批量最多 {MAX_BATCH} 条")

    results: list[dict] = []
    for target in targets:
        kind = _validate_kind(target.kind)
        ref = _validate_ref(target.ref)
        try:
            payload = difficulty.recompute(kind, ref)
            results.append(
                {
                    "kind": kind,
                    "ref": ref,
                    "status": "computed",
                    "cefrInput": payload.get("cefrInput"),
                    "confidence": payload.get("confidence"),
                }
            )
        except difficulty.DifficultyNotFound:
            if len(targets) == 1:
                raise HTTPException(status_code=404, detail="内容不存在") from None
            results.append(
                {"kind": kind, "ref": ref, "status": "not_found", "error": "内容不存在"}
            )
        except difficulty.DifficultyUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except difficulty.DifficultyInvalid as exc:
            if len(targets) == 1:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            results.append(
                {"kind": kind, "ref": ref, "status": "invalid", "error": str(exc)}
            )
    counts = {
        "requested": len(results),
        "computed": sum(1 for item in results if item["status"] == "computed"),
        "notFound": sum(1 for item in results if item["status"] == "not_found"),
        "invalid": sum(1 for item in results if item["status"] == "invalid"),
    }
    return JSONResponse(
        content={"schema": difficulty.SCHEMA, "results": results, "counts": counts},
        headers={"Cache-Control": "no-store"},
    )
