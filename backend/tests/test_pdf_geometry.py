"""pdf_geometry 单测：归一化、顺序对齐（折行/污染行/跨段）、真实 PDF 提取。"""

from pathlib import Path

import pymupdf

from app.services.pdf_geometry import (
    PdfLine,
    align_flow_to_lines,
    extract_pdf_lines,
    normalize_text,
)


def line(page: int, text: str, bbox: tuple[float, float, float, float]) -> PdfLine:
    return PdfLine(page, text, bbox)


def flow_item(path: list[int], text: str, kind: str = "p") -> tuple[dict[str, object], str]:
    return {"kind": kind, "path": path}, text


# ---- 归一化 ----


def test_normalize_strips_whitespace_and_ligatures() -> None:
    assert normalize_text(" 张 三 \n 的 简 历 ") == "张三的简历"
    assert normalize_text("ﬁle ﬂow") == "fileflow"  # 连字展开
    assert normalize_text("软回\u00ad行") == "软回行"  # 软连字符剔除
    assert normalize_text("  ") == ""  # 全空白 → 空


# ---- 对齐 ----


def test_single_line_paragraph_match() -> None:
    lines = [line(0, "张三的简历", (50, 60, 200, 80)), line(0, "电话：13800", (50, 90, 200, 110))]
    flow = [flow_item([0], "张三的简历"), flow_item([1], "电话：13800")]
    geo = align_flow_to_lines(flow, lines)
    assert geo[(0,)].bbox == (50, 60, 200, 80)
    assert geo[(0,)].page == 0
    assert geo[(1,)].bbox == (50, 90, 200, 110)


def test_wrapped_paragraph_union_bbox() -> None:
    """折行段落：消耗连续多行，bbox 取并集。"""
    lines = [
        line(0, "这是第一行很长", (50, 60, 300, 80)),
        line(0, "折到第二行了", (60, 90, 290, 110)),
    ]
    flow = [flow_item([0], "这是第一行很长 折到第二行了")]
    geo = align_flow_to_lines(flow, lines)
    assert geo[(0,)].bbox == (50, 60, 300, 110)
    assert geo[(0,)].line_count == 2


def test_contamination_lines_skipped_by_lookahead() -> None:
    """页眉/页码等污染行：段落起点可在窗口内后移跳过。"""
    lines = [
        line(0, "第 1 页", (400, 30, 550, 45)),  # 页脚污染行
        line(0, "正文段落甲", (50, 60, 200, 80)),
        line(0, "正文段落乙", (50, 90, 200, 110)),
    ]
    flow = [flow_item([0], "正文段落甲"), flow_item([1], "正文段落乙")]
    geo = align_flow_to_lines(flow, lines)
    assert (0,) in geo and (1,) in geo
    assert geo[(1,)].bbox == (50, 90, 200, 110)


def test_unmatched_paragraph_skipped() -> None:
    """DOCX 多出段落（如隐藏文字）：跳过且不影响后续段落匹配。"""
    lines = [
        line(0, "可见段落", (50, 60, 200, 80)),
        line(0, "下一段", (50, 90, 200, 110)),
    ]
    flow = [
        flow_item([0], "隐藏文字不会出现"),
        flow_item([1], "可见段落"),
        flow_item([2], "下一段"),
    ]
    geo = align_flow_to_lines(flow, lines)
    assert (0,) not in geo  # 未匹配不出现在结果
    assert geo[(1,)].bbox == (50, 60, 200, 80)
    assert geo[(2,)].bbox == (50, 90, 200, 110)


def test_paragraph_ends_mid_line() -> None:
    """段落止于行中（同行尾随他文，如同格内制表位文本）。"""
    lines = [line(0, "短段落尾巴文本", (50, 60, 300, 80))]
    flow = [flow_item([0], "短段落")]
    geo = align_flow_to_lines(flow, lines)
    assert geo[(0,)].bbox == (50, 60, 300, 80)


def test_empty_flow_paragraphs_ignored() -> None:
    lines = [line(0, "唯一", (50, 60, 100, 80))]
    flow = [flow_item([0], ""), flow_item([1], "  \n "), flow_item([2], "唯一")]
    geo = align_flow_to_lines(flow, lines)
    assert set(geo) == {(2,)}


def test_multipage_lines_page_numbered() -> None:
    lines = [
        line(0, "第一页行", (50, 60, 200, 80)),
        line(1, "第二页行", (50, 60, 200, 80)),
    ]
    flow = [flow_item([0], "第一页行"), flow_item([1], "第二页行")]
    geo = align_flow_to_lines(flow, lines)
    assert geo[(0,)].page == 0
    assert geo[(1,)].page == 1


# ---- 真实 PDF 提取（pymupdf 构造，无 LO 依赖）----


def test_extract_pdf_lines_from_generated_pdf(tmp_path: Path) -> None:
    pdf = tmp_path / "g.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    # china-s：pymupdf 内置简体中文字体（默认 helv 无 CJK 字形）
    page.insert_text((72, 100), "张三的简历", fontname="china-s")
    page.insert_text((72, 130), "电话：{{手机号}}", fontname="china-s")
    doc.save(pdf)
    doc.close()

    lines = extract_pdf_lines(pdf)
    texts = [ln.text.strip() for ln in lines]
    assert "张三的简历" in texts
    assert any("{{手机号}}" in t for t in texts)
    geo = align_flow_to_lines(
        [flow_item([0], "张三的简历"), flow_item([1], "电话：{{手机号}}")],
        lines,
    )
    assert geo[(0,)].page == 0
    assert geo[(0,)].bbox[3] < geo[(1,)].bbox[1]  # 上行底边在下行顶边之上
    assert 0 < geo[(1,)].bbox[0] < 200  # 合理横坐标（PDF 点）
