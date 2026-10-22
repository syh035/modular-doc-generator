<script setup lang="ts">
import { formatOverflowGrowth } from '../utils/overflow'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { RegionFramePayload } from '../api/regions'
import {
  bboxToOverlayRect,
  overlayKind,
  overlayRectToBBox,
  type OverlayRect,
} from '../pdf/geometry'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'
import { useBlocksStore } from '../stores/blocks'
import { useAppStore } from '../stores/app'
import { useHistoryStore } from '../stores/history'
import type { VersionInfo } from '../api/versions'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'
import RegionTextEditor from './RegionTextEditor.vue'
import ExportDialog from './ExportDialog.vue'
import MigrationDialog from './MigrationDialog.vue'
import ProofreadPopover from './ProofreadPopover.vue'
import RegionNameDialog from './RegionNameDialog.vue'
import DocumentActions from './DocumentActions.vue'
import { PageCanvasCache } from '../pdf/pageCache'
import { previewScale } from '../pdf/scale'

const emit = defineEmits<{ import: []; archive: [] }>()
const app = useAppStore()
const history = useHistoryStore()
const previewTools = ref<HTMLDetailsElement | null>(null)
function closePreviewTools(returnFocus = false): void {
  if (previewTools.value) previewTools.value.open = false
  if (returnFocus) previewTools.value?.querySelector('summary')?.focus()
}
function outsidePreviewTools(event: PointerEvent): void {
  if (event.target instanceof Node && !previewTools.value?.contains(event.target)) closePreviewTools()
}
onMounted(() => document.addEventListener('pointerdown', outsidePreviewTools))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outsidePreviewTools))
const store = usePreviewStore()
const blocksStore = useBlocksStore()
/** 滚动容器（页面按 fit-width 平铺，纵向滚动）。 */
const scrollRef = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const containerHeight = ref(0)
const zoom = ref('page')
const renderedScale = ref(1)
const pages = ref<RenderedPage[]>([])
const canvasCache = new PageCanvasCache()
/** 未定位区域（bbox=null，渲染未匹配）：无几何，只能列表提示（M5b 校对兜底）。 */
const unplaced = computed(() =>
  store.regions.filter(r => !r.removed && r.bbox === null && (store.proofreadMode || r.review_status !== 'excluded')),
)
/** 绑定浮层目标区域（null = 关闭，正常模式）。 */
const dialogRegion = ref<DisplayRegion | null>(null)
const textEditorTarget = ref<DisplayRegion | null>(null)
const textEditing = ref(false)
const textEditError = ref<string | null>(null)

function openTextEditor(): void {
  textEditorTarget.value = dialogRegion.value
  dialogRegion.value = null
  textEditError.value = null
}

async function saveText(content: string, syncBlock: boolean): Promise<void> {
  const region = textEditorTarget.value
  if (!region || textEditing.value) return
  textEditing.value = true
  const result = await store.editRegionText(region.id, content, syncBlock, region.current_text ?? '')
  textEditing.value = false
  if (result.ok) textEditorTarget.value = null
  else textEditError.value = result.error
}

async function removeTextParagraph(): Promise<void> {
  const region = textEditorTarget.value
  if (!region || textEditing.value) return
  textEditing.value = true
  const result = await store.changeRegionLayout(region.id, 'remove')
  textEditing.value = false
  if (result.ok) textEditorTarget.value = null
  else textEditError.value = result.error
}
const removedRegions = computed(() => store.regions.filter(r => r.removed))
async function restoreParagraph(id: number): Promise<void> {
  const result = await store.changeRegionLayout(id, 'restore')
  if (!result.ok) store.error = result.error
}

watch(() => store.currentVersionId, () => { textEditorTarget.value = null })
/** 校对浮层目标（null = 关闭，校对模式；page 供微调启动取 viewport）。 */
const popoverTarget = ref<{ region: DisplayRegion; page: RenderedPage } | null>(null)
const proofreadBusy = ref(false)
const proofreadError = ref<string | null>(null)
watch(popoverTarget, () => { proofreadError.value = null })
/** 命名弹层：框选完成待命名（null = 关闭）。 */
const nameDialog = ref<{ frame: RegionFramePayload; suggestedName: string; suggestedType: string } | null>(null)
const frameDetails = ref<{ name: string; type: string } | null>(null)
const nameError = ref<string | null>(null)
const nameSubmitting = ref(false)
const frameMode = ref(false)
const frameTarget = ref<DisplayRegion | null>(null)
const frameError = ref<string | null>(null)
const frameStarting = ref(false)
const reviewStarting = ref(false)
const reviewFinishing = ref(false)
const regionTask = ref<'check' | 'add' | 'relocate' | null>(null)
const frameReturnTo = ref<'document' | 'check'>('document')
const regionMessage = ref('')
let documentReturn: { templateId: number; versionId: number | null; top: number; left: number; zoom: string } | null = null
const geometryBusy = ref(false)
const geometryRetry = shallowRef<{ regionId: number; frame: RegionFramePayload; kind: 'adjust' | 'relocate' } | null>(null)
let viewIdentity = 0
let frameStartRequest = 0
let reviewFinishRequest = 0
let framePreparation: Promise<void> | null = null
let disposed = false
const regionWriteBusy = computed(() => geometryBusy.value || nameSubmitting.value || proofreadBusy.value)
const regionEntryBusy = computed(() => regionWriteBusy.value || frameStarting.value || reviewStarting.value
  || reviewFinishing.value || store.status !== 'ready' || store.refreshing || canvasBusy.value)
const regionTemplateName = computed(() => store.templates.find(template => template.id === store.currentTemplateId)?.filename ?? '当前模板')
const pendingReviewRegions = computed(() => store.regions.filter(region => region.review_status === 'pending' && region.bbox !== null && !region.removed))
const nextRegionName = computed(() => {
  const labels = new Set(store.regions.map(region => region.label))
  let index = 1
  while (labels.has(`补选区域${index}`)) index++
  return `补选区域${index}`
})
let lastReviewRegionId: number | null = null
function rememberDocument(): void {
  if (!store.proofreadMode && store.currentTemplateId !== null) documentReturn = {
    templateId: store.currentTemplateId, versionId: store.currentVersionId,
    top: scrollRef.value?.scrollTop ?? 0, left: scrollRef.value?.scrollLeft ?? 0, zoom: zoom.value,
  }
}
async function waitForCanvas(): Promise<void> {
  await nextTick()
  let pending: Promise<void>
  do { pending = rebuildDone; await pending; await nextTick() }
  while (!disposed && pending !== rebuildDone)
}
async function beginRegionReview(): Promise<void> {
  if (regionEntryBusy.value || store.currentTemplateId === null) return
  rememberDocument()
  const request = ++frameStartRequest, templateId = store.currentTemplateId
  reviewStarting.value = true; regionTask.value = 'check'; regionMessage.value = ''
  try {
    await store.toggleProofreadMode(true)
    await waitForCanvas()
    if (disposed || request !== frameStartRequest || store.currentTemplateId !== templateId || !store.proofreadMode) return
  } finally { if (request === frameStartRequest) reviewStarting.value = false }
}
async function finishRegionReview(): Promise<void> {
  if (regionWriteBusy.value || reviewStarting.value || reviewFinishing.value || store.status !== 'ready' || store.refreshing) return
  const request = ++reviewFinishRequest
  const snapshot = documentReturn, templateId = store.currentTemplateId
  frameStartRequest++; frameStarting.value = false; reviewFinishing.value = true
  clearFrameDraft(); geometryRetry.value = null; nameDialog.value = null; frameDetails.value = null
  try {
    if (snapshot?.templateId === templateId) zoom.value = snapshot.zoom
    await store.toggleProofreadMode(false)
    await waitForCanvas()
    if (!disposed && request === reviewFinishRequest && store.currentTemplateId === templateId && !store.proofreadMode && snapshot?.templateId === templateId
        && store.currentVersionId === snapshot.versionId && scrollRef.value) {
      scrollRef.value.scrollTop = snapshot.top; scrollRef.value.scrollLeft = snapshot.left
    }
  } finally {
    if (!disposed && request === reviewFinishRequest && store.currentTemplateId === templateId) {
      reviewFinishing.value = false
      if (!store.proofreadMode) documentReturn = null
    }
  }
}
function nextReviewRegion(): void {
  const list = pendingReviewRegions.value
  const next = list[(list.findIndex(region => region.id === lastReviewRegionId) + 1) % list.length]
  if (!next || regionEntryBusy.value) return
  lastReviewRegionId = next.id; jumpToRegion(next)
  scrollRef.value?.querySelector<HTMLElement>(`[data-region-id="${next.id}"]`)?.focus({ preventScroll: true })
  const page = pages.value.find(page => page.index === next.bbox?.page)
  if (page) popoverTarget.value = { region: next, page }
}

async function startFrame(region: DisplayRegion | null = null): Promise<void> {
  if (regionEntryBusy.value || frameMode.value || store.currentTemplateId === null) return
  frameReturnTo.value = store.proofreadMode ? 'check' : 'document'
  frameDetails.value = null
  rememberDocument()
  regionTask.value = region ? 'relocate' : 'add'; regionMessage.value = ''
  const request = ++frameStartRequest
  const templateId = store.currentTemplateId
  frameStarting.value = true; frameError.value = null
  const preparing = store.toggleProofreadMode(true)
  framePreparation = preparing
  try {
    await preparing
    await nextTick()
    let pending: Promise<void>
    do {
      pending = rebuildDone
      await pending
      await nextTick()
    } while (!disposed && request === frameStartRequest && pending !== rebuildDone)
    if (disposed || request !== frameStartRequest || store.currentTemplateId !== templateId
        || !store.proofreadMode || store.error || !canvasReady.value) return
    frameTarget.value = region
    frameMode.value = true
    geometryRetry.value = null
  } finally {
    if (framePreparation === preparing) framePreparation = null
    if (request === frameStartRequest) frameStarting.value = false
  }
}

function clearFrameDraft(): void {
  frameMode.value = false
  frameTarget.value = null
  frameError.value = null
  draftFrame.value = null
  drag = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}
async function cancelFrame(): Promise<void> {
  if (regionWriteBusy.value) return
  const request = ++frameStartRequest, preparing = framePreparation, templateId = store.currentTemplateId
  frameStarting.value = false
  clearFrameDraft()
  geometryRetry.value = null; nameDialog.value = null; nameError.value = null; frameDetails.value = null
  regionTask.value = 'check'
  if (frameReturnTo.value === 'document') {
    await preparing
    await waitForCanvas()
    if (!disposed && request === frameStartRequest && templateId === store.currentTemplateId) await finishRegionReview()
  }
}
async function saveGeometry(regionId: number, frame: RegionFramePayload, kind: 'adjust' | 'relocate'): Promise<void> {
  if (geometryBusy.value) return
  const identity = viewIdentity, templateId = store.currentTemplateId
  const target = { regionId, frame, kind }
  geometryRetry.value = target; geometryBusy.value = true; frameError.value = null
  try {
    const result = await store.adjustRegionBBox(regionId, frame)
    if (disposed || identity !== viewIdentity || templateId !== store.currentTemplateId || geometryRetry.value !== target) return
    if (result.ok) {
      geometryRetry.value = null
      regionMessage.value = '区域位置已保存，原区域和绑定关系保留。'
      if (kind === 'relocate') {
        clearFrameDraft(); geometryBusy.value = false
        if (frameReturnTo.value === 'document') await finishRegionReview()
        else regionTask.value = 'check'
      }
      else adjustDraft.value = null
    } else frameError.value = result.error
  } catch (err) {
    if (!disposed && identity === viewIdentity && geometryRetry.value === target) frameError.value = String(err)
  } finally {
    if (!disposed && identity === viewIdentity) geometryBusy.value = false
  }
}
function retryGeometry(): void {
  const target = geometryRetry.value
  if (target) void saveGeometry(target.regionId, target.frame, target.kind)
}
/** 拖拽中的框选草稿（页内 CSS 像素矩形）。 */
const draftFrame = ref<{ page: number; rect: OverlayRect } | null>(null)
/** 微调草稿：区域 id + 页内矩形（null = 未在微调）。 */
const adjustDraft = ref<{ regionId: number; page: number; rect: OverlayRect } | null>(null)

let opened: OpenedPdf | null = null
let openedData: ArrayBuffer | null = null
let rebuildSeq = 0
let rebuildDone: Promise<void> = Promise.resolve()
const canvasBusy = ref(false)
const renderedPdfData = ref<ArrayBuffer | null>(null)
const canvasReady = computed(() => store.status === 'ready' && !store.refreshing && !canvasBusy.value
  && store.pdfData !== null && renderedPdfData.value === store.pdfData && pages.value.length > 0)
let observer: ResizeObserver | null = null
/** 当前批次页面（含在飞渲染的取消句柄，P22）。 */
let activePages: RenderedPage[] = []

/** 微调手柄集合（方向缩写：n 北 / e 东…组合 = 角）。 */
const ADJUST_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type AdjustHandle = (typeof ADJUST_HANDLES)[number] | 'move'
const MIN_DRAG = 3 // 小于 3px 视为点击（过滤误触）
const MIN_ADJUST = 3 // 微调矩形最小边（px）

interface DragState {
  kind: 'frame' | 'adjust'
  handle: AdjustHandle
  page: RenderedPage
  startPageX: number
  startPageY: number
  originRect: OverlayRect
  templateId: number | null
  view: number
  render: number
}

let drag: DragState | null = null

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 反向拖拽归一为左上原点矩形。 */
function normRect(x0: number, y0: number, x1: number, y1: number): OverlayRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  }
}

/** 鼠标位置 → 页容器内坐标（越界钳制到页界 = 禁止跨页框选）。 */
function pagePoint(e: MouseEvent, page: RenderedPage): { x: number; y: number } | null {
  const el = scrollRef.value?.querySelector<HTMLElement>(`[data-page="${page.index}"]`)
  if (!el) {
    return null
  }
  const box = el.getBoundingClientRect()
  return {
    x: clamp(e.clientX - box.left, 0, page.width),
    y: clamp(e.clientY - box.top, 0, page.height),
  }
}

const boundCount = computed(
  () => store.regions.filter(r => overlayKind(r) === 'bound').length,
)
// Q4：与 regionsOf 对齐，正常模式 excluded 区域不显示也不计入待校对统计
const pendingCount = computed(
  () =>
    store.regions.filter(
      r => r.bbox !== null && overlayKind(r) === 'pending' && r.review_status !== 'excluded',
    ).length,
)
/** 校对进度：非 pending 区域数 / 总数（含 bbox=null 的未定位区域）。 */
const proofreadProgress = computed(() => {
  const total = store.regions.length
  const done = store.regions.filter(r => r.review_status !== 'pending').length
  return { done, total }
})

// ---- 溢出（M7）：状态条汇总 + 点击跳转闪烁 ----

/** 闪烁定位中的区域 id（null = 无）；定时器句柄防重复点击堆叠。 */
const flashRegionId = ref<number | null>(null)
let flashTimer: number | null = null

/** 状态条 chip 点击：滚动到区域所在页顶部并闪烁高亮该区域。 */
function jumpToRegion(region: DisplayRegion): void {
  const page = region.bbox?.page
  const container = scrollRef.value
  const el =
    page === undefined || container === null
      ? null
      : container.querySelector<HTMLElement>(`[data-page="${page}"]`)
  if (!el || !container) {
    return
  }
  container.scrollTo({ top: el.offsetTop - 16, behavior: 'smooth' })
  flashRegionId.value = region.id
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer)
  }
  flashTimer = window.setTimeout(() => {
    flashRegionId.value = null
    flashTimer = null
  }, 1800)
}

/** 模板下拉（UI 调整③：从顶栏挪到本工具条，idle 态也要可选）。 */
function onTemplateChange(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value
  const menu = select.closest('details')
  if (menu) { menu.open = false; menu.querySelector('summary')?.focus() }
  void store.selectTemplate(value === '' ? null : Number(value))
}

// ---- 版本管理（M8）：下拉切换 + 新建/重命名/删除 ----

/** 当前版本名用于工具条上下文。 */
const currentVersionName = computed(
  () => store.versions.find(v => v.id === store.currentVersionId)?.name ?? '',
)
const currentDocument = computed(() => store.versions.find(version => version.id === store.currentVersionId))
const documentState = computed(() => {
  if (store.status === 'loading') return '正在打开文稿…'
  if (store.error) return '预览未更新'
  if (textEditing.value || history.pending > 0) return '正在保存修改…'
  if (textEditorTarget.value) return '编辑中 · 提交后保存'
  if (store.proofreadMode) return '正在检查所用模板'
  if (store.refreshing || canvasBusy.value) return '正在更新预览…'
  return store.currentVersionId !== null && store.status === 'ready' ? '修改已保存' : '模板原文'
})
async function openCopiedDocument(document: VersionInfo): Promise<void> {
  await store.selectTemplate(document.template_id, { versionId: document.id })
}
async function retryPreview(): Promise<void> {
  if (store.status === 'ready') await store.refreshVersionRender()
  else if (store.currentTemplateId !== null) await store.selectTemplate(store.currentTemplateId,
    !store.proofreadMode && store.currentVersionId !== null ? { versionId: store.currentVersionId } : undefined)
}

function importTemplate(): void {
  emit('import')
}

// ---- 换模板迁移（M10）：切换触发提示 → 三清单确认 → 整包落库 ----

/** 弹层阶段（null = 关闭）；migrationSource 变化驱动 prompt 出现。 */
const migrationStage = ref<'prompt' | 'plan' | null>(null)

watch(
  () => store.migrationSource,
  src => {
    migrationStage.value = src ? 'prompt' : null
  },
)

async function onMigrationProceed(): Promise<void> {
  const ok = await store.loadMigrationPlan()
  if (ok) {
    migrationStage.value = 'plan' // 失败保持 prompt，错误经 store.migrationError 内联显示
  }
}

async function onMigrationApply(bindings: { region_id: number; block_id: number }[]): Promise<void> {
  const result = await store.confirmMigration(bindings)
  if (!result.ok) {
    return // 失败弹层保持，错误内联显示
  }
  migrationStage.value = null // 成功后 watch 已因 migrationSource 清空触发，此处兜底
}

/** 关闭/跳过同语义：清掉本次迁移提示（v1 不补迁）。 */
function onMigrationClose(): void {
  store.dismissMigration()
  migrationStage.value = null
}

// ---- 导出（M9，PRD 4.8 / D5）：大超出先确认，产物落盘 + 浏览器下载 ----

/** 浏览器下载触发（blob → 临时对象 URL → a[download]；jsdom 无此 API，测试 stub）。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** 点导出：无大超出直接下载；有 → 弹警示清单（本地即时判定，服务端 409 兜底）。 */
async function onExport(): Promise<void> {
  const r = await store.requestExport(false)
  if (r.ok && r.blob && r.fileName) {
    downloadBlob(r.blob, r.fileName)
    return
  }
  if (!r.needConfirm && store.exportError) {
    window.alert(store.exportError) // 直接导出路径失败（无弹层可内联），alert 反馈
  }
}

/** 弹层确认：带 confirm 重发，成功下载并关弹层；失败弹层保持、错误内联。 */
async function onExportConfirm(): Promise<void> {
  const r = await store.requestExport(true)
  if (r.ok && r.blob && r.fileName) {
    downloadBlob(r.blob, r.fileName)
    store.dismissExportWarnings()
  }
}

function regionsOf(pageIndex: number): DisplayRegion[] {
  return store.regions.filter(r => {
    if (r.bbox === null || !(r.bbox.fragments ?? [r.bbox]).some(b => b.page === pageIndex)) {
      return false
    }
    // Q4：正常模式不显示排除区域（不参与绑定与替换）
    if (!store.proofreadMode && r.review_status === 'excluded') {
      return false
    }
    return true
  })
}

function rectStyle(rect: OverlayRect) {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
}

function overlayStyle(region: DisplayRegion, page: RenderedPage) {
  const box = (region.bbox!.fragments ?? [region.bbox!]).find(b => b.page === page.index)!
  return rectStyle(bboxToOverlayRect(box, page.viewport))
}

/** 校对模式着色：高置信候选绿 / 低置信候选黄 / 已确认蓝 / 已排除灰虚线。 */
function proofreadClass(region: DisplayRegion): string {
  if (region.review_status === 'confirmed') {
    return 'confirmed'
  }
  if (region.review_status === 'excluded') {
    return 'excluded'
  }
  return (region.confidence ?? 0) >= 0.9 ? 'cand-high' : 'cand-low'
}

/** 正常模式着色（M7 溢出优先级最高）：大超出红 / 小超出橙 / 绿=已绑定 / 黄=待校对。 */
function normalClass(region: DisplayRegion): string {
  const ov = region.overflow
  if (ov) {
    return ov.level === 'large' ? 'overflow-large' : 'overflow-small'
  }
  return overlayKind(region)
}

function overlayTitle(region: DisplayRegion): string {
  if (store.proofreadMode) {
    if (region.confidence === 0.9 && region.placeholder === null) return `标题候选：${region.label}（点击检查是否可编辑）`
    const status = region.review_status === 'pending' ? '待检查' : region.review_status === 'confirmed' ? '已保留' : '已忽略'
    return `${region.label}（${status}，点击检查或调整范围）`
  }
  let state: string
  if (region.binding?.status === 'active') {
    state = `已绑定：${region.binding.block_name ?? `块 #${region.binding.block_id}`}`
  } else if (region.binding?.status === 'missing') {
    state = '绑定块已删除，待重新绑定'
  } else {
    state = '未绑定，点击选择字符块'
  }
  const ov = region.overflow
  if (ov) {
    const hint = ov.clipped
      ? '固定行高裁剪内容，请缩短内容或调整模板行高'
      : `溢出 ${formatOverflowGrowth(ov.ratio)}（超出区域原高度）`
    return `${region.label}（${hint}；${state}）`
  }
  return `${region.label}（${state}）`
}

/** 区域点击（PRD 4.4）：左栏已选块 → 直接绑定/换绑；否则浮层选块/换绑/解绑。 */
function onRegionClick(region: DisplayRegion, page: RenderedPage): void {
  if (frameMode.value || frameStarting.value || geometryBusy.value || !canvasReady.value) return
  if (store.proofreadMode) {
    lastReviewRegionId = region.id
    // 校对模式：区域点击 = 校对操作浮层（确认/排除/微调/删除）
    popoverTarget.value = { region, page }
    return
  }
  const selectedId = blocksStore.selectedBlockId
  if (selectedId !== null) {
    void store.bindRegionToBlock(region.id, selectedId)
    return
  }
  dialogRegion.value = region
}

async function onDialogBind(blockId: number, lineBreakMode: 'paragraph' | 'soft' = 'paragraph', position: 'inside' | 'before' | 'after' = 'inside'): Promise<void> {
  const region = dialogRegion.value
  dialogRegion.value = null
  if (region) {
    if (position !== 'inside') await store.bindRegionToBlock(region.id, blockId, lineBreakMode, position)
    else if (lineBreakMode === 'paragraph') await store.bindRegionToBlock(region.id, blockId)
    else await store.bindRegionToBlock(region.id, blockId, lineBreakMode)
  }
}

async function onDialogUnbind(): Promise<void> {
  const region = dialogRegion.value
  dialogRegion.value = null
  if (region) {
    await store.unbindRegionFromBlock(region.id)
  }
}

// ---- 校对模式（M5b）：框选 / 微调 / 操作浮层 ----

function beginFrameDrag(e: MouseEvent, page: RenderedPage): void {
  if (e.button !== 0 || !frameMode.value || !store.proofreadMode || !canvasReady.value
      || frameStarting.value || geometryBusy.value || nameDialog.value !== null || adjustDraft.value !== null) {
    return
  }
  const pt = pagePoint(e, page)
  if (!pt) {
    return
  }
  popoverTarget.value = null // 框选开始即收起校对浮层
  drag = {
    kind: 'frame',
    handle: 'move',
    page,
    startPageX: pt.x,
    startPageY: pt.y,
    originRect: { left: pt.x, top: pt.y, width: 0, height: 0 },
    templateId: store.currentTemplateId,
    view: viewIdentity,
    render: rebuildSeq,
  }
  draftFrame.value = { page: page.index, rect: { ...drag.originRect } }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

/** 启动微调拖拽（手柄缩放 / 主体移动）。 */
function beginAdjustDrag(
  e: MouseEvent,
  handle: AdjustHandle,
  region: DisplayRegion,
  page: RenderedPage,
): void {
  if (e.button !== 0 || region.bbox === null || geometryBusy.value || frameStarting.value || !canvasReady.value) {
    return
  }
  e.preventDefault()
  e.stopPropagation()
  const pt = pagePoint(e, page)
  if (!pt) {
    return
  }
  const box = (region.bbox.fragments ?? [region.bbox]).find(b => b.page === page.index)!
  const originRect = adjustDraft.value?.regionId === region.id && adjustDraft.value.page === page.index
    ? { ...adjustDraft.value.rect } : bboxToOverlayRect(box, page.viewport)
  frameError.value = null; geometryRetry.value = null
  drag = { kind: 'adjust', handle, page, startPageX: pt.x, startPageY: pt.y, originRect,
    templateId: store.currentTemplateId, view: viewIdentity, render: rebuildSeq }
  adjustDraft.value = { regionId: region.id, page: page.index, rect: { ...originRect } }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent): void {
  if (!drag || drag.render !== rebuildSeq || !canvasReady.value) {
    return
  }
  const pt = pagePoint(e, drag.page)
  if (!pt) {
    return
  }
  const { startPageX: sx, startPageY: sy, originRect: o, handle } = drag
  if (drag.kind === 'frame') {
    draftFrame.value = { page: drag.page.index, rect: normRect(sx, sy, pt.x, pt.y) }
    return
  }
  const r: OverlayRect = { ...o }
  const dx = pt.x - sx
  const dy = pt.y - sy
  if (handle === 'move') {
    r.left = clamp(o.left + dx, 0, drag.page.width - o.width)
    r.top = clamp(o.top + dy, 0, drag.page.height - o.height)
  } else {
    // includes 语义恰好覆盖组合角（'ne' 同时含 n/e），单独方向只含自身
    if (handle.includes('w')) {
      const nl = clamp(o.left + dx, 0, o.left + o.width - MIN_ADJUST)
      r.width = o.left + o.width - nl
      r.left = nl
    }
    if (handle.includes('e')) {
      r.width = clamp(o.left + o.width + dx, o.left + MIN_ADJUST, drag.page.width) - o.left
    }
    if (handle.includes('n')) {
      const nt = clamp(o.top + dy, 0, o.top + o.height - MIN_ADJUST)
      r.height = o.top + o.height - nt
      r.top = nt
    }
    if (handle.includes('s')) {
      r.height = clamp(o.top + o.height + dy, o.top + MIN_ADJUST, drag.page.height) - o.top
    }
  }
  adjustDraft.value = { regionId: adjustDraft.value?.regionId ?? 0, page: drag.page.index, rect: r }
}

function onDragEnd(): void {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  const d = drag
  drag = null
  if (!d) return
  if (d.view !== viewIdentity || d.render !== rebuildSeq || d.templateId !== store.currentTemplateId || !canvasReady.value) {
    draftFrame.value = null
    if (d.kind === 'adjust') adjustDraft.value = null
    return
  }
  if (d.kind === 'frame') {
    const rect = draftFrame.value?.rect
    draftFrame.value = null
    if (!rect || rect.width < MIN_DRAG || rect.height < MIN_DRAG) {
      return // 视为点击，不误开命名弹层
    }
    const b = overlayRectToBBox(rect, d.page.viewport)
    if (frameTarget.value) {
      void saveGeometry(frameTarget.value.id, { page: d.page.index, ...b }, 'relocate')
      return
    }
    nameError.value = null
    nameDialog.value = {
      frame: { page: d.page.index, ...b },
      suggestedName: frameDetails.value?.name ?? nextRegionName.value,
      suggestedType: frameDetails.value?.type ?? 'custom',
    }
    return
  }
  const rect = adjustDraft.value?.rect
  const regionId = adjustDraft.value?.regionId
  if (!rect || !regionId) {
    return
  }
  const b = overlayRectToBBox(rect, d.page.viewport)
  void saveGeometry(regionId, { page: d.page.index, ...b }, 'adjust')
}

/** Esc 取消微调（草稿丢弃，区域保持原 bbox）。 */
function cancelAdjust(): void {
  if (regionWriteBusy.value) return
  adjustDraft.value = null
  drag = null
  geometryRetry.value = null; frameError.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}
function onCancelAdjust(e: KeyboardEvent): void {
  if (geometryBusy.value || nameSubmitting.value) return
  if (e.key === 'Escape' && frameMode.value && !nameDialog.value) cancelFrame()
  if (e.key === 'Escape' && adjustDraft.value) cancelAdjust()
}

function reframeNamedRegion(label: string, type: string): void {
  if (regionWriteBusy.value || !nameDialog.value) return
  frameDetails.value = { name: label, type }
  nameDialog.value = null; nameError.value = null
  frameMode.value = true; frameTarget.value = null; regionTask.value = 'add'
}

async function onNameSubmit(label: string, type: string, continueAdding = false): Promise<void> {
  const target = nameDialog.value
  if (!target || nameSubmitting.value || !canvasReady.value) {
    return
  }
  nameSubmitting.value = true
  nameError.value = null
  const identity = viewIdentity, templateId = store.currentTemplateId
  let result: { ok: boolean; error: string | null }
  try { result = await store.createFrameRegion(target.frame, label, type) }
  catch (err) { result = { ok: false, error: err instanceof Error ? err.message : String(err) } }
  if (disposed || identity !== viewIdentity || templateId !== store.currentTemplateId || nameDialog.value !== target) return
  nameSubmitting.value = false
  if (!result.ok) {
    nameError.value = result.error
    return
  }
  nameDialog.value = null
  frameDetails.value = null
  regionMessage.value = `已保存区域「${label}」${continueAdding ? '，可继续框选下一处。' : '。'}`
  if (continueAdding) {
    frameMode.value = true; frameTarget.value = null; regionTask.value = 'add'
  } else await finishRegionReview()
}

async function saveProofread(action: 'confirm' | 'exclude' | 'reopen' | 'remove'): Promise<void> {
  const target = popoverTarget.value
  if (!target || proofreadBusy.value) return
  const identity = viewIdentity
  proofreadBusy.value = true; proofreadError.value = null
  try {
    const result = await (action === 'confirm' ? store.confirmRegion(target.region.id)
      : action === 'exclude' ? store.excludeRegion(target.region.id)
      : action === 'reopen' ? store.reopenRegion(target.region.id)
      : store.removeRegion(target.region.id))
    if (disposed || identity !== viewIdentity || popoverTarget.value !== target) return
    if (result.ok) popoverTarget.value = null
    else proofreadError.value = result.error
  } finally { if (!disposed && identity === viewIdentity) proofreadBusy.value = false }
}

function onPopoverConfirm(): void { void saveProofread('confirm') }
function onPopoverExclude(): void { void saveProofread('exclude') }
function onPopoverReopen(): void { void saveProofread('reopen') }

function onPopoverAdjust(): void {
  if (geometryBusy.value || !canvasReady.value) return
  const t = popoverTarget.value
  popoverTarget.value = null
  if (!t || t.region.bbox === null) {
    return
  }
  frameError.value = null; geometryRetry.value = null
  adjustDraft.value = {
    regionId: t.region.id,
    page: t.page.index,
    rect: bboxToOverlayRect(
      (t.region.bbox.fragments ?? [t.region.bbox]).find(b => b.page === t.page.index)!,
      t.page.viewport,
    ),
  }
}

async function onPopoverRemove(): Promise<void> {
  const t = popoverTarget.value
  if (!t) {
    return
  }
  if (!window.confirm(`删除区域「${t.region.label}」？其绑定关系将一并删除。`)) {
    return
  }
  await saveProofread('remove')
}

/** 重建渲染：pdfData 变化重开文档；容器宽度变化仅按新 scale 重排。 */
function rebuild(): void {
  const seq = ++rebuildSeq
  canvasBusy.value = true
  renderedPdfData.value = null
  rebuildDone = doRebuild(seq).catch(err => {
    if (err instanceof Error && err.name === 'RenderingCancelledException') {
      return // 主动取消属正常流程（P22）
    }
    console.error('[TemplatePreview] 渲染失败：', err)
    if (seq === rebuildSeq && store.proofreadMode) frameError.value = '模板预览生成失败，请重新打开模板后重试'
  }).finally(() => {
    if (seq === rebuildSeq) canvasBusy.value = false
  })
}

async function doRebuild(seq: number): Promise<void> {
  // P22：先取消上一批在飞渲染——seq 守卫拦不住已开始的 page.render，
  // 新旧批次并发打同一 canvas 会被 pdfjs 拒绝（白板根因）
  for (const p of activePages) {
    p.cancel()
  }
  activePages = []
  const data = store.pdfData
  if (data === null) {
    await opened?.destroy()
    opened = null
    openedData = null
    pages.value = []
    return
  }
  // loading 态 v-else 未渲染（DOM 无 canvas）→ 等 status 就绪后
  // watcher 再次触发 rebuild 补渲染（canvas 未就绪另有兜底检查）
  if (store.status !== 'ready') {
    return
  }
  if (opened === null || openedData !== data) {
    const previous = opened
    opened = null
    openedData = null
    const doc = await openDocument(data)
    if (seq !== rebuildSeq) {
      void doc.destroy()
      await previous?.destroy()
      return
    }
    await previous?.destroy()
    opened = doc
    openedData = data
  }
  if (seq !== rebuildSeq) {
    return
  }
  const width = containerWidth.value
  const document = opened.document
  const hashes = [...store.pageFingerprints]
  const first = await document.getPage(1)
  if (seq !== rebuildSeq) return
  const base = first.getViewport({ scale: 1 })
  const scale = previewScale(zoom.value, width, containerHeight.value, base.width, base.height)
  renderedScale.value = scale
  const list: RenderedPage[] = []
  for (let i = 1; i <= document.numPages; i++) {
    const page = await document.getPage(i)
    if (seq !== rebuildSeq) return
    list.push(preparePage(page, scale))
  }
  if (seq !== rebuildSeq) {
    return
  }
  pages.value = list
  activePages = list
  await nextTick()
  if (seq !== rebuildSeq) {
    return
  }
  const canvases = Array.from(scrollRef.value?.querySelectorAll('canvas') ?? [])
  if (canvases.length !== list.length) {
    console.warn('[TemplatePreview] canvas 未就绪，跳过本轮渲染')
    return
  }
  await Promise.all(list.map(async (p, i) => {
    const canvas = canvases[i]
    const content = hashes.length === list.length ? hashes[i] : data
    const layout = `${p.index}:${scale}:${p.width}:${p.height}:${window.devicePixelRatio || 1}`
    if (canvasCache.matches(canvas, content, layout)) return
    canvasCache.forget(canvas) // cancelled/failed renders must never become reusable
    await p.render(canvas)
    if (seq === rebuildSeq) {
      canvasCache.completed(canvas, content, layout)
      canvas.dataset.renderCount = String(Number(canvas.dataset.renderCount ?? 0) + 1)
    }
  }))
  if (seq === rebuildSeq) renderedPdfData.value = data
}

watch(
  () => [store.pdfData, containerWidth.value, containerHeight.value, zoom.value, store.regions, store.status],
  () => {
    rebuild()
  },
)

watch(() => store.currentTemplateId, () => {
  viewIdentity++; frameStartRequest++; reviewFinishRequest++; frameStarting.value = false
  proofreadBusy.value = false; proofreadError.value = null
  geometryBusy.value = false; geometryRetry.value = null; nameSubmitting.value = false
  reviewStarting.value = false; reviewFinishing.value = false; regionTask.value = null; documentReturn = null; regionMessage.value = ''
  clearFrameDraft()
  nameDialog.value = null; frameDetails.value = null
  textEditorTarget.value = null
  popoverTarget.value = null
  adjustDraft.value = null
}, { flush: 'sync' })

// 切换校对模式：关闭所有弹层与草稿（popover 持有的 RenderedPage 引用即将失效）
watch(
  () => store.proofreadMode,
  on => {
    viewIdentity++
    proofreadBusy.value = false; proofreadError.value = null
    if (!on) { frameStartRequest++; frameStarting.value = false; reviewStarting.value = false; regionTask.value = null }
    geometryBusy.value = false; geometryRetry.value = null; nameSubmitting.value = false
    clearFrameDraft()
    textEditorTarget.value = null
    popoverTarget.value = null
    nameDialog.value = null
    nameError.value = null
    draftFrame.value = null
    adjustDraft.value = null
    migrationStage.value = null
    store.dismissMigration()
    store.dismissExportWarnings()
  },
  { flush: 'sync' },
)

onMounted(() => {
  if (store.templates.length === 0) void store.loadTemplates()
  containerWidth.value = scrollRef.value?.clientWidth ?? 0
  containerHeight.value = scrollRef.value?.clientHeight ?? 0
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      containerWidth.value = scrollRef.value?.clientWidth ?? 0
      containerHeight.value = scrollRef.value?.clientHeight ?? 0
    })
    if (scrollRef.value) {
      observer.observe(scrollRef.value)
    }
  }
  window.addEventListener('keydown', onCancelAdjust)
})

onBeforeUnmount(() => {
  disposed = true; viewIdentity++; frameStartRequest++
  observer?.disconnect()
  window.removeEventListener('keydown', onCancelAdjust)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer)
    flashTimer = null
  }
  rebuildSeq++
  for (const p of activePages) {
    p.cancel()
  }
  activePages = []
  void opened?.destroy()
  opened = null
  openedData = null
})
defineExpose({ jumpToRegion })
</script>

<template>
  <!-- 右栏：版本预览（模板+绑定替换成品）——pdfjs 渲染管线 PDF + 可交互覆盖层 -->
  <section class="template-preview">
    <!-- M13：固定块库入口、模板/版本组、导出主按钮；窄屏图例保留入口 -->
    <div class="preview-toolbar">
      <div class="toolbar-left">
        <button
          class="library-expand"
          :title="blocksStore.libraryOpen ? '收起块库' : '展开块库'"
          :aria-expanded="blocksStore.libraryOpen"
          aria-label="切换块库"
          @click="blocksStore.toggleLibrary()"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <rect
              x="0.75"
              y="0.75"
              width="12.5"
              height="12.5"
              rx="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4.5"
              y1="3.5"
              x2="4.5"
              y2="10.5"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <line
              x1="8"
              y1="3.5"
              x2="8"
              y2="10.5"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
          块库
        </button>
        <div class="document-context">
          <h1 data-testid="current-document-name">
            {{ currentVersionName || (store.currentVersionId === null ? '模板原文' : '文稿') }}
          </h1>
          <div class="context-meta">
            <button
              class="template-context"
              :disabled="regionWriteBusy"
              title="浏览所用模板，不更改当前文稿"
              @click="app.openTemplates(store.currentTemplateId)"
            >
              模板：{{ store.currentTemplate?.filename ?? '尚未选择' }}
            </button>
            <span
              class="save-status"
              role="status"
              data-testid="document-save-state"
            >{{ documentState }}</span>
          </div>
        </div>
        <DocumentActions
          v-if="currentDocument"
          :document="currentDocument"
          :can-delete="true"
          :disabled="store.proofreadMode || store.exportBusy || regionWriteBusy || store.refreshing || store.status !== 'ready'"
          @open="openCopiedDocument"
        >
          <label class="template-change">更换模板
            <select
              class="template-select"
              aria-label="更换模板"
              :value="store.currentTemplateId ?? ''"
              :disabled="store.proofreadMode || store.refreshing || regionWriteBusy || store.status !== 'ready'"
              @change="onTemplateChange"
            >
              <option
                v-for="template in store.templates"
                :key="template.id"
                :value="template.id"
              >{{ template.filename }}</option>
            </select>
          </label>
        </DocumentActions>
        <template v-if="store.currentVersionId !== null">
          <button
            class="tool-btn"
            :disabled="store.proofreadMode || store.exportBusy || store.refreshing || store.status !== 'ready'"
            title="保存此刻的 Word 和 PDF 到独立归档库"
            data-testid="archive-btn"
            @click="emit('archive')"
          >
            归档
          </button>
          <button
            class="tool-btn primary"
            :disabled="store.proofreadMode || store.exportBusy"
            title="导出当前版本成品 DOCX（存在大超出时先确认）"
            data-testid="export-btn"
            @click="onExport"
          >
            导出
          </button>
        </template>
      </div>
    </div>
    <div
      v-if="store.status === 'ready'"
      class="preview-controls"
    >
      <div class="preview-context">
        <span
          v-if="blocksStore.selectedBlock && !store.proofreadMode"
          class="selected-context"
        >已选：{{ blocksStore.selectedBlock.name }} <button
          class="clear-selection"
          aria-label="取消选中的内容块"
          @click="blocksStore.selectBlock(blocksStore.selectedBlock.id)"
        >×</button></span>
        <span
          v-if="store.refreshing"
          class="refreshing"
        ><span class="spinner" />正在刷新预览…</span>
        <span
          v-if="!store.proofreadMode"
          class="legend legend-wide"
        >
          <span>已绑定 {{ boundCount }}</span>
          <span>待绑定 {{ pendingCount }}</span>
          <span v-if="unplaced.length">未定位 {{ unplaced.length }}</span>
        </span>
        <span
          v-if="regionMessage"
          class="region-feedback"
          role="status"
        >{{ regionMessage }}</span>
      </div>
      <div class="region-tools">
        <template v-if="!store.proofreadMode">
          <button
            class="tool-btn"
            aria-label="检查可编辑区域"
            data-testid="review-regions"
            :disabled="regionEntryBusy || reviewFinishing"
            @click="beginRegionReview"
          >
            检查区域
          </button>
          <button
            class="tool-btn"
            data-testid="add-region"
            :disabled="regionEntryBusy || reviewFinishing"
            @click="startFrame()"
          >
            添加区域
          </button>
        </template>
        <details
          ref="previewTools"
          name="preview-toolbar-menu"
          class="legend-menu"
          @keydown.esc.stop.prevent="closePreviewTools(true)"
        >
          <summary aria-label="预览工具">
            预览工具 <span>{{ pages.length }} 页</span>
          </summary>
          <div class="preview-options">
            <label class="zoom-control">缩放
              <select
                v-model="zoom"
                aria-label="预览缩放"
              ><option value="page">整页</option><option value="width">适合宽度</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>
              <span>{{ Math.round(renderedScale * 100) }}%</span>
            </label>
            <p class="legend-title">
              区域图例
            </p>
            <div class="legend">
              <template v-if="store.proofreadMode">
                <span><i class="dot cand-high" />高置信候选</span>
                <span><i class="dot cand-low" />低置信候选</span>
                <span><i class="dot confirmed" />已确认</span>
                <span><i class="dot excluded" />已排除</span>
              </template>
              <template v-else>
                <span><i class="dot bound" />已绑定</span>
                <span><i class="dot pending" />待绑定</span>
                <span><i class="dot unrecognized" />未定位</span>
              </template>
            </div>
          </div>
        </details>
      </div>
    </div>

    <!-- 绑定/刷新错误横幅（不动摇 ready 态的已渲染内容） -->
    <div
      v-if="store.status === 'ready' && store.error"
      class="error-banner"
    >
      {{ store.error }}
      <button
        class="tool-btn"
        :disabled="store.refreshing"
        @click="retryPreview"
      >
        重试预览
      </button>
    </div>

    <section
      v-if="store.proofreadMode"
      class="frame-guide"
      aria-label="模板区域任务"
    >
      <div class="region-task-head">
        <strong>{{ regionTask === 'add' ? '添加可编辑区域' : regionTask === 'relocate' ? `重新定位「${frameTarget?.label ?? '区域'}」` : '检查可编辑区域' }}</strong>
        <button
          class="tool-btn"
          data-testid="finish-region-review"
          :disabled="regionWriteBusy || frameStarting || reviewStarting || reviewFinishing || store.status !== 'ready' || store.refreshing"
          @click="finishRegionReview"
        >
          完成并返回文档
        </button>
      </div>
      <p class="region-task-scope">
        {{ regionTemplateName }} · 区域设置用于此模板的所有内容版本
      </p>
      <div class="region-task-actions">
        <template v-if="frameStarting || reviewStarting">
          <span role="status">正在准备模板原文，请稍候…</span>
          <button
            v-if="frameStarting"
            class="tool-btn"
            data-testid="cancel-region-task"
            @click="cancelFrame"
          >
            取消框选
          </button>
        </template>
        <template v-else-if="frameMode">
          <span>{{ frameTarget ? `重新定位「${frameTarget.label}」：` : '添加可编辑区域：' }}在文字上拖出矩形框，每次选择一个段落。</span>
          <button
            class="tool-btn"
            data-testid="cancel-region-task"
            :disabled="regionWriteBusy"
            @click="cancelFrame"
          >
            {{ frameTarget ? '取消定位' : '取消添加' }}
          </button>
        </template>
        <template v-else-if="adjustDraft">
          <span>调整范围：拖动蓝框或边缘，松开后保存。</span>
          <button
            class="tool-btn"
            data-testid="cancel-region-adjust"
            :disabled="regionWriteBusy"
            @click="cancelAdjust"
          >
            取消调整
          </button>
        </template>
        <template v-else>
          <span data-testid="proofread-progress">已处理 {{ proofreadProgress.done }}/{{ proofreadProgress.total }}</span>
          <button
            class="tool-btn"
            :disabled="regionEntryBusy || !pendingReviewRegions.length"
            @click="nextReviewRegion"
          >
            下一处待检查
          </button>
          <button
            class="tool-btn"
            data-testid="add-region"
            :disabled="regionEntryBusy"
            @click="startFrame()"
          >
            添加区域
          </button>
        </template>
        <span
          v-if="geometryBusy"
          role="status"
        >正在保存区域位置…</span>
      </div>
      <p
        v-if="frameError"
        class="error"
        role="alert"
      >
        {{ frameError }}
      </p>
      <button
        v-if="frameError && geometryRetry"
        class="tool-btn"
        :disabled="geometryBusy"
        data-testid="retry-region-position"
        @click="retryGeometry"
      >
        重试保存位置
      </button>
    </section>

    <div
      ref="scrollRef"
      class="preview-scroll"
    >
      <div
        v-if="store.status === 'idle'"
        class="state empty"
      >
        <div class="welcome-card">
          <span
            class="welcome-icon"
            aria-hidden="true"
          >▤</span>
          <h1>选择文稿开始编辑</h1>
          <p>文稿按模板整理，选择已有稿件或新建一份。</p>
          <div class="welcome-actions">
            <button
              class="ui-btn ui-primary"
              @click="importTemplate"
            >
              导入模板
            </button><button
              class="ui-btn"
              @click="app.setTab('documents')"
            >
              查看文稿
            </button>
          </div>
          <span class="welcome-hint">模板与素材可从顶部独立管理。</span>
        </div>
      </div>
      <div
        v-else-if="store.status === 'loading'"
        class="state loading"
      >
        <span class="spinner" />
        正在生成预览…首次转换或较大文档可能需要更久。
      </div>
      <div
        v-else-if="store.status === 'error'"
        class="state error"
      >
        {{ store.error }}
        <button
          class="ui-btn"
          @click="retryPreview"
        >
          重试预览
        </button>
      </div>
      <template v-else>
        <div
          v-for="page in pages"
          :key="page.index"
          class="pdf-page"
          :data-page="page.index"
          :style="{ width: `${page.width}px`, height: `${page.height}px` }"
          @mousedown="beginFrameDrag($event, page)"
        >
          <canvas class="pdf-canvas" />
          <!-- 覆盖层：正常模式 绿=已绑定/黄=待校对；校对模式 按校对态+置信度着色 -->
          <template
            v-for="region in regionsOf(page.index)"
            :key="region.id"
          >
            <!-- 微调中：蓝框 + 8 方向手柄 + 主体拖移（Esc 取消） -->
            <div
              v-if="adjustDraft?.regionId === region.id"
              class="overlay adjusting"
              :style="rectStyle(adjustDraft.rect)"
              data-testid="adjust-frame"
              @mousedown="beginAdjustDrag($event, 'move', region, page)"
            >
              <span
                v-for="h in ADJUST_HANDLES"
                :key="h"
                class="handle"
                :class="`h-${h}`"
                @mousedown="beginAdjustDrag($event, h, region, page)"
              />
            </div>
            <div
              v-else
              class="overlay"
              :class="[
                store.proofreadMode ? proofreadClass(region) : normalClass(region),
                { flashing: flashRegionId === region.id, heading: region.confidence === 0.9 && region.placeholder === null },
              ]"
              :style="overlayStyle(region, page)"
              :title="overlayTitle(region)"
              role="button"
              :aria-disabled="!canvasReady || regionWriteBusy"
              :data-region-id="region.id"
              tabindex="0"
              @click="onRegionClick(region, page)"
              @keydown.enter="onRegionClick(region, page)"
              @mousedown.stop="frameMode && beginFrameDrag($event, page)"
            />
          </template>
          <!-- 框选草稿（虚线蓝框，pointer-events 穿透） -->
          <div
            v-if="draftFrame?.page === page.index"
            class="draft-frame"
            :style="rectStyle(draftFrame.rect)"
          />
        </div>
        <!-- 未定位区域（bbox=null）：无几何坐标，以虚线徽标提示，M5b 校对兜底 -->
        <div
          v-if="unplaced.length > 0"
          class="unplaced-bar"
        >
          <span class="unplaced-title">以下区域还未定位，点击后在文字上重新框选：</span>
          <button
            v-for="region in unplaced"
            :key="region.id"
            class="unplaced-chip"
            :disabled="regionEntryBusy || frameMode"
            :title="`重新定位：${region.label}`"
            @click="startFrame(region)"
          >
            {{ region.label }} · 重新框选
          </button>
        </div>
        <div
          v-if="removedRegions.length && !store.proofreadMode"
          class="unplaced-bar"
          aria-label="已删除段落"
        >
          <span>已删除段落（当前版本）</span>
          <button
            v-for="region in removedRegions"
            :key="region.id"
            :disabled="store.refreshing"
            @click="restoreParagraph(region.id)"
          >
            {{ region.label }} · 恢复
          </button>
        </div>
        <!-- 绑定弹层（全窗模态，正常模式） -->
        <BindingDialog
          v-if="dialogRegion"
          :region="dialogRegion"
          :blocks="blocksStore.libraryBlocks"
          @bind="onDialogBind"
          @edit="openTextEditor"
          @unbind="onDialogUnbind"
          @close="dialogRegion = null"
        />
        <RegionTextEditor
          v-if="textEditorTarget"
          :region="textEditorTarget"
          :submitting="textEditing"
          :error="textEditError"
          @save="saveText"
          @remove="removeTextParagraph"
          @close="textEditorTarget = null"
        />
        <!-- 校对操作浮层（校对模式） -->
        <ProofreadPopover
          v-if="popoverTarget"
          :region="popoverTarget.region"
          :busy="proofreadBusy"
          :error="proofreadError"
          @confirm="onPopoverConfirm"
          @exclude="onPopoverExclude"
          @reopen="onPopoverReopen"
          @adjust="onPopoverAdjust"
          @remove="onPopoverRemove"
          @close="!proofreadBusy && (popoverTarget = null)"
        />
        <!-- 框选命名弹层（校对模式） -->
        <RegionNameDialog
          v-if="nameDialog"
          :error="nameError"
          :submitting="nameSubmitting"
          :initial-name="nameDialog.suggestedName"
          :initial-type="nameDialog.suggestedType"
          @submit="onNameSubmit"
          @reframe="reframeNamedRegion"
          @close="cancelFrame"
        />
        <!-- 迁移弹层（M10：切到新模板时提示/三清单确认） -->
        <MigrationDialog
          v-if="migrationStage && store.migrationSource"
          :stage="migrationStage"
          :source-template-name="store.migrationSource.sourceTemplateName"
          :source-version-name="store.migrationSource.sourceVersionName"
          :source-binding-count="store.migrationSource.sourceBindingCount"
          :target-template-name="store.currentTemplate?.filename ?? ''"
          :plan="store.migrationPlan"
          :error="store.migrationError"
          :submitting="store.migrationBusy"
          @proceed="onMigrationProceed"
          @skip="onMigrationClose"
          @apply="onMigrationApply"
          @close="onMigrationClose"
        />
        <!-- 导出大超出警示弹层（M9：清单确认后重排导出） -->
        <ExportDialog
          v-if="store.exportWarnings.length > 0"
          :warnings="store.exportWarnings"
          :error="store.exportError"
          :submitting="store.exportBusy"
          @confirm="onExportConfirm"
          @close="store.dismissExportWarnings()"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.template-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  background: var(--bg-preview);
  container-type: inline-size;
}

.preview-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border); }
.toolbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; width: 100%; }
.document-context { flex: 1; min-width: 0; }
.document-context h1 { font-size: 15px; line-height: 1.6; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-meta { display: flex; align-items: center; gap: 10px; min-width: 0; }
.template-context { min-width: 0; max-width: 65%; border: 0; padding: 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; font-size: 11px; line-height: 1.6; color: var(--text-2); text-align: left; }
.save-status { font-size: 11px; color: var(--text-3); white-space: nowrap; }
.template-change { display: flex; flex-direction: column; padding: 9px 10px; gap: 6px; font-size: 12px; color: var(--text-2); }
@container (max-width: 600px) { .document-context { flex: 1 0 calc(100% - 80px); } .toolbar-left { flex-wrap: wrap; } .context-meta { flex-wrap: wrap; gap: 2px 8px; } .template-context { max-width: 100%; } }
.overlay.heading { border-style: dashed; }
.frame-guide { flex-shrink: 0; background: var(--bg-panel); padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-2); }
.region-task-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; color: var(--text-1); }
.region-task-head strong { font-size: 13px; }
.region-task-scope { margin: 3px 0 8px; overflow-wrap: anywhere; font-size: 11px; color: var(--text-3); }
.region-task-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; line-height: 1.6; }
.region-task-actions .tool-btn, .region-task-head .tool-btn { min-height: 30px; padding: 4px 8px; font-size: 12px; }
.frame-guide > .error { margin: 6px 0; color: var(--danger); }
.region-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; pointer-events: auto; }
.region-tools > .tool-btn { min-height: 32px; padding: 5px 8px; font-size: 12px; }
.region-feedback { line-height: 1.6; color: var(--success); overflow-wrap: anywhere; }
.selection-group { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.context-select { display: flex; min-width: 0; flex: 1.5; max-width: 340px; }
.context-select > span { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.version-context { flex: 1; max-width: 180px; }
.template-select { width: 100%; min-width: 0; min-height: 34px; padding: 6px 8px; font-size: 12px; color: var(--text-1); text-overflow: ellipsis; border: 1px solid var(--border); border-radius: 6px; }
.library-expand, .tool-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 9px; font-size: 13px; color: var(--text-2); background: var(--bg-surface); border: 1px solid transparent; border-radius: 6px; white-space: nowrap; cursor: pointer; flex-shrink: 0; }
.library-expand:hover, .tool-btn:hover { background: var(--bg-hover); }
.tool-btn[data-testid=archive-btn] { border-color: var(--border); color: var(--text-1); }
.tool-btn.primary { color: var(--text-on-primary); background: var(--primary); border-color: var(--primary); }
.tool-btn.primary:hover { background: var(--primary-hover); }
.preview-controls { position: relative; order: 3; z-index: 6; flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 6px 12px; border-top: 1px solid var(--border); background: var(--bg-preview); font-size: 12px; color: var(--text-2); pointer-events: none; }
.preview-context { display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.zoom-control { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.zoom-control select { flex: 1; min-width: 0; min-height: 30px; padding: 4px 6px; font-size: 12px; }
.selected-context { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary); background: var(--bg-surface); border-radius: 6px; padding: 4px 8px; pointer-events: auto; }
.clear-selection { border: none; padding: 2px 4px; color: var(--text-2); }
.legend.legend-wide { gap: 10px; flex-wrap: wrap; font-size: 11px; }
.legend-menu { position: relative; flex-shrink: 0; pointer-events: auto; }
.legend-menu summary { padding: 7px 10px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px; cursor: pointer; white-space: nowrap; box-shadow: 0 2px 8px var(--shadow-page); }
.legend-menu summary > span { color: var(--text-3); margin-left: 8px; font-size: 11px; }
.legend-menu > .preview-options { display: none; }
.legend-menu[open] > .preview-options { display: flex; flex-direction: column; gap: 14px; position: absolute; right: 0; bottom: calc(100% + 8px); width: min(300px, calc(100vw - 32px)); max-height: calc(100dvh - 200px); overflow: auto; padding: 16px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; z-index: 10; box-shadow: 0 4px 16px var(--shadow-modal); }
.preview-options .tool-btn { justify-content: flex-start; border-color: var(--border); }
.preview-options .legend { flex-wrap: wrap; gap: 10px; }
.preview-options .legend > span { display: inline-flex; align-items: center; gap: 6px; }
.preview-options .dot { margin: 0; }
.legend-title { font-size: 11px; color: var(--text-3); }
@container (max-width: 560px) { .toolbar-left { flex-wrap: wrap; } .selection-group { order: 2; flex-basis: 100%; } .context-select { max-width: none; } .library-expand { margin-right: auto; } }
@container (max-width: 420px) { .tool-btn, .library-expand { padding: 6px 8px; font-size: 12px; } .toolbar-left { gap: 6px; } .preview-controls { gap: 6px; } .legend.legend-wide { gap: 6px; font-size: 10px; } }
@container (max-width: 560px) { .preview-context { flex-basis: 100%; } .region-tools { margin-left: auto; } }

.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.refreshing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
  color: var(--primary);
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 12px;
  border-radius: 2px;
}

.dot.bound {
  background: var(--success-bg-legend);
  border: 1px solid var(--success);
}

.dot.pending {
  background: var(--candidate-bg-legend);
  border: 1px solid var(--candidate);
}

.dot.unrecognized {
  background: transparent;
  border: 1px dashed var(--region-unplaced);
}

.error-banner {
  padding: 6px 16px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-bg-hover);
  border-bottom: 1px solid var(--danger-border-subtle);
}

.preview-scroll {
  flex: 1;
  overflow: auto;
  padding: 16px;
  position: relative;
  min-height: 0;
}

.state {
  height: 100%;
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}

.state.error {
  color: var(--danger);
}

.state.loading {
  gap: 8px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-control);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.pdf-page {
  position: relative;
  background: var(--bg-surface);
  box-shadow: 0 1px 4px var(--shadow-page);
  flex-shrink: 0;
}

.pdf-canvas {
  display: block;
}

.overlay {
  position: absolute;
  cursor: pointer;
}

/* 绿=已绑定（active） */
.overlay.bound {
  border: 1.5px solid var(--success);
  background: var(--success-bg-region);
}

/* 黄=待校对（未绑定或 missing 回落） */
.overlay.pending {
  border: 1.5px solid var(--candidate);
  background: var(--candidate-bg-region);
}

/* ---- 溢出分级（M7，正常模式，优先级高于绑定态着色）---- */

/* 大超出 = 红 */
.overlay.overflow-large {
  border: 1.5px solid var(--danger);
  background: var(--danger-bg-region);
}

/* 小超出 = 橙（覆盖绑定态绿：分级警示优先于绑定语义） */
.overlay.overflow-small {
  border: 1.5px solid var(--warning);
  background: var(--warning-bg-region);
}

/* 状态条 chip 跳转后的闪烁定位（蓝色环，与分级色无关） */
.overlay.flashing {
  animation: region-flash 0.6s ease-in-out 3;
}

@keyframes region-flash {
  0%,
  100% {
    box-shadow: none;
  }
  50% {
    box-shadow: 0 0 0 4px var(--primary-flash-ring);
  }
}

.overlay:hover {
  border-color: var(--primary);
}

/* ---- 校对模式（M5b）---- */

/* 高置信候选（confidence ≥ 0.9）= 绿 */
.overlay.cand-high {
  border: 1.5px solid var(--success);
  background: var(--success-bg-confirmed);
}

/* 低置信候选 = 黄 */
.overlay.cand-low {
  border: 1.5px solid var(--candidate);
  background: var(--candidate-bg-low);
}

/* 已确认 = 蓝 */
.overlay.confirmed {
  border: 1.5px solid var(--primary);
  background: var(--primary-bg-region);
}

/* 已排除 = 灰虚线（正常模式下不渲染） */
.overlay.excluded {
  border: 1.5px dashed var(--region-unplaced);
  background: transparent;
}

/* 微调中：蓝实线 + 拖移光标 */
.overlay.adjusting {
  border: 1.5px solid var(--primary);
  background: var(--primary-bg-subtle);
  cursor: move;
}

.handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--bg-surface);
  border: 1.5px solid var(--primary);
  border-radius: 2px;
}

.handle.h-nw {
  left: -4px;
  top: -4px;
  cursor: nwse-resize;
}

.handle.h-n {
  left: calc(50% - 4px);
  top: -4px;
  cursor: ns-resize;
}

.handle.h-ne {
  right: -4px;
  top: -4px;
  cursor: nesw-resize;
}

.handle.h-e {
  right: -4px;
  top: calc(50% - 4px);
  cursor: ew-resize;
}

.handle.h-se {
  right: -4px;
  bottom: -4px;
  cursor: nwse-resize;
}

.handle.h-s {
  left: calc(50% - 4px);
  bottom: -4px;
  cursor: ns-resize;
}

.handle.h-sw {
  left: -4px;
  bottom: -4px;
  cursor: nesw-resize;
}

.handle.h-w {
  left: -4px;
  top: calc(50% - 4px);
  cursor: ew-resize;
}

/* 框选草稿：虚线蓝框，不拦截鼠标 */
.draft-frame {
  position: absolute;
  border: 1.5px dashed var(--primary);
  background: var(--primary-bg-selected);
  pointer-events: none;
}

.dot.cand-high {
  background: var(--success-bg-marker);
  border: 1px solid var(--success);
}

.dot.cand-low {
  background: var(--candidate-bg-marker);
  border: 1px solid var(--candidate);
}

.dot.confirmed {
  background: var(--primary-bg-marker);
  border: 1px solid var(--primary);
}

.dot.excluded {
  background: transparent;
  border: 1px dashed var(--region-unplaced);
}

.progress {
  margin-left: 12px;
  color: var(--primary);
  font-weight: 600;
}

.unplaced-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 8px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-2);
}

.unplaced-title {
  flex-shrink: 0;
}

/* 虚线灰=未识别（bbox=null，无几何坐标） */
.unplaced-chip {
  border: 1px dashed var(--region-unplaced);
  border-radius: 3px;
  padding: 1px 6px;
  color: var(--region-unplaced);
}

.pdf-page { margin: 0 auto 20px; }
.welcome-card { max-width: 520px; padding: 28px; text-align: center; }
.welcome-icon { display: inline-flex; width: 56px; height: 56px; align-items: center; justify-content: center; font-size: 34px; color: var(--primary); background: var(--primary-bg-subtle); border-radius: 14px; }
.welcome-card h1 { font-size: 23px; color: var(--text-1); margin: 20px 0 12px; }
.welcome-card p { font-size: 14px; line-height: 1.8; color: var(--text-2); }
.welcome-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 10px; margin: 24px 0; }
.welcome-hint { font-size: 12px; color: var(--text-3); }
</style>
