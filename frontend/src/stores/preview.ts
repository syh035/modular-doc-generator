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
  uploadTemplate as uploadTemplateApi,
  type Region,
  type TemplateListItem,
} from '../api/templates'
import {
  bindRegion,
  createVersion as createVersionApi,
  deleteVersion as deleteVersionApi,
  fetchVersionOverlay,
  listVersions,
  renameVersion as renameVersionApi,
  unbindRegion,
  versionPreviewUrl,
  type BindingInfo,
  type OverflowInfo,
  type VersionInfo,
} from '../api/versions'
import {
  createRegion as createRegionApi,
  deleteRegion as deleteRegionApi,
  updateRegion as updateRegionApi,
  type RegionFramePayload,
  type RegionPatchPayload,
} from '../api/regions'
import {
  applyMigration,
  fetchMigrationPlan,
  type MigrationPlan,
} from '../api/migrations'
import {
  exportVersion,
  ExportBlockedError,
  type ExportWarning,
} from '../api/exports'

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

/** 上传动作结果：成功带新模板 id（reused=true = 同内容重传关联，D10）。 */
export interface UploadResult {
  ok: boolean
  error: string | null
  templateId?: number
  reused?: boolean
}

/** 导出动作结果：needConfirm=true 表示被大超出拦截、警示清单已就绪待确认。 */
export interface ExportActionResult {
  ok: boolean
  needConfirm: boolean
  blob?: Blob
  fileName?: string
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
  /** 当前模板的版本列表（M8：下拉数据源，创建正序）。 */
  const versions = ref<VersionInfo[]>([])

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

  // ---- 换模板迁移（M10，PRD 4.7 / D7）----

  /** 迁移提示源上下文（null = 无提示）：切换模板时检测到可迁移绑定即置位。 */
  const migrationSource = ref<{
    sourceVersionId: number
    sourceVersionName: string
    sourceTemplateName: string
    sourceBindingCount: number
  } | null>(null)
  /** 迁移方案（进入确认界面后填充）。 */
  const migrationPlan = ref<MigrationPlan | null>(null)
  const migrationBusy = ref(false)
  const migrationError = ref<string | null>(null)

  // ---- 导出（M9，PRD 4.8 / D5）----

  const exportBusy = ref(false)
  const exportError = ref<string | null>(null)
  /** 大超出警示清单（非空 = 弹确认弹层；本地即时判定与 409 兜底共用）。 */
  const exportWarnings = ref<ExportWarning[]>([])

  /** 本地大超出清单（overlay 现有 overflow 数据，零往返预判）。 */
  function _localLargeWarnings(): ExportWarning[] {
    const out: ExportWarning[] = []
    for (const r of regions.value) {
      if (r.overflow && r.overflow.level === 'large') {
        out.push({
          region_id: r.id,
          label: r.label,
          ratio: r.overflow.ratio,
          clipped: r.overflow.clipped,
          fixed_row: r.overflow.fixed_row,
        })
      }
    }
    return out
  }

  /**
   * 导出当前版本：无大超出 → 直接请求落盘下载；有大超出且未确认 → 置警示
   * 清单弹层（本地即时判定，服务端 409 兜底防本地状态过期）。确认后仍按
   * 重排结果导出（D5 默认行为）。blob 下载触发由组件负责（浏览器副作用）。
   */
  async function requestExport(confirm: boolean): Promise<ExportActionResult> {
    const versionId = currentVersionId.value
    if (versionId === null) {
      return { ok: false, needConfirm: false }
    }
    if (!confirm) {
      const local = _localLargeWarnings()
      if (local.length > 0) {
        exportWarnings.value = local
        return { ok: false, needConfirm: true }
      }
    }
    exportBusy.value = true
    exportError.value = null
    try {
      const { blob, fileName } = await exportVersion(versionId, confirm)
      return { ok: true, needConfirm: false, blob, fileName }
    } catch (err) {
      if (err instanceof ExportBlockedError) {
        // 本地判定过期（绑定刚变更）：以服务端现算清单为准，再走确认弹层
        exportWarnings.value = err.warnings
        return { ok: false, needConfirm: true }
      }
      exportError.value = err instanceof Error ? err.message : String(err)
      return { ok: false, needConfirm: false }
    } finally {
      exportBusy.value = false
    }
  }

  /** 关闭大超出警示弹层（返回修改）。 */
  function dismissExportWarnings(): void {
    exportWarnings.value = []
  }

  const sequencer = new RequestSequencer()

  async function loadTemplates(): Promise<void> {
    try {
      templates.value = await listTemplates()
      templatesError.value = null
    } catch (err) {
      templatesError.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 上传模板（顶栏「导入模板」）：成功后刷新列表并选中新模板（新模板进待校对流程）。 */
  async function uploadTemplate(file: File): Promise<UploadResult> {
    try {
      const { template, reused } = await uploadTemplateApi(file)
      await loadTemplates()
      await selectTemplate(template.id)
      return { ok: true, error: null, templateId: template.id, reused }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
    // M10 迁移触发：捕获切换前上下文（会话内、版本模式、active 绑定 ≥1 才有可迁移源）
    const prevTemplateId = currentTemplateId.value
    const prevVersionId = currentVersionId.value
    const prevTemplateName = currentTemplate.value?.filename ?? ''
    const prevVersionName = versions.value.find(v => v.id === prevVersionId)?.name ?? ''
    const prevBindingCount =
      prevVersionId !== null && !proofreadMode.value
        ? regions.value.filter(r => r.binding?.status === 'active').length
        : 0
    const seq = sequencer.next()
    currentTemplateId.value = id
    currentVersionId.value = null
    versions.value = []
    regions.value = []
    pdfData.value = null
    error.value = null
    _clearMigration()
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
      await loadVersionList() // 版本下拉数据源；迁移触发判定依赖 binding_count，须先就绪
      if (proofreadMode.value || versionId === null) {
        // 校对模式：看模板本体（原始区域 + 落库 bbox），不看替换成品
        await _fetchTemplateRender(seq, id)
      } else {
        await _fetchVersionRender(seq, versionId)
      }
      status.value = 'ready'
      _maybeOfferMigration(
        prevTemplateId,
        prevVersionId,
        prevTemplateName,
        prevVersionName,
        prevBindingCount,
      )
    } catch (err) {
      if (err instanceof CancelledError) {
        return // 过期响应静默丢弃（P7）
      }
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 迁移触发判定（M10）：切到 ready 新模板且其默认版本空白、源有绑定 → 置提示。 */
  function _maybeOfferMigration(
    prevTemplateId: number | null,
    prevVersionId: number | null,
    prevTemplateName: string,
    prevVersionName: string,
    prevBindingCount: number,
  ): void {
    const templateId = currentTemplateId.value
    if (
      prevTemplateId === null ||
      prevVersionId === null ||
      templateId === null ||
      templateId === prevTemplateId ||
      prevBindingCount < 1
    ) {
      return
    }
    // 目标模板须已完成解析校对（pending_review 不能作为迁移目标）
    const target = templates.value.find(t => t.id === templateId)
    if (!target || target.status !== 'ready') {
      return
    }
    // 目标默认版本须空白（0 active 绑定）——后端 plan/apply 双重守门
    const defaultVersion = versions.value.find(v => v.id === currentVersionId.value)
    if (!defaultVersion || defaultVersion.binding_count !== 0) {
      return
    }
    migrationSource.value = {
      sourceVersionId: prevVersionId,
      sourceVersionName: prevVersionName,
      sourceTemplateName: prevTemplateName,
      sourceBindingCount: prevBindingCount,
    }
  }

  function _clearMigration(): void {
    migrationSource.value = null
    migrationPlan.value = null
    migrationError.value = null
  }

  /** 拉取迁移方案（确认按钮 → 三清单界面）；失败返回 false，错误在 migrationError。 */
  async function loadMigrationPlan(): Promise<boolean> {
    const src = migrationSource.value
    const templateId = currentTemplateId.value
    if (src === null || templateId === null) {
      return false
    }
    migrationBusy.value = true
    migrationError.value = null
    try {
      migrationPlan.value = await fetchMigrationPlan(templateId, src.sourceVersionId)
      return true
    } catch (err) {
      migrationError.value = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      migrationBusy.value = false
    }
  }

  /** 确认迁移：整包提交三清单结果 → 清提示 → 刷新版本列表与预览渲染。 */
  async function confirmMigration(
    bindings: { region_id: number; block_id: number }[],
  ): Promise<ProofreadResult> {
    const src = migrationSource.value
    const templateId = currentTemplateId.value
    if (src === null || templateId === null) {
      return { ok: false, error: '当前无进行中的迁移' }
    }
    migrationBusy.value = true
    migrationError.value = null
    try {
      await applyMigration(templateId, src.sourceVersionId, bindings)
      _clearMigration()
      await loadVersionList()
      if (!proofreadMode.value && status.value === 'ready') {
        await refreshVersionRender()
      }
      return { ok: true, error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      migrationError.value = msg
      return { ok: false, error: msg }
    } finally {
      migrationBusy.value = false
    }
  }

  /** 跳过迁移：新模板从空白版本开始（v1 不提供补迁移入口）。 */
  function dismissMigration(): void {
    _clearMigration()
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

  /** 版本下拉数据源（当前模板）。失败静默置空，不阻断预览。 */
  async function loadVersionList(): Promise<void> {
    const templateId = currentTemplateId.value
    if (templateId === null) {
      versions.value = []
      return
    }
    try {
      versions.value = await listVersions(templateId)
    } catch {
      versions.value = []
    }
  }

  /** 切换版本（M8）：整体刷新渲染（P7 序号）。校对模式看模板本体，不响应。 */
  async function selectVersion(id: number): Promise<void> {
    if (proofreadMode.value || id === currentVersionId.value) {
      return
    }
    const seq = sequencer.next()
    currentVersionId.value = id
    regions.value = []
    pdfData.value = null
    error.value = null
    status.value = 'loading'
    try {
      await _fetchVersionRender(seq, id)
      status.value = 'ready'
    } catch (err) {
      if (err instanceof CancelledError) {
        return
      }
      status.value = 'error'
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 新建版本（M8）：copyFrom=true 复制当前版本 active 绑定为底稿；成功后切到新版本。 */
  async function createNewVersion(name: string, copyFrom: boolean): Promise<ProofreadResult> {
    const templateId = currentTemplateId.value
    if (templateId === null) {
      return { ok: false, error: '未选择模板，无法新建版本' }
    }
    try {
      const ver = await createVersionApi(
        templateId,
        name,
        copyFrom ? (currentVersionId.value ?? undefined) : undefined,
      )
      await loadVersionList()
      await selectVersion(ver.id)
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 重命名当前版本（同模板内唯一）；成功同步列表显示。 */
  async function renameCurrentVersion(name: string): Promise<ProofreadResult> {
    const versionId = currentVersionId.value
    if (versionId === null) {
      return { ok: false, error: '当前无内容版本，无法重命名' }
    }
    try {
      const updated = await renameVersionApi(versionId, name)
      const idx = versions.value.findIndex(v => v.id === versionId)
      if (idx >= 0) {
        versions.value[idx] = { ...versions.value[idx], name: updated.name }
      }
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 删除当前版本；删后切相邻（同位下个，无则前个；后端保证至少留一）。 */
  async function deleteCurrentVersion(): Promise<ProofreadResult> {
    const versionId = currentVersionId.value
    if (versionId === null) {
      return { ok: false, error: '当前无内容版本，无法删除' }
    }
    try {
      await deleteVersionApi(versionId)
      const idx = versions.value.findIndex(v => v.id === versionId)
      const rest = versions.value.filter(v => v.id !== versionId)
      versions.value = rest
      const target = rest[Math.min(idx, rest.length - 1)] ?? null
      if (target !== null) {
        await selectVersion(target.id)
      } else {
        // 后端至少留一，理论不达；兜底走模板选择路径
        const templateId = currentTemplateId.value
        if (templateId !== null) {
          await selectTemplate(templateId)
        }
      }
      return { ok: true, error: null }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
    versions,
    status,
    error,
    regions,
    pdfData,
    refreshing,
    proofreadMode,
    loadTemplates,
    selectTemplate,
    uploadTemplate,
    toggleProofreadMode,
    refreshVersionRender,
    loadVersionList,
    selectVersion,
    createNewVersion,
    renameCurrentVersion,
    deleteCurrentVersion,
    bindRegionToBlock,
    unbindRegionFromBlock,
    confirmRegion,
    excludeRegion,
    reopenRegion,
    adjustRegionBBox,
    removeRegion,
    createFrameRegion,
    migrationSource,
    migrationPlan,
    migrationBusy,
    migrationError,
    loadMigrationPlan,
    confirmMigration,
    dismissMigration,
    exportBusy,
    exportError,
    exportWarnings,
    requestExport,
    dismissExportWarnings,
  }
})
