"""blocks repository 测试：CRUD、软删除可见性、删块→绑定置 missing 的原子性。"""

from pathlib import Path

import pytest

from app.models.db import get_conn, init_db
from app.models.repositories import bindings, blocks, regions, templates, versions


def _full_fixture(conn) -> tuple[int, int, int, int]:
    """最小闭环数据：模板+区域+版本+两块+绑定。

    返回 (block_id, version_id, region_id, block2_id)。
    """
    tpl = templates.create_template(conn, "t.docx", "1_t.docx", "a" * 64)
    region = regions.create_region(
        conn, tpl.id, region_type="name", label="姓名", anchor={"paragraph_index": 3}, order_index=0
    )
    ver = versions.create_version(conn, tpl.id, "v1")
    block = blocks.create_block(conn, "姓名块", "张三")
    block2 = blocks.create_block(conn, "备选块", "李四")
    bindings.upsert_binding(conn, ver.id, region.id, block.id)
    return block.id, ver.id, region.id, block2.id


def test_crud_roundtrip(conn) -> None:
    """创建 → 读取 → 更新 → 列表，字段完整往返。"""
    block = blocks.create_block(conn, "自我介绍", "五年后端经验")
    assert block.id > 0
    assert block.deleted_at is None

    got = blocks.get_block(conn, block.id)
    assert got is not None
    assert got.name == "自我介绍"
    assert got.content == "五年后端经验"

    updated = blocks.update_block(conn, block.id, name="自我介绍 v2", content="六年经验")
    assert updated is not None
    assert updated.name == "自我介绍 v2"
    assert updated.content == "六年经验"
    assert updated.updated_at >= got.updated_at  # 定长时间戳，字典序即时间序


def test_list_filters(conn) -> None:
    """列表默认排除软删除行；平铺按更新时间倒序（最近编辑在前）。"""
    b1 = blocks.create_block(conn, "块1", "内容1")
    b2 = blocks.create_block(conn, "块2", "内容2")
    assert [b.id for b in blocks.list_blocks(conn)] == [b2.id, b1.id]  # 后创建的在前

    blocks.update_block(conn, b1.id, content="内容1改")  # b1 更新时间最新 → 回到最前
    assert [b.id for b in blocks.list_blocks(conn)] == [b1.id, b2.id]

    blocks.soft_delete_block(conn, b1.id)
    assert [b.id for b in blocks.list_blocks(conn)] == [b2.id]
    assert [b.id for b in blocks.list_blocks(conn, include_deleted=True)] == [b1.id, b2.id]


def test_update_missing_or_deleted_returns_none(conn) -> None:
    block = blocks.create_block(conn, "块", "内容")
    assert blocks.update_block(conn, 9999, name="x") is None
    blocks.soft_delete_block(conn, block.id)
    assert blocks.update_block(conn, block.id, name="x") is None  # 已删块不可更新


def test_soft_delete_marks_bindings_missing(conn) -> None:
    """D11：软删除块 → 其绑定降级为 missing，导出侧据此留空并提示。"""
    block_id, ver_id, region_id, _ = _full_fixture(conn)
    assert bindings.get_binding(conn, ver_id, region_id).status == "active"

    assert blocks.soft_delete_block(conn, block_id) is True
    binding = bindings.get_binding(conn, ver_id, region_id)
    assert binding.status == "missing"
    assert binding.block_id == block_id  # 记录保留，可追溯是哪个块缺失


def test_soft_delete_idempotent(conn) -> None:
    block_id, _, _, _ = _full_fixture(conn)
    assert blocks.soft_delete_block(conn, block_id) is True
    assert blocks.soft_delete_block(conn, block_id) is False  # 重复删返回 False


def test_soft_delete_atomic_rollback(tmp_path: Path) -> None:
    """原子性验证：软删除事务中途失败 → 块未删除、绑定仍 active，两者同生同灭。"""
    db = tmp_path / "atomic.db"
    # 事务1：建库 + 造数据（正常提交）
    with get_conn(db) as conn:
        init_db(conn)
        block_id, ver_id, region_id, _ = _full_fixture(conn)

    # 事务2：软删除后中途失败 → 整体回滚
    with pytest.raises(RuntimeError):
        with get_conn(db) as conn:
            blocks.soft_delete_block(conn, block_id)
            raise RuntimeError("模拟事务中途失败")

    # 事务3：验证块未删、绑定仍 active（两条 UPDATE 同事务回滚）
    with get_conn(db) as conn:
        block = blocks.get_block(conn, block_id, include_deleted=True)
        assert block is not None and block.deleted_at is None
        assert bindings.get_binding(conn, ver_id, region_id).status == "active"


def test_upsert_binding_resets_missing_to_active(conn) -> None:
    """missing 后重新换绑 → 新绑定恢复 active（补位修复路径）。"""
    block_id, ver_id, region_id, block2_id = _full_fixture(conn)
    blocks.soft_delete_block(conn, block_id)
    assert bindings.get_binding(conn, ver_id, region_id).status == "missing"

    rebound = bindings.upsert_binding(conn, ver_id, region_id, block2_id)
    assert rebound.status == "active"
    assert rebound.block_id == block2_id
    assert len(bindings.list_bindings(conn, ver_id)) == 1  # 换绑不产生重复行
