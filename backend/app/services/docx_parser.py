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
from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO
from typing import cast

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


def iter_flow_paragraphs(data: bytes) -> Iterator[tuple[dict[str, object], str]]:
    """按文档流顺序枚举 DOCX 全部正文段落（含表格单元格与嵌套表格）。

    每项 yield (anchor, 合并 run 后的段落全文)。anchor 编码与
    parse_placeholders 完全一致（P3，重放规则见其文档字符串）——
    M4 渲染位置匹配以此遍历为单一事实源，保证锚点与解析同源。
    """
    body = Document(BytesIO(data)).element.body

    def paragraph_text(p: etree._Element) -> str:
        # 只拼直接子 w:r 的 w:t 文本（P1 合并 run；D6 天然排除文本框内文字）
        return "".join(t.text or "" for t in p.findall(f"{_W}r/{_W}t"))

    def scan_table(tbl: etree._Element, path: list[int]) -> Iterator[tuple[dict[str, object], str]]:
        for row_idx, tr in enumerate(tbl.findall(f"{_W}tr")):
            for cell_idx, tc in enumerate(tr.findall(f"{_W}tc")):
                # 单元格内段落与嵌套表格各自独立计数（path 重放的依据）
                para_idx = 0
                nested_idx = 0
                for child in tc.iterchildren():
                    if child.tag == f"{_W}p":
                        yield (
                            {
                                "kind": "cell_p",
                                "path": [*path, row_idx, cell_idx, para_idx],
                            },
                            paragraph_text(child),
                        )
                        para_idx += 1
                    elif child.tag == f"{_W}tbl":
                        yield from scan_table(child, [*path, row_idx, cell_idx, nested_idx])
                        nested_idx += 1

    for block_idx, child in enumerate(body.iterchildren()):
        if child.tag == f"{_W}p":
            yield {"kind": "p", "path": [block_idx]}, paragraph_text(child)
        elif child.tag == f"{_W}tbl":
            yield from scan_table(child, [block_idx])


def parse_placeholders(data: bytes) -> list[ParsedRegion]:
    """解析 DOCX bytes，按文档流顺序返回全部占位符区域。

    anchor.path 编码（P3，供后续模块重放定位元素）：
    - 段落：[block] —— body 第 block 个直接子元素即该 w:p
    - 单元格段落：[tbl, row, cell, para] —— body 第 tbl 个直接子元素是
      w:tbl → 第 row 个 w:tr → 第 cell 个 w:tc → 格内第 para 个直接子 w:p
    - 嵌套表格：每深入一层表格追加三元组 (tbl, row, cell)，末位仍是 para
    """
    regions: list[ParsedRegion] = []
    order = 0
    for anchor, text in iter_flow_paragraphs(data):
        for m in _PLACEHOLDER_RE.finditer(text):
            regions.append(
                ParsedRegion(
                    placeholder=m.group(0),
                    label=m.group(1),
                    anchor={
                        "kind": anchor["kind"],
                        "path": list(cast("list[int]", anchor["path"])),
                    },
                    order_index=order,
                )
            )
            order += 1
    return regions
