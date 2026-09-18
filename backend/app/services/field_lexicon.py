"""字段名词表启发式（M3b，PRD 4.2 第二层识别）：常见简历字段名 → 区域类型推断。

三层识别的中间层：显式占位符 `{{字段名}}`（docx_parser 主路径）优先；
本模块对无占位符段落匹配字段名词表，产出类型推断与置信度，校对（M5b）
负责确认/排除候选。

- 两种形态：整段即字段名（如「工作经历」标题行，置信度高）；「字段名：值」
  前缀形态（如「姓名：张三」，冒号后须有实际内容）
- 词表项按长度降序尝试（防「求职意向」截断「求职意向岗位」）
- 大小写不敏感（Email/email 等英文变体）；扩充词表 = 往 _LEXICON 加词
"""

from dataclasses import dataclass

# 置信度分级（regions.confidence REAL，0–1；前端颜色映射留 M5b 校对界面）
CONF_PLACEHOLDER = 1.0  # 显式占位符（D3 确定性主路径）
CONF_TITLE = 0.9  # 整段即字段名（标题行）
CONF_LABELED = 0.7  # 「字段名：值」形态
CONF_PARAGRAPH = 0.4  # 成段正文兜底候选

# 成段正文最短长度（字符，PRD「成段的正文区域」切分细则——开放问题 #1 的 v1 口径）
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
    "work": ("工作经历", "工作经验", "职业经历", "工作背景", "实习经历", "实习经验"),
    "project": ("项目经历", "项目经验", "项目实践", "主要项目", "项目"),
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

# 扁平词表（term, region_type），长度降序——最长匹配优先
_TERMS: list[tuple[str, str]] = sorted(
    ((term, rtype) for rtype, terms in _LEXICON.items() for term in terms),
    key=lambda e: len(e[0]),
    reverse=True,
)

_COLONS = "：:"


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
    t = label.strip()
    if not t:
        return None
    for term, rtype in _TERMS:
        if t.casefold() == term.casefold():
            return rtype
    return None


def classify_paragraph(text: str) -> LexiconHit | None:
    """对无占位符段落做字段名匹配，命中返回 LexiconHit，未命中 None。

    - 整段（trim 后）等于词表项 → 标题形态（如「教育背景」行）
    - 「词表项+冒号+实际内容」→ labeled 形态（如「姓名：张三」；冒号后
      无内容不算，如「姓名：」落回成段/忽略逻辑）
    """
    t = text.strip()
    if not t:
        return None
    for term, rtype in _TERMS:
        if t.casefold() == term.casefold():
            return LexiconHit(rtype, CONF_TITLE, t, is_title=True)
        # 前缀比较限定在 len(term) 字符内（casefold 可能改变长度，rest 取原串）
        if t[: len(term)].casefold() == term.casefold() and len(t) > len(term):
            rest = t[len(term):]
            if rest[0] in _COLONS and rest[1:].strip():
                return LexiconHit(rtype, CONF_LABELED, term, is_title=False)
    return None


def truncate_label(text: str) -> str:
    """成段正文候选的显示名：截前缀，超长补省略号。"""
    stripped = text.strip()
    if len(stripped) <= _LABEL_MAX_LEN:
        return stripped
    return stripped[:_LABEL_MAX_LEN] + "…"
