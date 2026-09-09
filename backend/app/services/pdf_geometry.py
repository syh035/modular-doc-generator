"""渲染位置几何（M4）：PDF 文本行坐标提取 + DOCX 文档流↔PDF 位置对齐。

用途：为 M3a 锚定的文档流区域（anchor.path）计算渲染后的页面 bbox，
供 M5a 预览覆盖层展示与 M7 溢出测量使用。坐标仅在展示/测量层使用，
区域身份仍锚定文档流元素（P3 铁律）。

匹配策略——顺序对齐：
- LibreOffice 导出 PDF 时按文档流顺序写入内容流，PyMuPDF 依序读出的
  文本行与 DOCX 文档流段落顺序天然对应（多栏/表格亦是定位排版）
- 每个非空 DOCX 段落消耗连续 1..N 个 PDF 行（自动换段折行），
  段落 bbox = 所耗行 bbox 的并集
- 页眉页脚/页码等污染行：允许在段落起点前向后看 LOOKAHEAD 行跳过
- 对不上的段落（如隐藏文字）直接跳过，对应区域 bbox 保持 None，
  交给 M5b 校对流程人工兜底
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pymupdf

# 连字（ﬁ 等）归一 + 软连字符剔除：LibreOffice 渲染与 DOCX 原文间的
# 唯一常规字形差异；空白全剔除以容忍 PDF 内部断词与两端对齐拉伸
_LIGATURES = str.maketrans(
    {
        "\ufb00": "ff",
        "\ufb01": "fi",
        "\ufb02": "fl",
        "\ufb03": "ffi",
        "\ufb04": "ffl",
        "\u00ad": "",  # soft hyphen
        "\u00a0": " ",  # nbsp → 常规空格（随空白一并剔除）
    }
)

_LOOKAHEAD = 15  # 段落起点允许跳过的污染行数上限（页眉/页脚/页码）


@dataclass(frozen=True, slots=True)
class PdfLine:
    """单个 PDF 文本行：0 基页码 + 原文 + bbox（PDF 点，原点左上）。"""

    page: int
    text: str
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class RegionGeometry:
    """一个文档流段落的渲染几何：bbox 为所匹配行并集。

    注：段落跨页折行时 bbox 取并集、页码取首行所在页（简历场景罕见，
    v1 已知局限，M5b 校对可人工修正）。
    """

    page: int
    bbox: tuple[float, float, float, float]
    line_count: int


def normalize_text(s: str) -> str:
    """匹配用归一化：连字展开、软连字符剔除、全部空白剔除。"""
    return re.sub(r"\s+", "", s.translate(_LIGATURES))


def extract_pdf_lines(pdf_path: str | Path) -> list[PdfLine]:
    """按视觉阅读顺序提取全部文本行（页面升序、页内依块序、块内按行聚类）。

    P18：真 CJK 字体下 LO 写内容流会把同一视觉行拆成多个乱序行片段
    （如「张/三的/简历」），块序仍是文档流序——故块内按 y 重叠聚类成
    视觉行（容差 50%，容忍基线抖动），行内按 x 升序还原阅读顺序。
    """
    lines: list[PdfLine] = []
    with pymupdf.open(pdf_path) as doc:
        for page_no, page in enumerate(doc):
            for block in page.get_text("dict")["blocks"]:
                if block.get("type") != 0:  # 只要文本块（跳过图片）
                    continue
                block_lines = [
                    PdfLine(
                        page_no,
                        "".join(span["text"] for span in line["spans"]),
                        cast(
                            "tuple[float, float, float, float]", tuple(line["bbox"])
                        ),
                    )
                    for line in block["lines"]
                    if "".join(span["text"] for span in line["spans"]).strip()
                ]
                lines.extend(_visual_rows(block_lines))
    return lines


def _visual_rows(block_lines: list[PdfLine]) -> list[PdfLine]:
    """块内行片段 → 视觉阅读序：y 重叠过半聚为一行，行内按 x 排序。"""
    rows: list[list[PdfLine]] = []
    for ln in sorted(block_lines, key=lambda r: r.bbox[1]):
        if rows:
            ry0 = min(r.bbox[1] for r in rows[-1])
            ry1 = max(r.bbox[3] for r in rows[-1])
            overlap = min(ry1, ln.bbox[3]) - max(ry0, ln.bbox[1])
            min_h = min(ry1 - ry0, ln.bbox[3] - ln.bbox[1])
            if min_h > 0 and overlap / min_h >= 0.5:
                rows[-1].append(ln)
                continue
        rows.append([ln])
    return [ln for row in rows for ln in sorted(row, key=lambda r: r.bbox[0])]


def _match_lines_at(
    pdf_lines: list[PdfLine], start: int, target: str
) -> tuple[list[PdfLine], int] | None:
    """尝试从 pdf_lines[start] 起连续消费若干行拼出 target（已归一）。

    成功返回 (命中行列表, 消费行数)；行文本与剩余目标互为前缀即续接。
    """
    remaining = target
    hits: list[PdfLine] = []
    k = start
    while k < len(pdf_lines) and remaining:
        norm = normalize_text(pdf_lines[k].text)
        if not norm:  # 纯空白/符号行：不占目标文本，跳过
            k += 1
            continue
        if remaining.startswith(norm):
            hits.append(pdf_lines[k])
            remaining = remaining[len(norm) :]
            k += 1
        elif norm.startswith(remaining):  # 段落止于行中（同行尾随他文）
            hits.append(pdf_lines[k])
            remaining = ""
            k += 1
        else:
            return None
    return (hits, k - start) if not remaining else None


def align_flow_to_lines(
    flow: list[tuple[dict[str, object], str]], pdf_lines: list[PdfLine]
) -> dict[tuple[int, ...], RegionGeometry]:
    """文档流段落 ↔ PDF 行顺序对齐，返回 anchor.path 元组 → 渲染几何。

    flow 来自 docx_parser.iter_flow_paragraphs（文档流全序）；
    未匹配段落不出现在结果中（调用方保持 bbox=None）。
    """
    result: dict[tuple[int, ...], RegionGeometry] = {}
    pi = 0
    for anchor, text in flow:
        target = normalize_text(text)
        if not target:
            continue
        path = anchor["path"]
        assert isinstance(path, list)
        match: tuple[list[PdfLine], int] | None = None
        for j in range(pi, min(pi + _LOOKAHEAD + 1, len(pdf_lines))):
            match = _match_lines_at(pdf_lines, j, target)
            if match is not None:
                break
        if match is None:
            continue  # 未匹配：跳过该段落，PDF 指针不动
        hits, consumed = match
        assert consumed > 0
        pi = j + consumed
        x0 = min(ln.bbox[0] for ln in hits)
        y0 = min(ln.bbox[1] for ln in hits)
        x1 = max(ln.bbox[2] for ln in hits)
        y1 = max(ln.bbox[3] for ln in hits)
        result[tuple(path)] = RegionGeometry(hits[0].page, (x0, y0, x1, y1), consumed)
    return result
