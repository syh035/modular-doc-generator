"""API 入口：/api/blocks（字符块 CRUD，M2 完整化）。

- 名称 1–30 字 / 内容 ≤5000 字（D8）/ 标签 ≤10 个，超限 BLOCK_INVALID / TAG_INVALID
- 标签以名字传入：不存在的自动创建（get-or-create）
- 删除只软删（D11）：置 deleted_at + 绑定同事务置 missing + 标签关联清除，
  无存活块引用的标签随即自动清理（2026-09-18 用户确认）
- 分类功能已移除（2026-09-18 用户确认），块列表平铺按更新时间倒序
"""

import hashlib
import sqlite3
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel

from app.core.errors import (
    BLOCK_INVALID,
    BLOCK_NOT_FOUND,
    TAG_INVALID,
    TEMPLATE_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn, utcnow
from app.models.entities import Block, Tag
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import tags as tags_repo
from app.models.repositories import templates as templates_repo

router = APIRouter(prefix="/api")

# PRD 4.3 字段规则：名称 1–30 字、内容 ≤5000 字（D8）、标签 ≤10 个
_NAME_MIN, _NAME_MAX = 1, 30
_CONTENT_MAX = 5000
_TAG_NAME_MAX = 20
_TAGS_MAX = 10


class BlockCreate(BaseModel):
    template_id: int | None = None
    name: str
    content: str
    tags: list[str] = []
    kind: Literal["text", "blank"] = "text"


class BlockUpdate(BaseModel):
    kind: Literal["text", "blank"] | None = None
    name: str | None = None
    content: str | None = None
    tags: list[str] | None = None  # None = 不动标签；[] = 清空标签


def _validate(name: str, content: str, kind: str = "text") -> tuple[str, str]:
    name = name.strip()
    if not (_NAME_MIN <= len(name) <= _NAME_MAX):
        raise AppError(
            BLOCK_INVALID, f"块名称长度须在 {_NAME_MIN}–{_NAME_MAX} 字之间", status_code=400
        )
    if len(content) > _CONTENT_MAX:
        raise AppError(BLOCK_INVALID, f"块内容不能超过 {_CONTENT_MAX} 字（D8）", status_code=400)
    if kind == "blank":
        content = ""
    elif not content.strip():
        raise AppError(BLOCK_INVALID, "块内容不能为空", status_code=400)
    return name, content


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
    """整组替换块标签：摘除不在新集合的，挂上缺的；摘除后清理无引用标签。"""
    desired = _resolve_tags(conn, names)
    desired_ids = {t.id for t in desired}
    for current in tags_repo.tags_of_block(conn, block_id):
        if current.id not in desired_ids:
            tags_repo.detach_tag(conn, block_id, current.id)
    for tag in desired:
        tags_repo.attach_tag(conn, block_id, tag.id)
    tags_repo.prune_orphan_tags(conn)
    return tags_repo.tags_of_block(conn, block_id)


def _block_dict(b: Block, tags: list[Tag]) -> dict[str, object]:
    return {
        "id": b.id,
        "name": b.name,
        "content": b.content,
        "kind": b.kind,
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
    name, content = _validate(payload.name, payload.content, payload.kind)
    tag_names = _validate_tags(payload.tags)
    with get_conn() as conn:
        if (
            payload.template_id is not None
            and templates_repo.get_template(conn, payload.template_id) is None
        ):
            raise AppError(TEMPLATE_NOT_FOUND, "模板不存在", status_code=404)
        block = blocks_repo.create_block(conn, name, content, kind=payload.kind)
        tags = _replace_tags(conn, block.id, tag_names)
        if payload.template_id is not None:
            conn.execute(
                "INSERT INTO template_blocks (template_id, block_id) VALUES (?, ?)",
                (payload.template_id, block.id),
            )
    return _block_dict(block, tags)


@router.post("/blocks/{block_id}/templates/{template_id}")
def add_to_template(block_id: int, template_id: int) -> dict[str, int]:
    """Explicitly reuse an existing block identity in a template library (idempotent)."""
    with get_conn() as conn:
        if templates_repo.get_template(conn, template_id) is None:
            raise AppError(TEMPLATE_NOT_FOUND, "模板不存在", status_code=404)
        if blocks_repo.get_block(conn, block_id) is None:
            raise AppError(BLOCK_NOT_FOUND, "字符块不存在或已删除", status_code=404)
        conn.execute(
            "INSERT OR IGNORE INTO template_blocks (template_id, block_id) VALUES (?, ?)",
            (template_id, block_id),
        )
    return {"template_id": template_id, "block_id": block_id}


@router.get("/blocks")
def list_blocks(template_id: int | None = None, materials_only: bool = False) -> dict[str, object]:
    """块列表（存活块，排除软删除，更新时间倒序，含各自标签组）。"""
    with get_conn() as conn:
        items = [
            _block_dict(b, tags_repo.tags_of_block(conn, b.id))
            for b in blocks_repo.list_blocks(
                conn, template_id=template_id, materials_only=materials_only
            )
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


@router.get("/blocks/{block_id}/usage")
def block_usage(block_id: int) -> dict[str, object]:
    with get_conn() as conn:
        if blocks_repo.get_block(conn, block_id) is None:
            raise AppError(BLOCK_NOT_FOUND, "字符块不存在或已删除", 404)
        versions = [
            dict(row)
            for row in conn.execute(
                "SELECT v.id,v.name,t.filename AS template_name,COUNT(*) AS region_count "
                "FROM bindings b JOIN versions v ON v.id=b.version_id "
                "JOIN templates t ON t.id=v.template_id "
                "WHERE b.block_id=? AND b.status='active' GROUP BY v.id ORDER BY v.id",
                (block_id,),
            )
        ]
        templates = [
            dict(row)
            for row in conn.execute(
                "SELECT t.id,t.filename FROM template_blocks tb "
                "JOIN templates t ON t.id=tb.template_id "
                "WHERE tb.block_id=? ORDER BY t.id",
                (block_id,),
            )
        ]
    return {"versions": versions, "templates": templates}


@router.post("/blocks/{block_id}/versions/{version_id}/copy", status_code=201)
def edit_version_copy(block_id: int, version_id: int, payload: BlockUpdate) -> dict[str, object]:
    """Copy one shared asset and atomically rebind only the chosen version's references."""
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        block = blocks_repo.get_block(conn, block_id)
        if block is None:
            raise AppError(BLOCK_NOT_FOUND, "字符块不存在或已删除", 404)
        bindings = [
            b
            for b in bindings_repo.list_bindings(conn, version_id)
            if b.block_id == block_id and b.status == "active"
        ]
        if not bindings:
            raise AppError("BLOCK_NOT_BOUND", "当前版本未使用此块，请重新选择编辑范围", 409)
        name, content = _validate(
            payload.name if payload.name is not None else block.name,
            payload.content if payload.content is not None else block.content,
            payload.kind or block.kind,
        )
        created = blocks_repo.create_block(conn, name, content, kind=payload.kind or block.kind)
        tag_names = (
            payload.tags
            if payload.tags is not None
            else [tag.name for tag in tags_repo.tags_of_block(conn, block_id)]
        )
        tags = _replace_tags(conn, created.id, _validate_tags(tag_names))
        for binding in bindings:
            bindings_repo.upsert_binding(
                conn,
                version_id,
                binding.region_id,
                created.id,
                line_break_mode=binding.line_break_mode,
                position=binding.position,
            )
    return _block_dict(created, tags)


@router.put("/blocks/{block_id}")
def update_block(block_id: int, payload: BlockUpdate) -> dict[str, object]:
    """更新块（部分更新：仅传入字段生效；tags 传入即整组替换）。"""
    with get_conn() as conn:
        current = blocks_repo.get_block(conn, block_id)
        if current is None:
            raise AppError(
                BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404
            )
        name = content = None
        if payload.name is not None or payload.content is not None or payload.kind is not None:
            # 两字段任一传入即整体校验：以现值补齐未传字段，保证不变量仍成立
            name, content = _validate(
                payload.name if payload.name is not None else current.name,
                payload.content if payload.content is not None else current.content,
                payload.kind or current.kind,
            )
        updated = blocks_repo.update_block(
            conn, block_id, name=name, content=content, kind=payload.kind
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
    """软删除块（D11）：绑定同事务置 missing，标签关联清除 + 无引用标签自动清理。"""
    with get_conn() as conn:
        deleted = blocks_repo.soft_delete_block(conn, block_id)
        if deleted:
            tags_repo.prune_orphan_tags(conn)
    if not deleted:
        raise AppError(BLOCK_NOT_FOUND, f"字符块不存在或已删除（id={block_id}）", status_code=404)
    return Response(status_code=204)


class MaterialField(BaseModel):
    kind: Literal["region", "insertion"]
    version_id: int
    id: int


class ScopedMaterialEdit(BlockUpdate):
    action: Literal["update", "delete"] = "update"
    token: str
    selected: list[MaterialField] = []


@router.get("/blocks/{block_id}/references")
def material_references(block_id: int) -> dict[str, object]:
    from app.services.material_scope import references

    with get_conn() as conn:
        return references(conn, block_id)


@router.post("/blocks/{block_id}/scoped")
def scoped_material_edit(block_id: int, payload: ScopedMaterialEdit) -> dict[str, object]:
    from app.services.material_scope import apply_scope

    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        block = blocks_repo.get_block(conn, block_id)
        if block is None:
            raise AppError(BLOCK_NOT_FOUND, "素材不存在或已删除", 404)
        name, content = _validate(
            payload.name if payload.name is not None else block.name,
            payload.content if payload.content is not None else block.content,
            payload.kind or block.kind,
        )
        tag_names = _validate_tags(payload.tags) if payload.tags is not None else None
        apply_scope(
            conn,
            block_id,
            payload.token,
            [(f.kind, f.version_id, f.id) for f in payload.selected],
            deleting=payload.action == "delete",
            content_changed=content != block.content or (payload.kind or block.kind) != block.kind,
        )
        if payload.action == "delete":
            blocks_repo.soft_delete_block(conn, block_id)
            tags_repo.prune_orphan_tags(conn)
            return {"deleted": True}
        updated = blocks_repo.update_block(
            conn, block_id, name=name, content=content, kind=payload.kind
        )
        assert updated is not None
        tags = (
            _replace_tags(conn, block_id, tag_names)
            if tag_names is not None
            else tags_repo.tags_of_block(conn, block_id)
        )
        return _block_dict(updated, tags)


class FieldMaterialCreate(BlockCreate):
    idempotency_key: str | None = None
    line_break_mode: Literal["paragraph", "soft"] | None = None
    version_id: int
    field: MaterialField
    expected_content: str


@router.post("/blocks/from-field", status_code=201)
def material_from_field(payload: FieldMaterialCreate) -> dict[str, object]:
    """Validate source, create a new material and bind exactly one field in one transaction."""
    import json

    from app.core.config import settings
    from app.models.repositories import regions as regions_repo
    from app.models.repositories import versions as versions_repo
    from app.services.docx_parser import iter_flow_paragraphs
    from app.services.insertions import require_row

    name, content = _validate(payload.name, payload.content, payload.kind)
    tag_names = _validate_tags(payload.tags)
    request_hash = hashlib.sha256(
        json.dumps(payload.model_dump(exclude={"idempotency_key"}), sort_keys=True).encode()
    ).hexdigest()
    key = f"material:{payload.idempotency_key}" if payload.idempotency_key else None
    if key and len(key) > 120:
        raise AppError(BLOCK_INVALID, "提交标识过长", 400)
    with get_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if key:
            receipt = conn.execute(
                "SELECT request_sha256,response_json FROM migration_receipts "
                "WHERE idempotency_key=?",
                (key,),
            ).fetchone()
            if receipt is not None:
                if receipt[0] != request_hash:
                    raise AppError(
                        "MATERIAL_REQUEST_CONFLICT", "此操作已保存，请重新打开字段后再修改", 409
                    )
                result = _block_with_tags(conn, json.loads(receipt[1])["block_id"])
                if result is None:
                    raise AppError(
                        BLOCK_NOT_FOUND, "此前创建的素材已删除或撤销，重试不会重复创建", 410
                    )
                return result
        version = versions_repo.get_version(conn, payload.version_id)
        if version is None or payload.field.version_id != version.id:
            raise AppError("VERSION_NOT_FOUND", "文稿不存在或字段归属不正确", 404)
        current: str | None
        if payload.field.kind == "insertion":
            row = require_row(conn, version.id, payload.field.id)
            old = (
                blocks_repo.get_block(conn, row["block_id"])
                if row["block_id"] is not None and row["status"] == "active"
                else None
            )
            current = old.content if old else ""
        else:
            region = regions_repo.get_region(conn, payload.field.id)
            if (
                region is None
                or region.template_id != version.template_id
                or region.review_status == "excluded"
            ):
                raise AppError("REGION_TEMPLATE_MISMATCH", "区域不存在、不属于此文稿或已排除", 400)
            binding = bindings_repo.get_binding(conn, version.id, region.id)
            old = (
                blocks_repo.get_block(conn, binding.block_id)
                if binding and binding.status == "active"
                else None
            )
            tpl = templates_repo.get_template(conn, version.template_id)
            assert tpl is not None
            path = json.loads(region.anchor)["path"]
            current = (
                old.content
                if old
                else ""
                if binding and binding.missing_policy == "blank"
                else region.placeholder
            )
            if current is None:
                current = next(
                    (
                        text
                        for anchor, text in iter_flow_paragraphs(
                            (settings.templates_dir / tpl.storage_name).read_bytes()
                        )
                        if anchor["path"] == path
                    ),
                    "",
                )
        if current != payload.expected_content:
            raise AppError("REGION_TEXT_CONFLICT", "原文字已变化，请重新打开编辑后再设定素材", 409)
        block = blocks_repo.create_block(conn, name, content, kind=payload.kind)
        tags = _replace_tags(conn, block.id, tag_names)
        conn.execute(
            "INSERT OR IGNORE INTO template_blocks VALUES (?,?)", (version.template_id, block.id)
        )
        if payload.field.kind == "insertion":
            conn.execute(
                "UPDATE document_insertions SET block_id=?,status='active',"
                "line_break_mode=COALESCE(?,line_break_mode),updated_at=? WHERE id=?",
                (block.id, payload.line_break_mode, utcnow(), payload.field.id),
            )
        else:
            bindings_repo.upsert_binding(
                conn,
                version.id,
                payload.field.id,
                block.id,
                line_break_mode=payload.line_break_mode
                or (binding.line_break_mode if binding else "paragraph"),
                position=binding.position if binding else "inside",
            )
        if key:
            conn.execute(
                "INSERT INTO migration_receipts VALUES (?,?,?,?)",
                (key, request_hash, json.dumps({"block_id": block.id}), utcnow()),
            )
        return _block_dict(block, tags)
