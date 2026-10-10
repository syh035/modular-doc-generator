"""字段名词表启发式（M3b，PRD 4.2 第二层识别）：常见简历字段名 → 区域类型推断。

三层识别的中间层：显式占位符 `{{字段名}}`（docx_parser 主路径）优先；
本模块对无占位符段落匹配字段名词表，产出类型推断与置信度，校对（M5b）
负责确认/排除候选。

- 两种形态：整段即字段名（如「工作经历」标题行，置信度高）；「字段名：值」
  前缀形态（如「姓名：张三」，冒号后须有实际内容）
- 整个字段名精确匹配（防「求职意向」截断「求职意向岗位」）
- 大小写／全角形式归一；支持前后中文／阿拉伯数字编号；扩充词表 = 往 _LEXICON 加词
"""

import re
import unicodedata
from dataclasses import dataclass

# 置信度分级（regions.confidence REAL，0–1；前端颜色映射留 M5b 校对界面）
CONF_PLACEHOLDER = 1.0  # 显式占位符（D3 确定性主路径）
CONF_TITLE = 0.9  # 整段即字段名（标题行）
CONF_LABELED = 0.7  # 「字段名：值」形态
CONF_PARAGRAPH = 0.4  # 非空文字兜底候选

# 历史解析阈值：仅供旧模板一次性补齐识别时判定哪些文字过去被跳过
PARAGRAPH_MIN_LEN = 30

# 候选区域显示名截断长度（成段正文 label 取前缀防过长）
_LABEL_MAX_LEN = 12

# 词表：区域类型 → 字段名变体（v1 基础版；变体扩充属加分项）
_LEXICON: dict[str, tuple[str, ...]] = {
    "name": ("姓名", "名字", "Name", "Full Name"),
    "contact": (
        "联系方式",
        "联系电话",
        "电话号码",
        "手机号码",
        "电子邮箱",
        "电子邮件",
        "通讯地址",
        "手机",
        "电话",
        "邮箱",
        "微信",
        "地址",
        "Email",
        "E-mail",
        "Tel",
        "Phone",
    ),
    "objective": (
        "求职意向岗位",
        "应聘岗位",
        "意向岗位",
        "求职意向",
        "职业目标",
        "目标职位",
        "应聘职位",
    ),
    "education": (
        "毕业院校",
        "毕业学校",
        "教育背景",
        "教育经历",
        "所学专业",
        "最高学历",
        "学历",
        "学校",
        "专业",
        "学位",
    ),
    "work": (
        "工作经历",
        "工作经验",
        "职业经历",
        "工作背景",
        "实习经历",
        "实习经验",
    ),
    "project": (
        "项目经历",
        "项目经验",
        "项目实践",
        "主要项目",
        "项目",
    ),
    "skills": (
        "专业技能",
        "技能清单",
        "技能特长",
        "技能证书",
        "资质证书",
        "荣誉证书",
        "技能",
        "特长",
        "证书",
    ),
    "summary": (
        "自我介绍",
        "个人简介",
        "个人总结",
        "个人优势",
        "个人评价",
        "自我评价",
        "关于我",
    ),
}

# M15 扩充独立记录，历史全文补齐仍使用原词表边界。
_EXTRA_LEXICON: dict[str, tuple[str, ...]] = {
    "contact": (
        "移动电话",
        "联系手机",
        "联系地址",
        "现居地",
        "居住地址",
        "Telephone",
        "Mobile",
        "Contact",
        "Contact Information",
    ),
    "education": (
        "学习经历",
        "求学经历",
        "教育履历",
        "Education",
        "Educational Background",
    ),
    "work": (
        "工作履历",
        "职业履历",
        "任职经历",
        "实践经历",
        "社会实践",
        "Work Experience",
        "Professional Experience",
        "Employment History",
        "Internship",
    ),
    "project": (
        "项目成果",
        "科研经历",
        "科研项目",
        "研究项目",
        "Projects",
        "Project Experience",
        "Research Experience",
    ),
    "skills": (
        "个人技能",
        "核心技能",
        "技术技能",
        "Skills",
        "Technical Skills",
    ),
    "summary": (
        "个人综述",
        "个人概述",
        "职业概述",
        "Summary",
        "Profile",
        "Professional Summary",
    ),
}

_LEGACY_TERMS = {term.casefold() for terms in _LEXICON.values() for term in terms}


# 编号只用于已知字段名的完整匹配，不对正文做子串命中。
_NUMBER = r"(?:[0-9]{1,2}|[零〇一二三四五六七八九十百两]{1,4})"
_PREFIX_NUMBER = re.compile(rf"^(?:[（(]{_NUMBER}[）)]|第?{_NUMBER}[、.．)）]?)\s*")
_SUFFIX_NUMBER = re.compile(rf"\s*(?:[（(]{_NUMBER}[）)]|第?{_NUMBER})$")


def _field_key(text: str) -> str:
    value = unicodedata.normalize("NFKC", text).strip()
    value = _PREFIX_NUMBER.sub("", value, count=1)
    value = _SUFFIX_NUMBER.sub("", value, count=1)
    return " ".join(value.split()).casefold()


# 精确字段键查找；数字装饰与全角形式归一，英文词内空格仍保留。
_TERMS = {
    _field_key(term): (term, rtype)
    for lexicon in (_LEXICON, _EXTRA_LEXICON)
    for rtype, terms in lexicon.items()
    for term in terms
}


def was_legacy_field_paragraph(text: str) -> bool:
    """历史全文补齐专用：新增别名／编号不能改变旧规则遗漏的判断。"""
    value = text.strip()
    if value.casefold() in _LEGACY_TERMS:
        return True
    parts = re.split("[：:]", value, maxsplit=1)
    return len(parts) == 2 and parts[0].casefold() in _LEGACY_TERMS and bool(parts[1].strip())


@dataclass(frozen=True, slots=True)
class LexiconHit:
    """词表命中结果（供 parse_candidates 生成候选区域）。"""

    region_type: str
    confidence: float
    term: str  # 命中的词表项（labeled 形态用作区域显示名）
    is_title: bool  # True=整段即字段名；False=「字段名：值」前缀形态


def classify_field(label: str) -> str | None:
    """占位符字段名 → 区域类型（M3b 决策 C：仅整段匹配，不命中返回 None）。

    占位符字段名不会有「字段名：值」形态，故只做整段比较；置信度恒为
    CONF_PLACEHOLDER（占位符本身是确定性信号），由调用方赋值。
    """
    hit = _TERMS.get(_field_key(label))
    return hit[1] if hit else None


def classify_paragraph(text: str) -> LexiconHit | None:
    """对无占位符段落做字段名匹配，命中返回 LexiconHit，未命中 None。

    - 整段（trim 后）等于词表项 → 标题形态（如「教育背景」行）
    - 「词表项+冒号+实际内容」→ labeled 形态（如「姓名：张三」；冒号后
      无内容不算，如「姓名：」落回成段/忽略逻辑）
    """
    t = text.strip()
    if not t:
        return None
    hit = _TERMS.get(_field_key(t))
    if hit:
        return LexiconHit(hit[1], CONF_TITLE, t, is_title=True)
    # 在原文第一处冒号切分，值保持原样；不允许字段名后跟任意正文。
    parts = re.split("[：:]", t, maxsplit=1)
    if len(parts) == 2 and parts[1].strip():
        hit = _TERMS.get(_field_key(parts[0]))
        if hit:
            return LexiconHit(hit[1], CONF_LABELED, hit[0], is_title=False)
    return None


def truncate_label(text: str) -> str:
    """成段正文候选的显示名：截前缀，超长补省略号。"""
    stripped = text.strip()
    if len(stripped) <= _LABEL_MAX_LEN:
        return stripped
    return stripped[:_LABEL_MAX_LEN] + "…"
