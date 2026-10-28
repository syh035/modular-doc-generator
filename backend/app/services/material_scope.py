"""Explicit live-reference selection. Independent copies are never matched by equal text."""

import hashlib
import json
import sqlite3

from app.core.errors import AppError
from app.models.db import utcnow
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import tags as tags_repo


def references(conn: sqlite3.Connection, block_id: int) -> dict[str, object]:
    block = blocks_repo.get_block(conn, block_id)
    if block is None:
        raise AppError("BLOCK_NOT_FOUND", "素材不存在或已删除", 404)
    fields = [
        dict(row)
        for row in conn.execute(
            "SELECT 'region' AS kind,b.region_id AS id,b.version_id,v.name AS document_name,"
            "t.filename AS template_name,r.label,b.updated_at FROM bindings b "
            "JOIN versions v ON v.id=b.version_id JOIN templates t ON t.id=v.template_id "
            "JOIN regions r ON r.id=b.region_id WHERE b.block_id=? AND b.status='active' "
            "AND NOT EXISTS (SELECT 1 FROM version_region_actions a JOIN regions x ON "
            "x.id=a.region_id "
            "WHERE a.version_id=b.version_id AND "
            "json_extract(x.anchor,'$.path')=json_extract(r.anchor,'$.path')) "
            "ORDER BY b.version_id,b.region_id",
            (block_id,),
        )
    ]
    fields.extend(
        dict(row)
        for row in conn.execute(
            "SELECT 'insertion' AS kind,i.id,i.version_id,v.name AS document_name,"
            "t.filename AS template_name,'插入行 '||i.id AS label,i.updated_at "
            "FROM document_insertions i JOIN versions v ON v.id=i.version_id "
            "JOIN templates t ON t.id=v.template_id WHERE i.block_id=? AND i.status='active' "
            "ORDER BY i.version_id,i.id",
            (block_id,),
        )
    )
    token = hashlib.sha256(
        json.dumps([block.updated_at, block.content, block.kind, fields], sort_keys=True).encode()
    ).hexdigest()
    return {"fields": fields, "token": token}


def apply_scope(
    conn: sqlite3.Connection,
    block_id: int,
    token: str,
    selected: list[tuple[str, int, int]],
    *,
    deleting: bool,
    content_changed: bool,
) -> None:
    current = references(conn, block_id)
    if token != current["token"]:
        raise AppError("MATERIAL_SCOPE_STALE", "素材或引用已变化，请重新核对影响范围", 409)
    fields = current["fields"]
    assert isinstance(fields, list)
    available = {(f["kind"], f["version_id"], f["id"]) for f in fields}
    chosen = set(selected)
    if len(chosen) != len(selected) or not chosen <= available:
        raise AppError("MATERIAL_SCOPE_INVALID", "同步范围包含已改变或不属于此素材的字段", 400)
    if not deleting and not content_changed:
        return
    block = blocks_repo.get_block(conn, block_id)
    assert block is not None
    preserved = available - chosen
    # Removed paragraphs keep their text on restore,
    # but are not offered as sync targets.
    all_regions = {
        (b.version_id, b.region_id)
        for row in conn.execute(
            "SELECT DISTINCT version_id FROM bindings WHERE block_id=?", (block_id,)
        )
        for b in bindings_repo.list_bindings(conn, row[0])
        if b.block_id == block_id and b.status == "active"
    }
    preserved |= {("region", v, r) for v, r in all_regions} - chosen
    copy = None
    if preserved:
        copy = blocks_repo.create_block(
            conn, block.name, block.content, kind=block.kind, material=False
        )
        for tag in tags_repo.tags_of_block(conn, block_id):
            tags_repo.attach_tag(conn, copy.id, tag.id)
    now = utcnow()
    for kind, version_id, identity in preserved:
        assert copy is not None
        if kind == "region":
            conn.execute(
                "UPDATE bindings SET block_id=?,updated_at=? WHERE version_id=? AND region_id=?",
                (copy.id, now, version_id, identity),
            )
            conn.execute(
                "INSERT OR IGNORE INTO template_blocks SELECT template_id,? FROM versions "
                "WHERE id=?",
                (copy.id, version_id),
            )
        else:
            conn.execute(
                "UPDATE document_insertions SET block_id=?,updated_at=? WHERE id=? AND "
                "version_id=?",
                (copy.id, now, identity, version_id),
            )
    if deleting:
        for kind, version_id, identity in chosen:
            if kind == "region":
                conn.execute(
                    "UPDATE bindings SET status='missing',missing_policy='blank',updated_at=? "
                    "WHERE version_id=? AND region_id=?",
                    (now, version_id, identity),
                )
            else:
                conn.execute(
                    "UPDATE document_insertions SET status='missing',updated_at=? WHERE id=? "
                    "AND version_id=?",
                    (now, identity, version_id),
                )
