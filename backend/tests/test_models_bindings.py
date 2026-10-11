"""bindings repository 测试：upsert 语义、列表含 missing、区域删除级联。"""

import sqlite3

from app.models.repositories import bindings, blocks, regions, templates, versions


def _setup(conn: sqlite3.Connection) -> tuple[int, int, int, int, int]:
    """模板 + 两区域 + 版本 + 两块，返回 (ver_id, region1_id, region2_id, block1_id, block2_id)。"""
    tpl = templates.create_template(conn, "t.docx", "1_t.docx", "a" * 64)
    r1 = regions.create_region(
        conn, tpl.id, region_type="name", label="姓名", anchor={"paragraph_index": 0}, order_index=0
    )
    r2 = regions.create_region(
        conn,
        tpl.id,
        region_type="objective",
        label="求职意向",
        anchor={"paragraph_index": 4},
        order_index=1,
    )
    ver = versions.create_version(conn, tpl.id, "v1")
    b1 = blocks.create_block(conn, "姓名块", "张三")
    b2 = blocks.create_block(conn, "意向块", "寻求后端岗位")
    return ver.id, r1.id, r2.id, b1.id, b2.id


def test_upsert_creates_and_rebinds(conn: sqlite3.Connection) -> None:
    """首次绑定为 active；换绑覆盖 block_id 且仍只有一行。"""
    ver_id, r1_id, _, b1_id, b2_id = _setup(conn)

    binding = bindings.upsert_binding(conn, ver_id, r1_id, b1_id)
    assert binding.status == "active" and binding.block_id == b1_id

    rebound = bindings.upsert_binding(conn, ver_id, r1_id, b2_id)
    assert rebound.block_id == b2_id
    found_1 = bindings.get_binding(conn, ver_id, r1_id)
    assert found_1 is not None
    assert found_1.id == binding.id  # 同一行被更新
    assert len(bindings.list_bindings(conn, ver_id)) == 1


def test_list_bindings_includes_missing(conn: sqlite3.Connection) -> None:
    """列表不滤 missing：导出时需对缺失绑定留空并提示（D11 消费口径）。"""
    ver_id, r1_id, r2_id, b1_id, b2_id = _setup(conn)
    bindings.upsert_binding(conn, ver_id, r1_id, b1_id)
    bindings.upsert_binding(conn, ver_id, r2_id, b2_id)

    blocks.soft_delete_block(conn, b1_id)  # 联动置 missing（blocks 侧已详测，此处验证列表口径）
    all_bindings = bindings.list_bindings(conn, ver_id)
    assert len(all_bindings) == 2
    assert {b.status for b in all_bindings} == {"active", "missing"}
    found_2 = bindings.get_binding(conn, ver_id, r1_id)
    assert found_2 is not None
    assert found_2.status == "missing"


def test_delete_region_cascades_binding(conn: sqlite3.Connection) -> None:
    """删区域 → 该区域绑定连带删除；其他区域绑定不受影响。"""
    ver_id, r1_id, r2_id, b1_id, b2_id = _setup(conn)
    bindings.upsert_binding(conn, ver_id, r1_id, b1_id)
    bindings.upsert_binding(conn, ver_id, r2_id, b2_id)

    assert regions.delete_region(conn, r1_id) is True
    assert bindings.get_binding(conn, ver_id, r1_id) is None
    assert bindings.get_binding(conn, ver_id, r2_id) is not None
    assert regions.delete_region(conn, r1_id) is False  # 重复删 False


def test_get_binding_absent(conn: sqlite3.Connection) -> None:
    ver_id, r1_id, _, _, _ = _setup(conn)
    assert bindings.get_binding(conn, ver_id, r1_id) is None
    assert bindings.list_bindings(conn, ver_id) == []


def test_legacy_binding_membership_backfill_is_idempotent(conn: sqlite3.Connection) -> None:
    from app.models.db import init_db

    template = templates.create_template(conn, "legacy.docx", "legacy.docx", "legacy-sha")
    version = versions.create_version(conn, template.id, "legacy")
    region = regions.create_region(
        conn,
        template.id,
        region_type="name",
        label="姓名",
        anchor={"paragraph_index": 0},
        order_index=0,
    )
    block = blocks.create_block(conn, "历史块", "历史内容")
    bindings.upsert_binding(conn, version.id, region.id, block.id)
    conn.execute("DELETE FROM template_blocks")
    init_db(conn)
    init_db(conn)
    assert [item.id for item in blocks.list_blocks(conn, template_id=template.id)] == [block.id]
