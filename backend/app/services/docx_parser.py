"""占位符解析（D3 主路径）：从 DOCX 正文提取 `{{字段名}}` 可替换区域。

陷阱与决策落地：
- P1：Word 常把 `{{姓名}}` 拆成多个 run（`{{姓` + `名}}`）——必须段落内
  合并全部 run 文本后再匹配，禁止按 run 直读
- D6：v1 只扫 body 段落与表格单元格（含嵌套表格）；页眉页脚在独立
  header/footer part 中、文本框文字藏在 w:r/w:pict 深处——只取 w:p
  直接子 w:r 的 w:t 文本，两者天然落在解析范围外
- P3：区域身份锚定文档流元素——anchor.path 记录从 body 出发的定位
  路径（重放规则见 parse_placeholders 文档），order_index 为文档流顺序
"""

import re
from dataclasses import dataclass
from io import BytesIO

from docx import Document
from lxml import etree

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# `{{字段名}}`：容忍字段名首尾空白；字段名内不允许花括号（防嵌套误吞）
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


@dataclass(frozen=True, slots=True)
class ParsedRegion:
    """占位符解析产物（type 恒为 custom，字段名词表启发式属 M3b）。"""

    placeholder: str  # 占位符原文，如 "{{姓名}}"
    label: str  # 显示名（字段名），如 "姓名"
    anchor: dict[str, object]  # 文档流锚点：{"kind": "p"|"cell_p", "path": [...]}
    order_index: int  # 文档流出现顺序（D7 迁移匹配依据）


def parse_placeholders(data: bytes) -> list[ParsedRegion]:
    """解析 DOCX bytes，按文档流顺序返回全部占位符区域。

    anchor.path 编码（P3，供后续模块重放定位元素）：
    - 段落：[block] —— body 第 block 个直接子元素即该 w:p
    - 单元格段落：[tbl, row, cell, para] —— body 第 tbl 个直接子元素是
      w:tbl → 第 row 个 w:tr → 第 cell 个 w:tc → 格内第 para 个直接子 w:p
    - 嵌套表格：每深入一层表格追加三元组 (tbl, row, cell)，末位仍是 para
    """
    body = Document(BytesIO(data)).element.body
    regions: list[ParsedRegion] = []
    order = 0

    def scan_paragraph(p: etree._Element, path: list[int]) -> None:
        nonlocal order
        # 只拼直接子 w:r 的 w:t 文本（P1 合并 run；D6 天然排除文本框内文字）
        text = "".join(t.text or "" for t in p.findall(f"{_W}r/{_W}t"))
        for m in _PLACEHOLDER_RE.finditer(text):
            regions.append(
                ParsedRegion(
                    placeholder=m.group(0),
                    label=m.group(1),
                    anchor={
                        "kind": "p" if len(path) == 1 else "cell_p",
                        "path": list(path),
                    },
                    order_index=order,
                )
            )
            order += 1

    def scan_table(tbl: etree._Element, path: list[int]) -> None:
        for row_idx, tr in enumerate(tbl.findall(f"{_W}tr")):
            for cell_idx, tc in enumerate(tr.findall(f"{_W}tc")):
                # 单元格内段落与嵌套表格各自独立计数（path 重放的依据）
                para_idx = 0
                nested_idx = 0
                for child in tc.iterchildren():
                    if child.tag == f"{_W}p":
                        scan_paragraph(child, [*path, row_idx, cell_idx, para_idx])
                        para_idx += 1
                    elif child.tag == f"{_W}tbl":
                        scan_table(child, [*path, row_idx, cell_idx, nested_idx])
                        nested_idx += 1

    for block_idx, child in enumerate(body.iterchildren()):
        if child.tag == f"{_W}p":
            scan_paragraph(child, [block_idx])
        elif child.tag == f"{_W}tbl":
            scan_table(child, [block_idx])

    return regions
