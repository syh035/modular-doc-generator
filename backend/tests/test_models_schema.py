"""schema 层测试：建表幂等、约束（FK / CASCADE / UNIQUE / RESTRICT）由 SQLite 兜底。"""

import sqlite3

import pytest

from app.models.db import get_conn, init_db
from app.models.repositories import bindings, blocks, regions, templates, versions

ALL_TABLES = {"blocks", "tags", "block_tags", "templates", "regions", "versions", "bindings"}
_TS = ("2026-01-01T00:00:00.000000Z",)  # 裸 INSERT 用的占位时间戳


def _table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {r["name"] for r in rows}


def test_init_db_idempotent() -> None:
    """重复初始化不报错、不产生重复表（启动即建库，幂等是前提）。"""
    with get_conn(":memory:") as conn:
        init_db(conn)
        init_db(conn)
        assert ALL_TABLES <= _table_names(conn)


def test_foreign_keys_enforced(conn: sqlite3.Connection) -> None:
    """foreign_keys=ON 生效：引用不存在的块挂标签必须被拒。"""
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO block_tags (block_id, tag_id) VALUES (999, 999)")


def test_unique_tag_name(conn: sqlite3.Connection) -> None:
    from app.models.repositories import tags

    tags.create_tag(conn, "后端")
    with pytest.raises(sqlite3.IntegrityError):
        tags.create_tag(conn, "后端")


def test_unique_template_sha256(conn: sqlite3.Connection) -> None:
    templates.create_template(conn, "a.docx", "1_a.docx", "f" * 64)
    with pytest.raises(sqlite3.IntegrityError):
        templates.create_template(conn, "b.docx", "2_b.docx", "f" * 64)


def test_unique_version_name_within_template(conn: sqlite3.Connection) -> None:
    tpl = templates.create_template(conn, "a.docx", "1_a.docx", "a" * 64)
    versions.create_version(conn, tpl.id, "投递A")
    with pytest.raises(sqlite3.IntegrityError):
        versions.create_version(conn, tpl.id, "投递A")


def test_unique_binding_per_region(conn: sqlite3.Connection) -> None:
    """假设①：一区域一版本只绑一块——直接 INSERT 第二条必须被 UNIQUE 拒绝。"""
    tpl = templates.create_template(conn, "a.docx", "1_a.docx", "a" * 64)
    region = regions.create_region(
        conn, tpl.id, region_type="name", label="姓名", anchor={"paragraph_index": 0}, order_index=0
    )
    ver = versions.create_version(conn, tpl.id, "v1")
    b1 = blocks.create_block(conn, "块1", "内容1")
    b2 = blocks.create_block(conn, "块2", "内容2")
    bindings.upsert_binding(conn, ver.id, region.id, b1.id)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO bindings (version_id, region_id, block_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (ver.id, region.id, b2.id, *_TS * 2),
        )


def test_cascade_delete_template(conn: sqlite3.Connection) -> None:
    """删模板 → 区域/版本/绑定全级联清空（换模板不留孤儿数据）。"""
    tpl = templates.create_template(conn, "a.docx", "1_a.docx", "a" * 64)
    region = regions.create_region(
        conn, tpl.id, region_type="name", label="姓名", anchor={"paragraph_index": 0}, order_index=0
    )
    ver = versions.create_version(conn, tpl.id, "v1")
    block = blocks.create_block(conn, "块", "内容")
    bindings.upsert_binding(conn, ver.id, region.id, block.id)

    conn.execute("DELETE FROM templates WHERE id = ?", (tpl.id,))

    assert regions.get_region(conn, region.id) is None
    assert versions.get_version(conn, ver.id) is None
    assert bindings.get_binding(conn, ver.id, region.id) is None
    assert blocks.get_block(conn, block.id) is not None  # 块是资产，不受模板删除影响


def test_physical_delete_block_restricted_by_binding(conn: sqlite3.Connection) -> None:
    """bindings.block_id 无 CASCADE：被引用的块禁止物理删除（防悬空，块只走软删除）。"""
    tpl = templates.create_template(conn, "a.docx", "1_a.docx", "a" * 64)
    region = regions.create_region(
        conn, tpl.id, region_type="name", label="姓名", anchor={"paragraph_index": 0}, order_index=0
    )
    ver = versions.create_version(conn, tpl.id, "v1")
    block = blocks.create_block(conn, "块", "内容")
    bindings.upsert_binding(conn, ver.id, region.id, block.id)

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM blocks WHERE id = ?", (block.id,))
