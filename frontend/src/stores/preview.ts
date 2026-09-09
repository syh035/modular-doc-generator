/**
 * 预览状态：模板列表 + 当前预览（PDF 数据 / 区域 / 加载态）。
 *
 * P7：模板切换走 RequestSequencer，一次选择 = 一个序号；
 * PDF 与详情共用该序号（PDF 先行——首次触发 LO 转换与 bbox 落库（M4 契约），
 * 详情随后取到的 regions 已带 bbox，覆盖层即得黄框）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { CancelledError, RequestSequencer, fetchBlob } from '../api/client'
import {
  fetchTemplate,
  listTemplates,
  previewUrl,
  type Region,
  type TemplateListItem,
} from '../api/templates'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

export const usePreviewStore = defineStore('preview', () => {
  /** 模板列表（TopBar 下拉数据源）。 */
  const templates = ref<TemplateListItem[]>([])
  const templatesError = ref<string | null>(null)

  const currentTemplateId = ref<number | null>(null)
  const currentTemplate = computed(
    () => templates.value.find(t => t.id === currentTemplateId.value) ?? null,
  )

  /** 当前预览状态机：idle（未选）→ loading → ready | error。 */
  const status = ref<PreviewStatus>('idle')
  const error = ref<string | null>(null)
  const regions = ref<Region[]>([])
  /** 管线 PDF 原始字节（组件交 pdfjs 渲染；换模板整体替换）。 */
  const pdfData = ref<ArrayBuffer | null>(null)

  const sequencer = new RequestSequencer()

  async function loadTemplates(): Promise<void> {
    try {
      templates.value = await listTemplates()
      templatesError.value = null
    } catch (err) {
      templatesError.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function selectTemplate(id: number | null): Promise<void> {
    const seq = sequencer.next()
    currentTemplateId.value = id
    regions.value = []
    pdfData.value = null
    error.value = null
    if (id === null) {
      status.value = 'idle'
      return
    }
    status.value = 'loading'
    try {
      const blob = await fetchBlob(previewUrl(id))
      if (!sequencer.isCurrent(seq)) {
        throw new CancelledError()
      }
      pdfData.value = await blob.arrayBuffer()
      if (!sequencer.isCurrent(seq)) {
        throw new CancelledError()
      }
      const detail = await fetchTemplate(id)
      if (!sequencer.isCurrent(seq)) {
        throw new CancelledError()
      }
      regions.value = detail.regions
      status.value = 'ready'
    } catch (err) {
      if (err instanceof CancelledError) {
        return // 过期响应静默丢弃（P7）
      }
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    templates,
    templatesError,
    currentTemplateId,
    currentTemplate,
    status,
    error,
    regions,
    pdfData,
    loadTemplates,
    selectTemplate,
  }
})
