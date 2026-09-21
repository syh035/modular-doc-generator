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
  type OverflowInfo,
} from '../api/versions'
import {
  createRegion as createRegionApi,
  deleteRegion as deleteRegionApi,
  updateRegion as updateRegionApi,
  type RegionFramePayload,
  type RegionPatchPayload,
} from '../api/regions'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 当前展示的区域：无版本 = 模板区域（binding 恒 null、无溢出报告）；有版本 = overlay 区域。 */
export type DisplayRegion = Region & {
  binding: BindingInfo | null
  overflow?: OverflowInfo | null
}

/** 校对动作返回：ok=false 时 error 为可读信息（如空区域拦截）。 */
export interface ProofreadResult {
  ok: boolean
  error: string | null
}

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
  /** 校对模式（M5b）：开启时预览切到模板本体（校对对象是模板区域，非版本成品）。 */
  const proofreadMode = ref(false)

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
      if (proofreadMode.value || versionId === null) {
        // 校对模式：看模板本体（原始区域 + 落库 bbox），不看替换成品
        await _fetchTemplateRender(seq, id)
      } else {
        await _fetchVersionRender(seq, versionId)
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

  /**
   * 切换校对模式：开启 → 拉模板预览 + 原始区域；关闭 → 回版本渲染（无版本回落模板预览）。
   * 区域级校对动作（确认/排除等）只更新 regions，不需要重拉 PDF。
   */
  async function toggleProofreadMode(on: boolean): Promise<void> {
    if (proofreadMode.value === on) {
      return
    }
    proofreadMode.value = on
    error.value = null
    const templateId = currentTemplateId.value
    if (templateId === null || status.value !== 'ready') {
      return // idle/加载中：仅翻旗标，selectTemplate 按模式取数
    }
    const seq = sequencer.next()
    refreshing.value = true
    try {
      if (on || currentVersionId.value === null) {
        await _fetchTemplateRender(seq, templateId)
      } else {
        await _fetchVersionRender(seq, currentVersionId.value)
      }
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

  /** 校对 PATCH 通用路径：成功同步本地 regions + 模板 ready 态（自动 ready 可能触发）。 */
  async function _patchRegion(regionId: number, patch: RegionPatchPayload): Promise<ProofreadResult> {
    try {
      const updated = await updateRegionApi(regionId, patch)
      const idx = regions.value.findIndex(r => r.id === regionId)
      if (idx >= 0) {
        regions.value[idx] = { ...regions.value[idx], ...updated }
      }
      void loadTemplates()
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 确认候选区域（pending → confirmed）。 */
  async function confirmRegion(regionId: number): Promise<ProofreadResult> {
    return _patchRegion(regionId, { review_status: 'confirmed' })
  }

  /** 排除候选区域（pending → excluded；后端拒绝向其建绑定）。 */
  async function excludeRegion(regionId: number): Promise<ProofreadResult> {
    return _patchRegion(regionId, { review_status: 'excluded' })
  }

  /** 重新校对（confirmed/excluded → pending）。 */
  async function reopenRegion(regionId: number): Promise<ProofreadResult> {
    return _patchRegion(regionId, { review_status: 'pending' })
  }

  /** 边界微调：提交新 bbox（即转 manual，产物更新不覆盖，P21 生命周期）。 */
  async function adjustRegionBBox(regionId: number, bbox: RegionFramePayload): Promise<ProofreadResult> {
    return _patchRegion(regionId, { bbox })
  }

  /** 删除区域（后端级联删绑定）→ 本地移除。 */
  async function removeRegion(regionId: number): Promise<ProofreadResult> {
    try {
      await deleteRegionApi(regionId)
      regions.value = regions.value.filter(r => r.id !== regionId)
      void loadTemplates()
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 框选新建：服务端反解 anchor → confirmed 区域；错误内联给命名弹层。 */
  async function createFrameRegion(
    frame: RegionFramePayload,
    label: string,
    type: string,
  ): Promise<ProofreadResult> {
    const templateId = currentTemplateId.value
    if (templateId === null) {
      return { ok: false, error: '未选择模板，无法新建区域' }
    }
    try {
      const region = await createRegionApi(templateId, { label, type, bbox: frame })
      regions.value = [...regions.value, { ...region, binding: null }]
      void loadTemplates()
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
    proofreadMode,
    loadTemplates,
    selectTemplate,
    toggleProofreadMode,
    refreshVersionRender,
    bindRegionToBlock,
    unbindRegionFromBlock,
    confirmRegion,
    excludeRegion,
    reopenRegion,
    adjustRegionBBox,
    removeRegion,
    createFrameRegion,
  }
})
