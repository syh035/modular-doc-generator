/** 区域类型枚举（AGENTS.md 约定：后端英文标识，前端中文展示）。 */

export const REGION_TYPE_LABELS: Record<string, string> = {
  name: '姓名',
  contact: '联系方式',
  objective: '求职意向',
  education: '教育经历',
  work: '工作经历',
  project: '项目经历',
  skills: '技能清单',
  summary: '自我评价',
  custom: '自定义',
}

/** 下拉选项（校对命名弹层用）。 */
export const REGION_TYPE_OPTIONS = Object.entries(REGION_TYPE_LABELS).map(
  ([value, label]) => ({ value, label }),
)

/** 校对状态中文（图例/浮层用）。 */
export const REVIEW_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  excluded: '已排除',
}
