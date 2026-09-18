/**
 * 预览状态：模板列表 + 当前预览（版本渲染 PDF / 区域 overlay / 绑定操作）。
 *
 * P7：模板切换与绑定刷新共用 RequestSequencer——一次用户操作 = 一个序号，
 * PDF 与 overlay 两段手工 isCurrent 检查（PDF 先行触发 LO 转换，overlay
 * 随后取到的已是替换后 bbox 与绑定态）。
 *
 * M6a：选中模板即展示「版本渲染预览」（模板 + 绑定替换成品，单管线）；
 * 无默认版本的历史模板回退模板预览 + 原始区域（bbox 落库版）。
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
import {
  bindRegion,
  fetchVersionOverlay,
  unbindRegion,
  versionPreviewUrl,
  type BindingInfo,
} from '../api/versions'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 当前展示的区域：无版本 = 模板区域（binding 恒 null）；有版本 = overlay 区域。 */
export type DisplayRegion = Region & { binding: BindingInfo | null }

export const usePreviewStore = defineStore('preview', () => {
  /** 模板列表（TopBar 下拉数据源）。 */
  const templates = ref<TemplateListItem[]>([])
  const templatesError = ref<string | null>(null)

  const currentTemplateId = ref<number | null>(null)
  const currentTemplate = computed(
    () => templates.value.find(t => t.id === currentTemplateId.value) ?? null,
  )
  /** 当前模板的默认版本（上传即建，M6a；null = 历史模板走模板预览兜底）。 */
  const currentVersionId = ref<number | null>(null)

  /** 当前预览状态机：idle（未选）→ loading → ready | error。 */
  const status = ref<PreviewStatus>('idle')
  const error = ref<string | null>(null)
  const regions = ref<DisplayRegion[]>([])
  /** 管线 PDF 原始字节（组件交 pdfjs 渲染；换模板/绑定刷新整体替换）。 */
  const pdfData = ref<ArrayBuffer | null>(null)
  /** 绑定后预览刷新中（D12：局部刷新指示，旧内容保持可见）。 */
  const refreshing = ref(false)

  const sequencer = new RequestSequencer()

  async function loadTemplates(): Promise<void> {
    try {
      templates.value = await listTemplates()
      templatesError.value = null
    } catch (err) {
      templatesError.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 拉取版本渲染产物（PDF + overlay），两段共用序号。 */
  async function _fetchVersionRender(seq: number, versionId: number): Promise<void> {
    const blob = await fetchBlob(versionPreviewUrl(versionId))
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
    pdfData.value = await blob.arrayBuffer()
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
    regions.value = await fetchVersionOverlay(versionId)
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
  }

  /** 无版本历史模板：模板预览 PDF + 详情区域（bbox 落库版，binding 恒 null）。 */
  async function _fetchTemplateRender(seq: number, templateId: number): Promise<void> {
    const blob = await fetchBlob(previewUrl(templateId))
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
    pdfData.value = await blob.arrayBuffer()
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
    const detail = await fetchTemplate(templateId)
    if (!sequencer.isCurrent(seq)) {
      throw new CancelledError()
    }
    regions.value = detail.regions.map(r => ({ ...r, binding: null }))
  }

  async function selectTemplate(id: number | null): Promise<void> {
    const seq = sequencer.next()
    currentTemplateId.value = id
    currentVersionId.value = null
    regions.value = []
    pdfData.value = null
    error.value = null
    if (id === null) {
      status.value = 'idle'
      return
    }
    status.value = 'loading'
    try {
      // 先取详情拿 default_version_id（顺带触发模板 bbox 落库不影响版本路径）
      const detail = await fetchTemplate(id)
      if (!sequencer.isCurrent(seq)) {
        throw new CancelledError()
      }
      const versionId = detail.default_version_id ?? null
      currentVersionId.value = versionId
      if (versionId !== null) {
        await _fetchVersionRender(seq, versionId)
      } else {
        await _fetchTemplateRender(seq, id)
      }
      status.value = 'ready'
    } catch (err) {
      if (err instanceof CancelledError) {
        return // 过期响应静默丢弃（P7）
      }
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 绑定/解绑后的局部刷新：重拉版本渲染（P7 序号；refreshing 供 UI 指示）。 */
  async function refreshVersionRender(): Promise<void> {
    const versionId = currentVersionId.value
    if (versionId === null || status.value !== 'ready') {
      return
    }
    const seq = sequencer.next()
    refreshing.value = true
    try {
      await _fetchVersionRender(seq, versionId)
      error.value = null // 刷新成功清除绑定期错误
    } catch (err) {
      if (err instanceof CancelledError) {
        return
      }
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (sequencer.isCurrent(seq)) {
        refreshing.value = false
      }
    }
  }

  /** 绑定/换绑（PRD 4.4 正反向统一入口）→ 成功后刷新预览。 */
  async function bindRegionToBlock(regionId: number, blockId: number): Promise<boolean> {
    const versionId = currentVersionId.value
    if (versionId === null) {
      error.value = '当前模板无内容版本，无法绑定'
      return false
    }
    try {
      await bindRegion(versionId, regionId, blockId)
      await refreshVersionRender()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  /** 解绑 → 成功后刷新预览。 */
  async function unbindRegionFromBlock(regionId: number): Promise<boolean> {
    const versionId = currentVersionId.value
    if (versionId === null) {
      error.value = '当前模板无内容版本，无法解绑'
      return false
    }
    try {
      await unbindRegion(versionId, regionId)
      await refreshVersionRender()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  return {
    templates,
    templatesError,
    currentTemplateId,
    currentTemplate,
    currentVersionId,
    status,
    error,
    regions,
    pdfData,
    refreshing,
    loadTemplates,
    selectTemplate,
    refreshVersionRender,
    bindRegionToBlock,
    unbindRegionFromBlock,
  }
})
