"""内容替换引擎（M6a，PRD 4.4）：绑定块内容 → 成品 DOCX。

- P1/P5：占位符可能被 Word 拆进多个 run——按段落合并文本定位区间，
  新文本由占位符首覆盖 run 承载（继承区域首 run 属性，定稿规则）
- D8/D9：块内容为多行纯文本；换行渲染默认换段——首行留原占位符位，
  后续行克隆段落追加（含段落属性，P4 剥离编号属性防 1. 2. 2. 3.）
- 稳定性：先按 anchor 解析出全部目标段落元素引用再替换（lxml 引用
  在插入兄弟后仍有效）；替换后重新枚举文档流得到 region → 新 path
  映射，供渲染几何对齐（与 M4 同源，P3）
- 未绑定区域原样保留占位符文本（M9 导出同规则）
"""

import copy
import json
from dataclasses import dataclass
from io import BytesIO

from docx import Document
from lxml import etree

from app.models.entities import Region
from app.services.docx_parser import iter_flow_paragraph_elements

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


@dataclass(frozen=True, slots=True)
class ReplacementOutcome:
    """替换产物：成品 DOCX 字节 + 区域 → 成品文档流 path 映射。"""

    data: bytes
    # region_id → 首行段落的新文档流 path（多行克隆会推挤后续段落索引，
    # 故必须以替换后重新枚举的结果为准）；anchor 失配的区域不出现在映射中
    region_paths: dict[int, list[int]]


def _resolve_paragraph(body: etree._Element, anchor: dict[str, object]) -> etree._Element | None:
    """按 anchor path 重放定位段落元素（编码规则见 docx_parser）。

    重放索引口径与 iter_flow_paragraph_elements 严格一致：tr/tc 用
    findall 过滤计数；格内 w:p / w:tbl 用 iterchildren 按序计数。
    文档与库不一致（索引越界 / tag 不符）返回 None，调用方跳过该区域。
    """
    path = anchor.get("path")
    assert isinstance(path, list)
    children = list(body.iterchildren())
    kind = anchor.get("kind")

    def _at(items: list[etree._Element], idx: int) -> etree._Element | None:
        return items[idx] if 0 <= idx < len(items) else None

    if kind == "p":
        p_el = _at(children, path[0]) if len(path) == 1 else None
        return p_el if p_el is not None and p_el.tag == f"{_W}p" else None

    if kind != "cell_p" or len(path) < 4:
        return None
    # cell_p：[tbl, (row, cell)+ 层级三元组…, para]，末位恒为 para
    tbl = _at(children, path[0])
    if tbl is None or tbl.tag != f"{_W}tbl":
        return None
    el: etree._Element | None = tbl
    i = 1
    while el is not None:
        assert isinstance(el, etree._Element)
        trs = el.findall(f"{_W}tr")
        tr = _at(trs, path[i]) if i < len(path) else None
        if tr is None:
            return None
        tcs = tr.findall(f"{_W}tc")
        tc = _at(tcs, path[i + 1]) if i + 1 < len(path) else None
        if tc is None:
            return None
        i += 2
        if i == len(path) - 1:
            paras = [c for c in tc.iterchildren() if c.tag == f"{_W}p"]
            return _at(paras, path[i])
        tbls = [c for c in tc.iterchildren() if c.tag == f"{_W}tbl"]
        el = _at(tbls, path[i])
        i += 1
    return None


def _run_text(run: etree._Element) -> str:
    """run 的合并文本（与 docx_parser 同口径：仅直接子 w:t）。"""
    return "".join(t.text or "" for t in run.findall(f"{_W}t"))


def _set_run_text(run: etree._Element, text: str) -> None:
    """重写 run 文本：删除全部直接子 w:t，写回单个 w:t（保留 rPr）。"""
    for t in run.findall(f"{_W}t"):
        run.remove(t)
    t = etree.SubElement(run, f"{_W}t")
    t.text = text
    t.set(_XML_SPACE, "preserve")  # 新文本可能带首尾空白，防 Word 吞空格


def _clone_line_paragraph(
    para: etree._Element, style_run: etree._Element, line: str
) -> etree._Element:
    """克隆一个「单行段落」承载多行内容的后续行。

    骨架 deepcopy 原 para（保留 pPr 对齐缩进等），删其直接子 w:r /
    w:proofErr；新行文本放一个克隆自 style_run 的 run（P5：样式与
    首行一致）。P4：剥离 pPr 中的编号属性，防克隆段加入编号列表。
    """
    clone = copy.deepcopy(para)
    for child in list(clone):
        if child.tag in (f"{_W}r", f"{_W}proofErr"):
            clone.remove(child)
    ppr = clone.find(f"{_W}pPr")
    if ppr is not None:
        num_pr = ppr.find(f"{_W}numPr")
        if num_pr is not None:
            ppr.remove(num_pr)
    run = copy.deepcopy(style_run)
    _set_run_text(run, line)
    clone.append(run)
    return clone


def _replace_in_paragraph(
    para: etree._Element,
    entries: list[tuple[Region, int]],
    block_contents: dict[int, str],
) -> None:
    """替换段落内全部已绑定占位符；多行内容在段落后方追加克隆段落。

    entries: (region, 段内 order)——按文档流 order_index 排序即段内
    占位符出现顺序；block_contents 缺失的区域保留原文。
    """
    entries.sort(key=lambda e: e[1])
    runs = para.findall(f"{_W}r")
    texts = [_run_text(r) for r in runs]
    full = "".join(texts)
    starts: list[int] = []
    pos = 0
    for t in texts:
        starts.append(pos)
        pos += len(t)

    # 定位各占位符 span：顺序消费（同段重复占位符不串位）
    spans: list[tuple[Region, int, int]] = []
    cursor = 0
    for region, _ in entries:
        ph = region.placeholder or ""
        start = full.find(ph, cursor) if ph else -1
        if start < 0:
            continue  # 区域与段落文本不一致（防御，正常不发生）
        spans.append((region, start, start + len(ph)))
        cursor = start + len(ph)
    if not spans:
        return

    def _covering_run(char_pos: int) -> int:
        """覆盖合并文本第 char_pos 字符的 run 下标（文本连续必有解）。"""
        for i in range(len(runs) - 1, -1, -1):
            if starts[i] <= char_pos < starts[i] + len(texts[i]):
                return i
        return len(runs) - 1

    # 先按文档序收集克隆行（区域顺序 × 行序；此时文本未动，定位准确），
    # 再逆序替换文本。texts 跟随每次写入更新——右侧 span 的替换成果
    # 不会被左侧 span 处理时的陈旧文本覆盖（同段多占位符核心陷阱）
    clone_lines: list[tuple[etree._Element, str]] = []  # (style_run, line)
    for region, s, _e in spans:
        content = block_contents.get(region.id)
        if content is None or "\n" not in content:
            continue
        style_run = runs[_covering_run(s)]
        for line in content.split("\n")[1:]:
            clone_lines.append((style_run, line))

    for region, s, e in reversed(spans):
        content = block_contents.get(region.id)
        if content is None:
            continue  # 未绑定 → 保留原文
        lines = content.split("\n")
        first_idx = _covering_run(s)
        last_idx = _covering_run(e - 1)
        first_run, last_run = runs[first_idx], runs[last_idx]
        if first_idx == last_idx:
            local_s = s - starts[first_idx]
            local_e = e - starts[first_idx]
            merged = texts[first_idx][:local_s] + lines[0] + texts[first_idx][local_e:]
            _set_run_text(first_run, merged)
            texts[first_idx] = merged
        else:
            head = texts[first_idx][: s - starts[first_idx]] + lines[0]
            _set_run_text(first_run, head)
            texts[first_idx] = head
            for mid in range(first_idx + 1, last_idx):
                _set_run_text(runs[mid], "")
                texts[mid] = ""
            tail = texts[last_idx][e - starts[last_idx]:]
            _set_run_text(last_run, tail)
            texts[last_idx] = tail

    # 克隆行按文档序链式插入段落后方
    anchor_el = para
    for style_run, line in clone_lines:
        clone = _clone_line_paragraph(para, style_run, line)
        anchor_el.addnext(clone)
        anchor_el = clone


def apply_replacements(
    template_data: bytes,
    regions: list[Region],
    block_contents: dict[int, str],
) -> ReplacementOutcome:
    """把绑定的块内容替换进模板，返回成品 DOCX 与区域新 path 映射。

    block_contents: region_id → 块内容，仅含「有效绑定」（active 且
    块存活）的区域；缺失区域保留占位符原文。
    """
    doc = Document(BytesIO(template_data))
    body = doc.element.body

    # 按段落分组区域（同段可承载多个占位符区域）；元素引用在后续
    # 插入克隆段后依然有效（lxml 语义），多区域替换互不干扰
    para_groups: dict[int, list[tuple[Region, int]]] = {}
    id_to_para: dict[int, etree._Element] = {}
    region_paras: list[tuple[Region, etree._Element]] = []
    for region in regions:
        anchor = json.loads(region.anchor)
        assert isinstance(anchor, dict)
        para = _resolve_paragraph(body, anchor)
        if para is None:
            continue  # anchor 与文档失配（防御）：该区域保留原文
        para_groups.setdefault(id(para), []).append((region, region.order_index))
        id_to_para[id(para)] = para
        region_paras.append((region, para))

    for para_id, entries in para_groups.items():
        _replace_in_paragraph(id_to_para[para_id], entries, block_contents)

    # 替换后重新枚举文档流：元素身份 → 新 path（多行插入已推挤索引）
    path_by_element = {
        id(el): anchor["path"] for anchor, el in iter_flow_paragraph_elements(body)
    }
    region_paths: dict[int, list[int]] = {}
    for region, para in region_paras:
        new_path = path_by_element.get(id(para))
        if new_path is not None:
            assert isinstance(new_path, list)
            region_paths[region.id] = list(new_path)

    buf = BytesIO()
    doc.save(buf)
    return ReplacementOutcome(buf.getvalue(), region_paths)
