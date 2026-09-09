"""docx_parser 单测：P1 run 合并、表格/嵌套表格、D6 页眉页脚与文本框跳过。"""

from io import BytesIO

from docx import Document
from lxml import etree

from app.services.docx_parser import iter_flow_paragraphs, parse_placeholders

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_V_NS = "urn:schemas-microsoft-com:vml"


def docx_bytes(doc: Document) -> bytes:
    """Document → bytes（内存序列化）。"""
    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---- 构造辅助 ----


def build_simple_doc() -> Document:
    doc = Document()
    doc.add_paragraph("{{姓名}}")
    return doc


def build_split_run_doc() -> Document:
    """P1 核心场景：`{{姓名}}` 被拆成多个 run。"""
    doc = Document()
    p = doc.add_paragraph()
    p.add_run("{{姓")
    p.add_run("名")
    p.add_run("}}")
    return doc


def build_multi_placeholder_doc() -> Document:
    doc = Document()
    doc.add_paragraph("{{姓名}}，电话{{电话}}")
    doc.add_paragraph("{{ 自我评价 }}")
    return doc


def build_table_doc() -> Document:
    doc = Document()
    doc.add_paragraph("正文占位 {{姓名}}")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "{{电话}}"
    table.cell(1, 1).text = "{{邮箱}}"
    return doc


def build_nested_table_doc() -> Document:
    doc = Document()
    table = doc.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    cell.text = "外层"
    nested = cell.add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "{{嵌套}}"
    return doc


def build_textbox_doc() -> Document:
    """D6：文本框内占位符不纳入解析范围。"""
    doc = Document()
    p = doc.add_paragraph()
    pict_run = etree.fromstring(
        f'<w:r xmlns:w="{_W_NS}">'
        f'<w:pict><v:shape xmlns:v="{_V_NS}">'
        "<v:textbox><w:txbxContent>"
        "<w:p><w:r><w:t>{{文本框占位}}</w:t></w:r></w:p>"
        "</w:txbxContent></v:textbox></v:shape></w:pict></w:r>"
    )
    p._p.append(pict_run)
    doc.add_paragraph("{{正常区域}}")
    return doc


def build_header_doc() -> Document:
    """D6：页眉中的占位符不纳入解析范围（页眉在独立 header part）。"""
    doc = Document()
    doc.sections[0].header.paragraphs[0].text = "{{页眉占位}}"
    doc.add_paragraph("{{正文区域}}")
    return doc


# ---- 测试 ----


def test_simple_placeholder() -> None:
    regions = parse_placeholders(docx_bytes(build_simple_doc()))
    assert len(regions) == 1
    r = regions[0]
    assert r.placeholder == "{{姓名}}"
    assert r.label == "姓名"
    assert r.anchor["kind"] == "p"
    assert len(r.anchor["path"]) == 1  # type: ignore[arg-type]
    assert r.order_index == 0


def test_split_run_merged() -> None:
    """P1：跨 run 拆分的占位符必须能合并识别。"""
    regions = parse_placeholders(docx_bytes(build_split_run_doc()))
    assert len(regions) == 1
    assert regions[0].label == "姓名"


def test_multiple_placeholders_and_trim() -> None:
    regions = parse_placeholders(docx_bytes(build_multi_placeholder_doc()))
    assert [r.label for r in regions] == ["姓名", "电话", "自我评价"]
    assert [r.order_index for r in regions] == [0, 1, 2]


def test_table_cells_parsed() -> None:
    regions = parse_placeholders(docx_bytes(build_table_doc()))
    labels = [r.label for r in regions]
    assert labels == ["姓名", "电话", "邮箱"]
    # 表格区域锚点：[tbl, row, cell, para]，row/cell/para 从 0 起
    phone, mail = regions[1], regions[2]
    assert phone.anchor["kind"] == "cell_p"
    assert phone.anchor["path"] == [phone.anchor["path"][0], 0, 0, 0]  # type: ignore[index]
    assert mail.anchor["path"] == [mail.anchor["path"][0], 1, 1, 0]  # type: ignore[index]


def test_nested_table_parsed() -> None:
    regions = parse_placeholders(docx_bytes(build_nested_table_doc()))
    assert len(regions) == 1
    r = regions[0]
    assert r.label == "嵌套"
    # 嵌套路径：[tbl, row, cell, nested_tbl, row, cell, para] 共 7 位
    path = r.anchor["path"]
    assert isinstance(path, list) and len(path) == 7  # type: ignore[arg-type]


def test_textbox_skipped() -> None:
    """D6：文本框内占位符不识别，只识别正文段落。"""
    regions = parse_placeholders(docx_bytes(build_textbox_doc()))
    assert [r.label for r in regions] == ["正常区域"]


def test_header_skipped() -> None:
    """D6：页眉占位符不识别，只识别正文段落。"""
    regions = parse_placeholders(docx_bytes(build_header_doc()))
    assert [r.label for r in regions] == ["正文区域"]


def test_no_placeholder_returns_empty() -> None:
    doc = Document()
    doc.add_paragraph("普通文本段落，没有占位符")
    doc.add_paragraph("另一个 { 单花括号 } 也不是")
    assert parse_placeholders(docx_bytes(doc)) == []


def test_malformed_braces_not_matched() -> None:
    doc = Document()
    doc.add_paragraph("{{{三重}}}、{{}}、}{反向} 都不算占位符")
    regions = parse_placeholders(docx_bytes(doc))
    # "{{{三重}}}" 中 "{{三重}}" 会被宽匹配到（畸形输入的容错行为，可接受），
    # 但 "{{}}"（空名）与反向必须不产出
    labels = [r.label for r in regions]
    assert "" not in labels
    assert "}" not in labels


# ---- iter_flow_paragraphs（M4 匹配数据源，与解析同源）----


def test_flow_enumerates_all_paragraphs_in_order() -> None:
    """文档流全序枚举：无占位符段落也在列，顺序 = 解析顺序。"""
    doc = Document()
    doc.add_paragraph("标题")
    doc.add_paragraph("电话：{{手机号}}")
    doc.add_paragraph("")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "{{教育}}"
    table.cell(0, 1).text = "格内普通段"
    doc.add_paragraph("结尾")

    flow = list(iter_flow_paragraphs(docx_bytes(doc)))
    texts = [t for _, t in flow]
    assert texts == ["标题", "电话：{{手机号}}", "", "{{教育}}", "格内普通段", "结尾"]
    kinds = [a["kind"] for a, _ in flow]
    assert kinds == ["p", "p", "p", "cell_p", "cell_p", "p"]


def test_flow_anchors_match_parse_placeholders() -> None:
    """锚点一致性：占位符区域的 anchor 必能在文档流枚举中找到同 path 同文本。"""
    doc = build_table_doc()
    data = docx_bytes(doc)
    flow = list(iter_flow_paragraphs(data))
    for region in parse_placeholders(data):
        path = region.anchor["path"]
        matches = [
            t
            for a, t in flow
            if a["path"] == path and a["kind"] == region.anchor["kind"]
        ]
        assert len(matches) == 1
        assert region.placeholder in matches[0]


def test_flow_nested_table_paths() -> None:
    """嵌套表格路径编码：外层段 → 嵌套段 → 尾空段（OOXML 要求 tc 以 p 结尾，
    python-docx 的 add_table 会自动补尾部空段，占外层 cell 的 para_idx=1）。"""
    flow = list(iter_flow_paragraphs(docx_bytes(build_nested_table_doc())))
    assert [a["kind"] for a, _ in flow] == ["cell_p", "cell_p", "cell_p"]
    assert [t for _, t in flow] == ["外层", "{{嵌套}}", ""]
    nested_path = flow[1][0]["path"]
    assert isinstance(nested_path, list)
    assert len(nested_path) == 7  # [tbl,row,cell, nested_tbl,row,cell, para]
    assert flow[2][0]["path"] == [0, 0, 0, 1]  # 尾空段：外层 cell 第 2 个段落
