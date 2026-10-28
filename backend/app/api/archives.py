"""Immutable document artifacts, independent of live versions and shared blocks."""

import hashlib
import json
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from app.core.errors import AppError
from app.models.db import get_conn, utcnow
from app.services import render_service
from app.services.export_service import document_warnings, sanitize_filename_part, warnings_token

router = APIRouter(prefix="/api")
_FIELDS = "id,name,source_version_id,version_name,template_name,created_at,docx_sha256,pdf_sha256"
DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class ArchiveCreate(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    confirm_large_overflow: bool = False
    confirm_warnings_token: str | None = None


@router.get("/archives")
def list_archives() -> dict[str, object]:
    with get_conn() as conn:
        return {
            "archives": [
                dict(row)
                for row in conn.execute(f"SELECT {_FIELDS} FROM archives ORDER BY id DESC")
            ]
        }


@router.post("/versions/{version_id}/archives")
def create_archive(version_id: int, payload: ArchiveCreate) -> JSONResponse:
    name = payload.name.strip()
    if not name:
        raise AppError("ARCHIVE_INVALID", "归档名称不能为空")
    with get_conn() as conn:
        source = conn.execute(
            "SELECT v.name,t.filename,t.sha256 FROM versions v "
            "JOIN templates t ON t.id=v.template_id WHERE v.id=?",
            (version_id,),
        ).fetchone()
        if source is None:
            raise AppError("VERSION_NOT_FOUND", "内容版本不存在", status_code=404)
    rendered = render_service.render_version(version_id)
    warnings = document_warnings(rendered.items)
    token = warnings_token(rendered.data, warnings)
    missing = any(w.get("kind") == "missing" for w in warnings)
    if warnings and (
        not payload.confirm_large_overflow
        or (missing and payload.confirm_warnings_token != token)
        or (payload.confirm_warnings_token is not None and payload.confirm_warnings_token != token)
    ):
        return JSONResponse(
            status_code=409,
            content={
                "error": {
                    "code": "DOCUMENT_WARNINGS" if missing else "EXPORT_LARGE_OVERFLOW",
                    "message": "存在内容或排版问题，请核对清单后确认归档",
                },
                "warnings": warnings,
                "warning_token": token,
            },
        )
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO archives (name,source_version_id,version_name,template_name,created_at,"
            "docx,pdf,docx_sha256,pdf_sha256,source_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                name,
                version_id,
                source[0],
                source[1],
                utcnow(),
                rendered.data,
                rendered.pdf_data,
                hashlib.sha256(rendered.data).hexdigest(),
                hashlib.sha256(rendered.pdf_data).hexdigest(),
                json.dumps(
                    {"template_sha256": source[2], "regions": rendered.items, "warnings": warnings},
                    ensure_ascii=False,
                ),
            ),
        )
        row = conn.execute(
            f"SELECT {_FIELDS} FROM archives WHERE id=?", (cursor.lastrowid,)
        ).fetchone()
        return JSONResponse(status_code=201, content=dict(row))


@router.get("/archives/{archive_id}/{format}")
def download_archive(archive_id: int, format: str) -> Response:
    if format not in {"docx", "pdf"}:
        raise AppError("ARCHIVE_FORMAT", "仅支持 DOCX 或 PDF", status_code=400)
    with get_conn() as conn:
        row = conn.execute(
            f"SELECT name,{format},{format}_sha256 FROM archives WHERE id=?", (archive_id,)
        ).fetchone()
    if row is None:
        raise AppError("ARCHIVE_NOT_FOUND", "归档不存在", status_code=404)
    data = bytes(row[1])
    if hashlib.sha256(data).hexdigest() != row[2]:
        raise AppError(
            "ARCHIVE_CORRUPT", "归档文件已损坏，无法下载，请使用另行保存的副本", status_code=409
        )
    filename = quote(f"归档-{sanitize_filename_part(row[0])}.{format}")
    return Response(
        data,
        media_type=DOCX_MEDIA if format == "docx" else "application/pdf",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f"attachment; filename*=utf-8''{filename}",
        },
    )


@router.delete("/archives/{archive_id}", status_code=204)
def delete_archive(archive_id: int) -> Response:
    with get_conn() as conn:
        if conn.execute("DELETE FROM archives WHERE id=?", (archive_id,)).rowcount == 0:
            raise AppError("ARCHIVE_NOT_FOUND", "归档不存在", status_code=404)
    return Response(status_code=204)
