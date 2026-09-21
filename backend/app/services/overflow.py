"""溢出测量（M7，D4/P6）：替换后区域高度对比 + 固定行高裁剪检测。

- 高度对比法：原 bbox（模板渲染落库 regions.bbox）vs 替换后 bbox
  （版本渲染现算），ratio = (new_h − orig_h) / orig_h；按 D4 阈值
  （settings.overflow_threshold）分级——ratio > 阈值 = large，否则
  small；ratio ≤ 0（未溢出）不出报告
- P6：区域位于 w:trHeight hRule="exact" 固定行高行内时，内容不顺延
  重排而被裁剪——bbox 不长高，高度对比法失效；改用文本完整性比对
  （块内容行在成品 PDF 中缺失 → clipped），clipped 一律按 large 级警示
- 纯函数无 LO 依赖；真实渲染链路见 test_overflow.py 端到端
"""

import json
from dataclasses import dataclass
from io import BytesIO

from docx import Document
from lxml import etree

from app.services.docx_parser import iter_flow_paragraph_elements
from app.services.pdf_geometry import PdfLine, normalize_text

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

LEVEL_LARGE = "large"
LEVEL_SMALL = "small"


@dataclass(frozen=True, slots=True)
class OverflowInfo:
    """单区域溢出报告（overlay 响应 overflow 字段的结构）。"""

    orig_height: float  # 模板原 bbox 高（PDF 点）
    new_height: float  # 替换后 bbox 高（PDF 点）
    ratio: float  # (new − orig) / orig，>0 溢出
    level: str  # small / large（clipped 强制 large）
    clipped: bool  # P6：固定行高裁剪（内容缺失）
    fixed_row: bool  # 区域位于 hRule="exact" 行内

    def to_dict(self) -> dict[str, object]:
        return {
            "orig_height": self.orig_height,
            "new_height": self.new_height,
            "ratio": self.ratio,
            "level": self.level,
            "clipped": self.clipped,
            "fixed_row": self.fixed_row,
        }


def measure_overflow(
    orig_bbox: dict[str, object] | None,
    new_bbox: tuple[float, float, float, float] | None,
    threshold: float,
    *,
    fixed_row: bool = False,
    clipped: bool = False,
) -> OverflowInfo | None:
    """高度对比分级；不可测（缺 bbox / 原高非正）或未溢出未裁剪 → None。

    D4 边界：ratio 恰等于阈值属小超出（仅 ratio > threshold 为大超出）。
    """
    if orig_bbox is None or new_bbox is None:
        return None
    y0 = orig_bbox.get("y0")
    y1 = orig_bbox.get("y1")
    if not isinstance(y0, (int, float)) or not isinstance(y1, (int, float)):
        return None
    orig_h = float(y1) - float(y0)
    if orig_h <= 0:
        return None
    new_h = new_bbox[3] - new_bbox[1]
    ratio = (new_h - orig_h) / orig_h
    if ratio <= 0 and not clipped:
        return None
    level = LEVEL_LARGE if (clipped or ratio > threshold) else LEVEL_SMALL
    return OverflowInfo(
        orig_height=round(orig_h, 2),
        new_height=round(new_h, 2),
        ratio=round(ratio, 4),
        level=level,
        clipped=clipped,
        fixed_row=fixed_row,
    )


def detect_fixed_rows(docx_bytes: bytes, region_paths: dict[int, list[int]]) -> set[int]:
    """检测区域是否位于固定行高行（w:trPr/w:trHeight hRule="exact"，P6）。

    替换引擎不改动表格结构，成品与模板行高设置一致，直接在成品字节上
    检测（与 region_paths 同源）。取段落最近包裹的 w:tr（嵌套表格场景）；
    hRule 缺省/ATLEAST/auto 均可顺延增长，不算固定行高。
    """
    if not region_paths:
        return set()
    doc = Document(BytesIO(docx_bytes))
    path_to_el: dict[tuple[int, ...], etree._Element] = {}
    for anchor, el in iter_flow_paragraph_elements(doc.element.body):
        path = anchor["path"]
        assert isinstance(path, list)
        path_to_el[tuple(path)] = el
    fixed: set[int] = set()
    for region_id, path in region_paths.items():
        el = path_to_el.get(tuple(path))
        if el is not None and _in_exact_row(el):
            fixed.add(region_id)
    return fixed


def _in_exact_row(el: etree._Element) -> bool:
    """段落向上找最近包裹 w:tr，读其 trHeight 的 hRule 是否为 exact。"""
    parent = el.getparent()
    while parent is not None:
        if parent.tag == f"{_W}tr":
            tr_pr = parent.find(f"{_W}trPr")
            if tr_pr is not None:
                height = tr_pr.find(f"{_W}trHeight")
                if height is not None and height.get(f"{_W}hRule") == "exact":
                    return True
            return False
        parent = parent.getparent()
    return False


def detect_clipped(
    pdf_lines: list[PdfLine],
    block_contents: dict[int, str],
    fixed_region_ids: set[int],
) -> set[int]:
    """固定行高区域裁剪判定：块内容任一非空行在成品 PDF 全文中缺失。

    归一化口径与几何对齐一致（连字展开/空白全剔除），全文拼接做子串
    匹配——折行不断开子串；内容行恰好出现在文档他处属可容忍误报
    （启发式兜底，v1 已知局限）。
    """
    if not fixed_region_ids:
        return set()
    pdf_text = "".join(normalize_text(ln.text) for ln in pdf_lines)
    clipped: set[int] = set()
    for region_id in fixed_region_ids:
        content = block_contents.get(region_id)
        if content is None:
            continue
        for line in content.split("\n"):
            norm = normalize_text(line)
            if norm and norm not in pdf_text:
                clipped.add(region_id)
                break
    return clipped


def overflow_from_json(orig_bbox_json: str | None) -> dict[str, object] | None:
    """regions.bbox_json（JSON 文本）→ bbox dict；空值容错。"""
    if not orig_bbox_json:
        return None
    try:
        parsed = json.loads(orig_bbox_json)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None
