"""templates / regions / versions repository 测试：指纹查重、文档流排序、版本唯一名。"""

import json

import pytest

from app.models.entities import Template
from app.models.repositories import regions, templates, versions


def _template(conn, *, sha: str = "a" * 64) -> Template:
    return templates.create_template(conn, "简历模板.docx", "1_简历模板.docx", sha)


def test_template_crud_and_sha_lookup(conn) -> None:
    """D10 地基：同内容重传按 sha256 命中同一记录；不同内容各归各。"""
    tpl = _template(conn)
    assert templates.find_by_sha256(conn, "a" * 64).id == tpl.id
    assert templates.find_by_sha256(conn, "b" * 64) is None

    got = templates.get_template(conn, tpl.id)
    assert got is not None and got.status == "parsing"  # 新上传默认解析中
    assert [t.id for t in templates.list_templates(conn)] == [tpl.id]


def test_template_status_update_and_validation(conn) -> None:
    """状态流转原语（状态机由 M3 驱动）+ 枚举校验。"""
    tpl = _template(conn)
    updated = templates.update_template(conn, tpl.id, status="pending_review")
    assert updated is not None and updated.status == "pending_review"

    ready = templates.update_template(conn, tpl.id, status="ready", filename="新名.docx")
    assert ready is not None and ready.status == "ready"
    assert ready.filename == "新名.docx"

    with pytest.raises(ValueError, match="非法模板状态"):
        templates.update_template(conn, tpl.id, status="bogus")
    with pytest.raises(ValueError, match="非法模板状态"):
        templates.create_template(conn, "x.docx", "9_x.docx", "c" * 64, status="bogus")
    assert templates.update_template(conn, 9999, status="ready") is None


def test_region_create_stores_anchor_json(conn) -> None:
    """anchor dict → JSON 文本落库；bbox/confidence 可空。"""
    tpl = _template(conn)
    anchor = {"paragraph_index": 7, "run_offsets": [0, 24]}
    region = regions.create_region(
        conn, tpl.id,
        region_type="name", label="姓名", placeholder="{{姓名}}",
        anchor=anchor, order_index=3,
    )
    assert region.template_id == tpl.id
    assert region.placeholder == "{{姓名}}"
    assert json.loads(region.anchor) == anchor
    assert region.bbox_json is None and region.confidence is None
    assert region.review_status == "pending"


def test_region_list_ordered_by_document_flow(conn) -> None:
    """list_regions 按文档流顺序返回（D7 跨模板迁移的匹配依据）。"""
    tpl = _template(conn)
    r_c = regions.create_region(conn, tpl.id, region_type="contact", label="联系方式",
                                anchor={"paragraph_index": 1}, order_index=1)
    r_n = regions.create_region(conn, tpl.id, region_type="name", label="姓名",
                                anchor={"paragraph_index": 0}, order_index=0)
    r_e = regions.create_region(conn, tpl.id, region_type="education", label="教育",
                                anchor={"paragraph_index": 5}, order_index=2)
    assert [r.id for r in regions.list_regions(conn, tpl.id)] == [r_n.id, r_c.id, r_e.id]


def test_region_update_and_validation(conn) -> None:
    tpl = _template(conn)
    region = regions.create_region(conn, tpl.id, region_type="custom", label="自定义",
                                   anchor={"paragraph_index": 2}, order_index=0)

    updated = regions.update_region(
        conn, region.id, region_type="work", label="工作经历",
        review_status="confirmed", bbox={"page": 1, "rect": [10, 20, 300, 60]},
    )
    assert updated is not None
    assert updated.type == "work"
    assert updated.review_status == "confirmed"
    assert json.loads(updated.bbox_json) == {"page": 1, "rect": [10, 20, 300, 60]}
    assert updated.anchor == region.anchor  # 未传字段不动

    with pytest.raises(ValueError, match="非法区域类型"):
        regions.create_region(conn, tpl.id, region_type="bogus", label="x",
                              anchor={}, order_index=9)
    with pytest.raises(ValueError, match="非法区域类型"):
        regions.update_region(conn, region.id, region_type="bogus")
    with pytest.raises(ValueError, match="非法校对状态"):
        regions.update_region(conn, region.id, review_status="bogus")
    assert regions.update_region(conn, 9999, label="x") is None


def test_version_crud_rename_and_scoping(conn) -> None:
    """版本名同模板内唯一；不同模板可同名。"""
    tpl_a = templates.create_template(conn, "a.docx", "1_a.docx", "a" * 64)
    tpl_b = templates.create_template(conn, "b.docx", "2_b.docx", "b" * 64)

    v1 = versions.create_version(conn, tpl_a.id, "通用版")
    versions.create_version(conn, tpl_b.id, "通用版")  # 跨模板同名合法

    assert [v.name for v in versions.list_versions(conn, tpl_a.id)] == ["通用版"]
    renamed = versions.rename_version(conn, v1.id, "投递阿里")
    assert renamed is not None and renamed.name == "投递阿里"
    assert versions.get_version(conn, 9999) is None
    assert versions.rename_version(conn, 9999, "x") is None
    assert versions.delete_version(conn, 9999) is False
