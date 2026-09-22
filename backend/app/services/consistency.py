"""一致性专项（里程碑 4）：预览 PDF vs 导出重转 PDF 逐页 diff。

口径（TODO 里程碑 4 + P9）：一致性指本产品预览 vs 导出（同一管线产物），
非 Word 原机效果。单管线铁律 + P24 确定性序列化下，导出 DOCX 与预览渲染
DOCX 字节相同 → sha 相同 → LO 缓存命中同一 PDF，理论强口径为字节级一致；
本模块实现内容级容差 diff 作兜底与初筛，用于：

- 自动化验收断言（tests/test_consistency.py 五类模板端到端）
- LO / 依赖升级后的回归初筛
- 真实模板人工比对的辅助工具（scripts/consistency_check.py）

diff 算法：行提取复用 extract_pdf_lines（P18 视觉行聚类内建，内容流
乱序无碍）；逐页独立比较——按文本分组配对，两侧数量一致时按位置就近
逐对比较，中心点位移超容差记 moved；a 有 b 无记 missing，b 有 a 无记
extra；页数不同时多出页整页记 missing/extra。
"""

from dataclasses import dataclass
from pathlib import Path

import pymupdf

from app.services.pdf_geometry import PdfLine, extract_pdf_lines

Bbox = tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class LineDiff:
    """单条行差异：kind ∈ missing（a 有 b 无）/ extra（b 有 a 无）/ moved（同文本位移超容差）。"""

    kind: str
    page: int
    text: str
    bbox_a: Bbox | None
    bbox_b: Bbox | None
    delta: float  # moved 的中心点位移（点）；missing/extra 恒 0.0

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "page": self.page,
            "text": self.text,
            "bbox_a": self.bbox_a,
            "bbox_b": self.bbox_b,
            "delta": self.delta,
        }


@dataclass(frozen=True, slots=True)
class DiffReport:
    """逐页 diff 报告：consistent = 页数一致且零行差异。"""

    pages_equal: bool
    page_count_a: int
    page_count_b: int
    diffs: list[LineDiff]
    coord_tol: float

    @property
    def consistent(self) -> bool:
        return self.pages_equal and not self.diffs

    def to_dict(self) -> dict[str, object]:
        return {
            "pages_equal": self.pages_equal,
            "page_count_a": self.page_count_a,
            "page_count_b": self.page_count_b,
            "coord_tol": self.coord_tol,
            "consistent": self.consistent,
            "diffs": [d.to_dict() for d in self.diffs],
        }


def _center(bbox: Bbox) -> tuple[float, float]:
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


def _page_count(pdf_path: str | Path) -> int:
    with pymupdf.open(pdf_path) as doc:
        return doc.page_count


def _by_page(lines: list[PdfLine]) -> dict[int, list[PdfLine]]:
    grouped: dict[int, list[PdfLine]] = {}
    for ln in lines:
        grouped.setdefault(ln.page, []).append(ln)
    return grouped


def _reading_order(line: PdfLine) -> tuple[float, float]:
    """行阅读顺序键：y0 再 x0（extract_pdf_lines 已按视觉行聚合）。"""
    return (line.bbox[1], line.bbox[0])


def _diff_page(lines_a: list[PdfLine], lines_b: list[PdfLine], coord_tol: float) -> list[LineDiff]:
    """同页行差异：按文本分组，就近配对比位移，余量记 missing/extra。"""
    by_text: dict[str, tuple[list[PdfLine], list[PdfLine]]] = {}
    for ln in lines_a:
        pair = by_text.setdefault(ln.text, ([], []))
        pair[0].append(ln)
    for ln in lines_b:
        pair = by_text.setdefault(ln.text, ([], []))
        pair[1].append(ln)

    diffs: list[LineDiff] = []
    for text, (a_lines, b_lines) in by_text.items():
        a_sorted = sorted(a_lines, key=_reading_order)
        b_sorted = sorted(b_lines, key=_reading_order)
        n = min(len(a_sorted), len(b_sorted))
        for la, lb in zip(a_sorted[:n], b_sorted[:n], strict=True):
            (ax, ay), (bx, by) = _center(la.bbox), _center(lb.bbox)
            delta = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
            if delta > coord_tol:
                diffs.append(LineDiff("moved", la.page, text, la.bbox, lb.bbox, round(delta, 2)))
        for la in a_sorted[n:]:
            diffs.append(LineDiff("missing", la.page, text, la.bbox, None, 0.0))
        for lb in b_sorted[n:]:
            diffs.append(LineDiff("extra", lb.page, text, None, lb.bbox, 0.0))
    return diffs


def diff_pdfs(pdf_a: str | Path, pdf_b: str | Path, coord_tol: float = 1.0) -> DiffReport:
    """逐页文本+坐标 diff 两个 PDF（容差内视为一致，默认 1.0 点）。"""
    pages_a, pages_b = _page_count(pdf_a), _page_count(pdf_b)
    by_page_a = _by_page(extract_pdf_lines(pdf_a))
    by_page_b = _by_page(extract_pdf_lines(pdf_b))

    diffs: list[LineDiff] = []
    common = min(pages_a, pages_b)
    for page in range(common):
        diffs.extend(_diff_page(by_page_a.get(page, []), by_page_b.get(page, []), coord_tol))
    for page in range(common, pages_a):
        for ln in sorted(by_page_a.get(page, []), key=_reading_order):
            diffs.append(LineDiff("missing", page, ln.text, ln.bbox, None, 0.0))
    for page in range(common, pages_b):
        for ln in sorted(by_page_b.get(page, []), key=_reading_order):
            diffs.append(LineDiff("extra", page, ln.text, None, ln.bbox, 0.0))
    diffs.sort(key=lambda d: (d.page, d.kind, d.text))
    return DiffReport(
        pages_equal=pages_a == pages_b,
        page_count_a=pages_a,
        page_count_b=pages_b,
        diffs=diffs,
        coord_tol=coord_tol,
    )
