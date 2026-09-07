"""领域常量：区域类型与各状态机取值。后端英文标识，前端负责中文展示。"""

# 区域类型（9 种，需求定稿；custom 兜底手工框选的区域）
REGION_TYPES = frozenset(
    {"name", "contact", "objective", "education", "work", "project", "skills", "summary", "custom"}
)

# 模板状态机（M3 驱动：parsing 解析中 → pending_review 待校对 → ready 可用）
TEMPLATE_STATUSES = frozenset({"parsing", "pending_review", "ready"})

# 区域校对状态（M5b：pending 待确认 / confirmed 已确认 / excluded 已排除）
REGION_REVIEW_STATUSES = frozenset({"pending", "confirmed", "excluded"})

# 绑定状态：active 正常；missing = 块被软删除后的降级态（导出留空并提示，D11）
BINDING_STATUSES = frozenset({"active", "missing"})
