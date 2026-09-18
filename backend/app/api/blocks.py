"""API 入口：/api/blocks（字符块 CRUD，M2 完整化）。

- 名称 2–30 字 / 内容 ≤5000 字（D8）/ 标签 ≤10 个，超限 BLOCK_INVALID / TAG_INVALID
- 标签以名字传入：不存在的自动创建（get-or-create）
- 删除只软删（D11）：置 deleted_at + 关联绑定同事务置 missing（repo 原子完成）
"""

import sqlite3

from fastapi import APIRouter, Response
from pydantic import BaseModel

from app.core.errors import BLOCK_INVALID, BLOCK_NOT_FOUND, TAG_INVALID, AppError
from app.models.db import get_conn
from app.models.entities import Block, Tag
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import tags as tags_repo

router = APIRouter(prefix="/api")

# PRD 4.3 字段规则：名称 2–30 字、内容 ≤5000 字（D8）、标签 ≤10 个
_NAME_MIN, _NAME_MAX = 2, 30
_CONTENT_MAX = 5000
_TAG_NAME_MAX = 20
_TAGS_MAX = 10
_DEFAULT_CATEGORY = "未分类"


class BlockCreate(BaseModel):
    name: str
    content: str
    category: str = _DEFAULT_CATEGORY
    tags: list[str] = []


class BlockUpdate(BaseModel):
    name: str | None = None
    content: str | None = None
    category: str | None = None
    tags: list[str] | None = None  # None = 不动标签；[] = 清空标签


def _validate(name: str, content: str, category: str) -> tuple[str, str, str]:
    name = name.strip()
    category = category.strip() or _DEFAULT_CATEGORY
    if not (_NAME_MIN <= len(name) <= _NAME_MAX):
        raise AppError(
            BLOCK_INVALID, f"块名称长度须在 {_NAME_MIN}–{_NAME_MAX} 字之间", status_code=400
        )
    if len(content) > _CONTENT_MAX:
        raise AppError(
            BLOCK_INVALID, f"块内容不能超过 {_CONTENT_MAX} 字（D8）", status_code=400
        )
    if not content.strip():
        raise AppError(BLOCK_INVALID, "块内容不能为空", status_code=400)
    return name, content, category


def _validate_tags(raw: list[str]) -> list[str]:
    """去空白、去重、保序；数量/长度超限报 TAG_INVALID。"""
    names: list[str] = []
    for item in raw:
        name = item.strip()
        if not name:
            continue
        if len(name) > _TAG_NAME_MAX:
            raise AppError(
                TAG_INVALID, f"标签名不能超过 {_TAG_NAME_MAX} 字：{name}", status_code=400
            )
        if name not in names:
            names.append(name)
    if len(names) > _TAGS_MAX:
        raise AppError(TAG_INVALID, f"每个块最多挂 {_TAGS_MAX} 个标签", status_code=400)
    return names


def _resolve_tags(conn: sqlite3.Connection, names: list[str]) -> list[Tag]:
    """按名取标签，不存在则创建（get-or-create）。"""
    tags: list[Tag] = []
    for name in names:
        tag = tags_repo.get_tag_by_name(conn, name)
        tags.append(tag if tag is not None else tags_repo.create_tag(conn, name))
    return tags


def _replace_tags(conn: sqlite3.Connection, block_id: int, names: list[str]) -> list[Tag]:
    """整组替换块标签：摘除不在新集合的，挂上缺的。"""
    desired = _resolve_tags(conn, names)
    desired_ids = {t.id for t in desired}
    for current in tags_repo.tags_of_block(conn, block_id):
        if current.id not in desired_ids:
            tags_repo.detach_tag(conn, block_id, current.id)
    for tag in desired:
        tags_repo.attach_tag(conn, block_id, tag.id)
    return tags_repo.tags_of_block(conn, block_id)


def _block_dict(b: Block, tags: list[Tag]) -> dict[str, object]:
    return {
        "id": b.id,
        "name": b.name,
        "content": b.content,
        "category": b.category,
        "tags": [{"id": t.id, "name": t.name} for t in tags],
        "created_at": b.created_at,
        "updated_at": b.updated_at,
    }


def _block_with_tags(conn: sqlite3.Connection, block_id: int) -> dict[str, object] | None:
    """读块 + 其标签组组成响应字典；不存在或已软删除返回 None。"""
    block = blocks_repo.get_block(conn, block_id)
    if block is None:
        return None
    return _block_dict(block, tags_repo.tags_of_block(conn, block_id))


@router.post("/blocks", status_code=201)
def create_block(payload: BlockCreate) -> dict[str, object]:
    """新建字符块（标签 get-or-create 挂接）。"""
    name, content, category = _validate(payload.name, payload.content, payload.category)
    tag_names = _validate_tags(payload.tags)
    with get_conn() as conn:
        block = blocks_repo.create_block(conn, name, content, category)
        tags = _replace_tags(conn, block.id, tag_names)
    return _block_dict(block, tags)


@router.get("/blocks")
def list_blocks() -> dict[str, object]:
    """块列表（存活块，排除软删除，创建正序，含各自标签组）。"""
    with get_conn() as conn:
        items = [
            _block_dict(b, tags_repo.tags_of_block(conn, b.id))
            for b in blocks_repo.list_blocks(conn)
        ]
    return {"blocks": items}


@router.get("/blocks/{block_id}")
def get_block(block_id: int) -> dict[str, object]:
    """块详情（含标签组）。"""
    with get_conn() as conn:
        body = _block_with_tags(conn, block_id)
    if body is None:
        raise AppError(BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404)
    return body


@router.put("/blocks/{block_id}")
def update_block(block_id: int, payload: BlockUpdate) -> dict[str, object]:
    """更新块（部分更新：仅传入字段生效；tags 传入即整组替换）。"""
    with get_conn() as conn:
        current = blocks_repo.get_block(conn, block_id)
        if current is None:
            raise AppError(
                BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404
            )
        name = content = category = None
        if payload.name is not None or payload.content is not None or payload.category is not None:
            # 三字段任一传入即整体校验：以现值补齐未传字段，保证不变量仍成立
            name, content, category = _validate(
                payload.name if payload.name is not None else current.name,
                payload.content if payload.content is not None else current.content,
                payload.category if payload.category is not None else current.category,
            )
        updated = blocks_repo.update_block(
            conn, block_id, name=name, content=content, category=category
        )
        assert updated is not None
        tags = (
            _replace_tags(conn, block_id, _validate_tags(payload.tags))
            if payload.tags is not None
            else tags_repo.tags_of_block(conn, block_id)
        )
    return _block_dict(updated, tags)


@router.delete("/blocks/{block_id}", status_code=204)
def delete_block(block_id: int) -> Response:
    """软删除块（D11）：关联绑定同事务置 missing，导出留空并提示。"""
    with get_conn() as conn:
        deleted = blocks_repo.soft_delete_block(conn, block_id)
    if not deleted:
        raise AppError(BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404)
    return Response(status_code=204)
