"""Version-owned rows. Stable database IDs, separate from template region bindings."""

import json
import sqlite3
from dataclasses import asdict

from app.core.errors import AppError
from app.models.db import utcnow
from app.models.entities import Binding, Block, Region
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import regions as regions_repo
from app.models.repositories import versions as versions_repo


def require_row(conn: sqlite3.Connection, version_id: int, row_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM document_insertions WHERE id=? AND version_id=?", (row_id, version_id)
    ).fetchone()
    if row is None:
        raise AppError("INSERTION_NOT_FOUND", "插入行不存在或不属于此文稿", 404)
    return row


def create(
    conn: sqlite3.Connection, version_id: int, kind: str, identity: int, side: str
) -> dict[str, object]:
    version = versions_repo.get_version(conn, version_id)
    if version is None:
        raise AppError("VERSION_NOT_FOUND", "文稿不存在", 404)
    if kind == "region":
        region = regions_repo.get_region(conn, identity)
        if region is None or region.template_id != version.template_id:
            raise AppError("REGION_TEMPLATE_MISMATCH", "区域不属于此文稿", 400)
        removed = conn.execute(
            "SELECT 1 FROM version_region_actions WHERE version_id=? AND region_id=?",
            (version_id, identity),
        ).fetchone()
        if removed:
            raise AppError("INSERTION_ANCHOR_REMOVED", "请先恢复原段落再插入", 409)
        source_id = identity
        rank = (
            0
            if side == "before"
            else conn.execute(
                "SELECT COALESCE(MAX(rank),-1)+1 FROM document_insertions WHERE version_id=? "
                "AND source_region_id=? AND side=?",
                (version_id, source_id, side),
            ).fetchone()[0]
        )
        # Before an original paragraph means adjacent to it, after all existing before rows.
        if side == "before":
            rank = conn.execute(
                "SELECT COALESCE(MAX(rank),-1)+1 FROM document_insertions WHERE version_id=? "
                "AND source_region_id=? AND side=?",
                (version_id, source_id, side),
            ).fetchone()[0]
    else:
        target = require_row(conn, version_id, identity)
        source_id, rank = target["source_region_id"], target["rank"] + (side == "after")
        side = target["side"]
        conn.execute(
            "UPDATE document_insertions SET rank=rank+1 WHERE version_id=? AND "
            "source_region_id=? AND side=? AND rank>=?",
            (version_id, source_id, side, rank),
        )
    now = utcnow()
    cursor = conn.execute(
        "INSERT INTO document_insertions "
        "(version_id,source_region_id,side,rank,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        (version_id, source_id, side, rank, now, now),
    )
    assert cursor.lastrowid is not None
    return dict(require_row(conn, version_id, cursor.lastrowid))


def update(
    conn: sqlite3.Connection,
    version_id: int,
    row_id: int,
    *,
    content: str | None,
    block_id: int | None,
    unbind: bool,
    line_break_mode: str | None,
    expected_content: str | None,
) -> dict[str, object]:
    row = require_row(conn, version_id, row_id)
    original = (
        blocks_repo.get_block(conn, row["block_id"])
        if row["block_id"] is not None and row["status"] == "active"
        else None
    )
    current_text = original.content if original else ""
    if expected_content is not None and current_text != expected_content:
        raise AppError("REGION_TEXT_CONFLICT", "文字已变化，请重新打开后编辑", 409)
    chosen = row["block_id"]
    if content is not None:
        if len(content) > 5000:
            raise AppError("BLOCK_INVALID", "内容不能超过 5000 字", 400)
        if content != current_text or row["status"] == "missing":
            chosen = blocks_repo.create_block(
                conn,
                f"插入行 {row_id}",
                content,
                kind="text" if content.strip() else "blank",
                material=False,
            ).id
    elif block_id is not None:
        if blocks_repo.get_block(conn, block_id) is None:
            raise AppError("BLOCK_NOT_FOUND", "素材不存在或已删除", 404)
        chosen = block_id
    elif unbind:
        # Detach a material while preserving this row's visible text.
        chosen = blocks_repo.create_block(
            conn,
            f"插入行 {row_id}",
            current_text,
            kind="text" if current_text.strip() else "blank",
            material=False,
        ).id
    if chosen is not None:
        conn.execute(
            "INSERT OR IGNORE INTO template_blocks SELECT template_id,? FROM versions WHERE id=?",
            (chosen, version_id),
        )
    conn.execute(
        "UPDATE document_insertions SET "
        "block_id=?,status='active',line_break_mode=?,updated_at=? WHERE id=?",
        (chosen, line_break_mode or row["line_break_mode"], utcnow(), row_id),
    )
    return dict(require_row(conn, version_id, row_id))


def render_rows(
    conn: sqlite3.Connection, version_id: int
) -> tuple[list[Region], list[Binding], dict[int, Block]]:
    regions: list[Region] = []
    bindings: list[Binding] = []
    blocks: dict[int, Block] = {}
    for row in conn.execute(
        "SELECT * FROM document_insertions WHERE version_id=? ORDER BY "
        "source_region_id,side,rank,id",
        (version_id,),
    ):
        source = regions_repo.get_region(conn, row["source_region_id"])
        if source is None:
            raise AppError("INSERTION_ANCHOR_MISSING", "插入行的原段落不存在，请先处理插入行", 409)
        anchor = json.loads(source.anchor)
        anchor.update(
            insertion_id=row["id"], side=row["side"], rank=row["rank"], source_region_id=source.id
        )
        # Negative IDs are private to the shared renderer; public identity is field_ref {kind,id}.
        identity = -row["id"]
        regions.append(
            Region(
                **{
                    **asdict(source),
                    "id": identity,
                    "label": f"插入行 {row['id']}",
                    "placeholder": None,
                    "anchor": json.dumps(anchor),
                    "type": "custom",
                    "bbox_source": "auto",
                    "review_status": "confirmed",
                }
            )
        )
        if row["block_id"] is not None:
            block = blocks_repo.get_block(conn, row["block_id"], include_deleted=True)
            if block is not None:
                blocks[block.id] = block
            bindings.append(
                Binding(
                    id=identity,
                    version_id=version_id,
                    region_id=identity,
                    block_id=row["block_id"],
                    status=row["status"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    line_break_mode=row["line_break_mode"],
                    missing_policy="blank",
                )
            )
    return regions, bindings, blocks


def copy_rows(conn: sqlite3.Connection, source_id: int, target_id: int) -> None:
    conn.execute(
        "INSERT INTO document_insertions "
        "(version_id,source_region_id,side,rank,block_id,status,line_break_mode,"
        "created_at,updated_at) "
        "SELECT "
        "?,source_region_id,side,rank,block_id,status,line_break_mode,created_at,updated_at "
        "FROM document_insertions WHERE version_id=?",
        (target_id, source_id),
    )
