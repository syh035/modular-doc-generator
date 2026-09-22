/** 模板域 API 与类型（对应后端 /api/templates）。 */

import { apiFetch } from './client'

/** 区域 bbox（M4 契约：PDF 点、原点左上、page 0 基）。 */
export interface BBox {
  page: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 模板区域（文档流锚定，bbox=null 表示渲染未匹配，前端画虚线）。 */
export interface Region {
  id: number
  template_id: number
  type: string
  label: string
  placeholder: string | null
  anchor: { kind: string; path: number[] }
  order_index: number
  bbox: BBox | null
  confidence: number | null
  review_status: string
  created_at: string
  updated_at: string
}

export interface Template {
  id: number
  filename: string
  storage_name: string
  sha256: string
  status: string
  created_at: string
  updated_at: string
}

export interface TemplateListItem extends Template {
  regions_count: number
}

export interface TemplateDetail extends Template {
  regions: Region[]
  /** 默认版本 id（上传即建，M6a；null = 历史模板无版本）。 */
  default_version_id: number | null
}

/** 上传结果：201 新建（reused=false）/ 200 同内容重传关联已有模板（reused=true，D10）。 */
export interface UploadTemplateResult {
  template: TemplateDetail
  reused: boolean
}

/** 上传 DOCX 模板（multipart，字段名 file）。同步解析完成（D12）。 */
export async function uploadTemplate(file: File): Promise<UploadTemplateResult> {
  const form = new FormData()
  form.append('file', file, file.name)
  const body = await apiFetch<TemplateDetail & { reused: boolean }>('/api/templates', {
    method: 'POST',
    body: form,
  })
  return { template: body, reused: body.reused }
}

/** 模板列表（最新上传在前）。 */
export async function listTemplates(): Promise<TemplateListItem[]> {
  const body = await apiFetch<{ templates: TemplateListItem[] }>('/api/templates')
  return body.templates
}

/** 模板详情（含全部区域，按文档流顺序）。 */
export function fetchTemplate(id: number): Promise<TemplateDetail> {
  return apiFetch<TemplateDetail>(`/api/templates/${id}`)
}

/** 模板预览 PDF 地址（单管线铁律：预览即管线产物，P2）。 */
export function previewUrl(id: number): string {
  return `/api/templates/${id}/preview`
}
