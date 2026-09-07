"""tags / block_tags repository 测试：重命名全库生效、联结操作幂等。"""

import sqlite3

import pytest

from app.models.repositories import blocks, tags


def test_tag_crud_and_lookup(conn) -> None:
    tag = tags.create_tag(conn, "后端")
    assert tags.get_tag(conn, tag.id) == tag
    assert tags.get_tag_by_name(conn, "后端").id == tag.id
    assert [t.name for t in tags.list_tags(conn)] == ["后端"]
    assert tags.get_tag_by_name(conn, "不存在") is None


def test_rename_propagates_via_join(conn) -> None:
    """重命名就地改 tags.name——联结表存 id，块上的标签视图自动生效。"""
    block = blocks.create_block(conn, "块", "内容")
    tag = tags.create_tag(conn, "后端")
    tags.attach_tag(conn, block.id, tag.id)

    renamed = tags.rename_tag(conn, tag.id, "服务端")
    assert renamed is not None and renamed.name == "服务端"
    assert [t.name for t in tags.tags_of_block(conn, block.id)] == ["服务端"]


def test_rename_to_existing_name_rejected(conn) -> None:
    """重命名撞已有标签名 → UNIQUE 拒绝（合并语义由 M2 service 层实现）。"""
    tags.create_tag(conn, "后端")
    tag = tags.create_tag(conn, "前端")
    with pytest.raises(sqlite3.IntegrityError):
        tags.rename_tag(conn, tag.id, "后端")


def test_attach_idempotent_and_detach(conn) -> None:
    block = blocks.create_block(conn, "块", "内容")
    t1 = tags.create_tag(conn, "标签1")
    t2 = tags.create_tag(conn, "标签2")

    tags.attach_tag(conn, block.id, t1.id)
    tags.attach_tag(conn, block.id, t1.id)  # 重复挂：幂等不报错
    tags.attach_tag(conn, block.id, t2.id)
    assert [t.name for t in tags.tags_of_block(conn, block.id)] == ["标签1", "标签2"]

    tags.detach_tag(conn, block.id, t1.id)
    tags.detach_tag(conn, block.id, t1.id)  # 重复摘：静默
    assert [t.name for t in tags.tags_of_block(conn, block.id)] == ["标签2"]


def test_delete_tag_cleans_join_rows(conn) -> None:
    """物理删标签 → 联结行 CASCADE 清理，块本身不受影响。"""
    block = blocks.create_block(conn, "块", "内容")
    tag = tags.create_tag(conn, "后端")
    tags.attach_tag(conn, block.id, tag.id)

    assert tags.delete_tag(conn, tag.id) is True
    assert tags.get_tag(conn, tag.id) is None
    assert tags.tags_of_block(conn, block.id) == []
    assert blocks.get_block(conn, block.id) is not None
    assert tags.delete_tag(conn, tag.id) is False  # 重复删 False
