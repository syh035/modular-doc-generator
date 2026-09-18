"""字段名词表单测（M3b）：标题/labeled 形态、最长匹配优先、大小写、边界。"""

import pytest

from app.services.field_lexicon import (
    CONF_LABELED,
    CONF_TITLE,
    classify_field,
    classify_paragraph,
    truncate_label,
)


def test_title_form() -> None:
    hit = classify_paragraph("工作经历")
    assert hit is not None
    assert hit.region_type == "work"
    assert hit.confidence == CONF_TITLE
    assert hit.is_title is True


def test_labeled_form() -> None:
    hit = classify_paragraph("姓名：张三")
    assert hit is not None
    assert hit.region_type == "name"
    assert hit.confidence == CONF_LABELED
    assert hit.is_title is False
    assert hit.term == "姓名"


def test_labeled_halfwidth_colon_and_spaces() -> None:
    hit = classify_paragraph("Email: a@b.com")
    assert hit is not None
    assert hit.region_type == "contact"
    assert hit.term == "Email"


def test_longest_term_wins() -> None:
    """「求职意向岗位」不得被「求职意向」截断。"""
    hit = classify_paragraph("求职意向岗位：算法工程师")
    assert hit is not None
    assert hit.region_type == "objective"
    assert hit.term == "求职意向岗位"


def test_case_insensitive_english() -> None:
    assert classify_paragraph("email") is not None
    assert classify_paragraph("PHONE") is not None


def test_labeled_requires_value_after_colon() -> None:
    """「姓名：」冒号后无值 → 不算 labeled（该段落回成段/忽略逻辑）。"""
    assert classify_paragraph("姓名：") is None


def test_no_match_short_text() -> None:
    assert classify_paragraph("张三") is None


def test_no_match_long_prose() -> None:
    """成段正文不属于词表匹配范畴（返回 None 由调用方落成段候选）。"""
    assert classify_paragraph("这是一个足够长的正文段落" * 10) is None


@pytest.mark.parametrize("text", ["", "   "])
def test_blank_returns_none(text: str) -> None:
    assert classify_paragraph(text) is None


def test_classify_field_placeholder_label() -> None:
    """决策 C：占位符字段名整段匹配词表。"""
    assert classify_field("姓名") == "name"
    assert classify_field("教育经历") == "education"
    assert classify_field("自定义字段") is None
    assert classify_field("") is None


def test_truncate_label() -> None:
    assert truncate_label("短文本") == "短文本"
    long = "一" * 20
    assert truncate_label(long) == "一" * 12 + "…"
