"""API 入口：/api/tags（标签管理与筛选数据源，M2）。

合并语义：PUT 重命名撞已有标签名 → 即合并（块关联并入目标标签后删除源标签，
全库引用自动生效，PRD M2「标签合并重命名全库生效」）。
"""

from fastapi import APIRouter, Response
from pydantic import BaseModel

from app.core.errors import TAG_INVALID, TAG_NOT_FOUND, AppError
from app.models.db import get_conn
from app.models.entities import Tag
from app.models.repositories import tags as tags_repo

router = APIRouter(prefix="/api")

_TAG_NAME_MAX = 20


def _validate_tag_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise AppError(TAG_INVALID, "标签名不能为空", status_code=400)
    if len(name) > _TAG_NAME_MAX:
        raise AppError(TAG_INVALID, f"标签名不能超过 {_TAG_NAME_MAX} 字", status_code=400)
    return name


def _tag_dict(tag: Tag, *, block_count: int | None = None) -> dict[str, object]:
    body: dict[str, object] = {
        "id": tag.id,
        "name": tag.name,
        "created_at": tag.created_at,
    }
    if block_count is not None:
        body["block_count"] = block_count
    return body


@router.get("/tags")
def list_tags() -> dict[str, object]:
    """标签列表（含存活块引用计数，供筛选侧栏）。"""
    with get_conn() as conn:
        rows = tags_repo.list_tags_with_counts(conn)
    return {"tags": [_tag_dict(t, block_count=n) for t, n in rows]}


class TagRename(BaseModel):
    name: str


@router.put("/tags/{tag_id}")
def rename_or_merge_tag(tag_id: int, payload: TagRename) -> dict[str, object]:
    """重命名标签；新名与已有标签撞名 → 合并到已有标签（返回目标标签）。"""
    name = _validate_tag_name(payload.name)
    with get_conn() as conn:
        tag = tags_repo.get_tag(conn, tag_id)
        if tag is None:
            raise AppError(TAG_NOT_FOUND, f"标签不存在（id={tag_id}）", status_code=404)
        existing = tags_repo.get_tag_by_name(conn, name)
        if existing is not None and existing.id == tag_id:
            result = tag  # 名字未变，幂等返回
        elif existing is not None:
            tags_repo.merge_tag(conn, tag_id, existing.id)
            result = existing
        else:
            renamed = tags_repo.rename_tag(conn, tag_id, name)
            assert renamed is not None  # 前面已确认标签存在
            result = renamed
    return _tag_dict(result)


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: int) -> Response:
    """删除标签（块关联经联结表 CASCADE 清理；块本身不受影响）。"""
    with get_conn() as conn:
        if not tags_repo.delete_tag(conn, tag_id):
            raise AppError(TAG_NOT_FOUND, f"标签不存在（id={tag_id}）", status_code=404)
    return Response(status_code=204)
