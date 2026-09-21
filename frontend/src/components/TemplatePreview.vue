<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RegionFramePayload } from '../api/regions'
import {
  bboxToOverlayRect,
  overlayKind,
  overlayRectToBBox,
  type OverlayRect,
} from '../pdf/geometry'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'
import ProofreadPopover from './ProofreadPopover.vue'
import RegionNameDialog from './RegionNameDialog.vue'
import VersionDialog from './VersionDialog.vue'

const store = usePreviewStore()
const blocksStore = useBlocksStore()
/** 滚动容器（页面按 fit-width 平铺，纵向滚动）。 */
const scrollRef = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const pages = ref<RenderedPage[]>([])
/** 未定位区域（bbox=null，渲染未匹配）：无几何，只能列表提示（M5b 校对兜底）。 */
const unplaced = computed(() =>
  store.regions.filter(r => r.bbox === null && (store.proofreadMode || r.review_status !== 'excluded')),
)
/** 绑定浮层目标区域（null = 关闭，正常模式）。 */
const dialogRegion = ref<DisplayRegion | null>(null)
/** 校对浮层目标（null = 关闭，校对模式；page 供微调启动取 viewport）。 */
const popoverTarget = ref<{ region: DisplayRegion; page: RenderedPage } | null>(null)
/** 命名弹层：框选完成待命名（null = 关闭）。 */
const nameDialog = ref<{ frame: RegionFramePayload } | null>(null)
const nameError = ref<string | null>(null)
const nameSubmitting = ref(false)
/** 拖拽中的框选草稿（页内 CSS 像素矩形）。 */
const draftFrame = ref<{ page: number; rect: OverlayRect } | null>(null)
/** 微调草稿：区域 id + 页内矩形（null = 未在微调）。 */
const adjustDraft = ref<{ regionId: number; page: number; rect: OverlayRect } | null>(null)

let opened: OpenedPdf | null = null
let openedData: ArrayBuffer | null = null
let rebuildSeq = 0
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

/** 溢出区域清单：大超出在前，同级按溢出比例降序。 */
const overflowRegions = computed(() =>
  store.regions
    .filter(r => r.overflow != null)
    .sort((a, b) => {
      const la = a.overflow!.level === 'large' ? 0 : 1
      const lb = b.overflow!.level === 'large' ? 0 : 1
      if (la !== lb) return la - lb
      return b.overflow!.ratio - a.overflow!.ratio
    }),
)

/** 状态条 chip 视图模型（模板内免非空断言）。 */
const overflowChips = computed(() =>
  overflowRegions.value.map(r => ({
    id: r.id,
    label: r.label,
    level: r.overflow!.level,
    ratioPct: Math.round(r.overflow!.ratio * 100),
    clipped: r.overflow!.clipped,
    page: (r.bbox?.page ?? 0) + 1,
    region: r,
  })),
)

const largeOverflowCount = computed(
  () => overflowChips.value.filter(c => c.level === 'large').length,
)

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
  const value = (event.target as HTMLSelectElement).value
  void store.selectTemplate(value === '' ? null : Number(value))
}

// ---- 版本管理（M8）：下拉切换 + 新建/重命名/删除 ----

/** 版本弹层（null = 关闭；create/rename 共用 VersionDialog）。 */
const versionDialog = ref<'create' | 'rename' | null>(null)
const versionDialogError = ref<string | null>(null)
const versionSubmitting = ref(false)

/** 当前版本名（重命名弹层预填；列表未就绪时回退空）。 */
const currentVersionName = computed(
  () => store.versions.find(v => v.id === store.currentVersionId)?.name ?? '',
)

/** 版本切换：整体刷新渲染（校对模式下拉置灰，此处不再兜底）。 */
function onVersionChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value !== '') {
    void store.selectVersion(Number(value))
  }
}

async function onVersionSubmit(name: string, copyFrom: boolean): Promise<void> {
  const mode = versionDialog.value
  if (mode === null) {
    return
  }
  versionSubmitting.value = true
  versionDialogError.value = null
  const result =
    mode === 'create'
      ? await store.createNewVersion(name, copyFrom)
      : await store.renameCurrentVersion(name)
  versionSubmitting.value = false
  if (!result.ok) {
    versionDialogError.value = result.error // 内联显示（重名/名称非法）
    return
  }
  versionDialog.value = null
}

function onDeleteVersion(): void {
  if (store.currentVersionId === null) {
    return
  }
  if (!window.confirm(`删除版本「${currentVersionName.value}」？其绑定关系将一并删除。`)) {
    return
  }
  void store.deleteCurrentVersion().then(result => {
    // 删除失败（如最后版本 LAST_VERSION 保护）给出反馈，避免静默无响应
    if (!result.ok) {
      window.alert(result.error)
    }
  })
}

function regionsOf(pageIndex: number): DisplayRegion[] {
  return store.regions.filter(r => {
    if (r.bbox === null || r.bbox.page !== pageIndex) {
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
  return rectStyle(bboxToOverlayRect(region.bbox!, page.viewport))
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
      : `溢出 +${Math.round(ov.ratio * 100)}%（超出区域原高度）`
    return `${region.label}（${hint}；${state}）`
  }
  return `${region.label}（${state}）`
}

/** 区域点击（PRD 4.4）：左栏已选块 → 直接绑定/换绑；否则浮层选块/换绑/解绑。 */
function onRegionClick(region: DisplayRegion, page: RenderedPage): void {
  if (store.proofreadMode) {
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

async function onDialogBind(blockId: number): Promise<void> {
  const region = dialogRegion.value
  dialogRegion.value = null
  if (region) {
    await store.bindRegionToBlock(region.id, blockId)
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
  if (!store.proofreadMode || adjustDraft.value !== null) {
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
  if (region.bbox === null) {
    return
  }
  e.preventDefault()
  e.stopPropagation()
  const pt = pagePoint(e, page)
  if (!pt) {
    return
  }
  const originRect = bboxToOverlayRect(region.bbox, page.viewport)
  drag = { kind: 'adjust', handle, page, startPageX: pt.x, startPageY: pt.y, originRect }
  adjustDraft.value = { regionId: region.id, page: page.index, rect: { ...originRect } }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent): void {
  if (!drag) {
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
  if (!d) {
    return
  }
  if (d.kind === 'frame') {
    const rect = draftFrame.value?.rect
    draftFrame.value = null
    if (!rect || rect.width < MIN_DRAG || rect.height < MIN_DRAG) {
      return // 视为点击，不误开命名弹层
    }
    const b = overlayRectToBBox(rect, d.page.viewport)
    nameError.value = null
    nameDialog.value = { frame: { page: d.page.index, ...b } }
    return
  }
  const rect = adjustDraft.value?.rect
  const regionId = adjustDraft.value?.regionId
  adjustDraft.value = null
  if (!rect || !regionId) {
    return
  }
  const b = overlayRectToBBox(rect, d.page.viewport)
  void store.adjustRegionBBox(regionId, { page: d.page.index, ...b })
}

/** Esc 取消微调（草稿丢弃，区域保持原 bbox）。 */
function onCancelAdjust(e: KeyboardEvent): void {
  if (e.key === 'Escape' && adjustDraft.value) {
    adjustDraft.value = null
    drag = null
  }
}

async function onNameSubmit(label: string, type: string): Promise<void> {
  const frame = nameDialog.value?.frame
  if (!frame) {
    return
  }
  nameSubmitting.value = true
  nameError.value = null
  const result = await store.createFrameRegion(frame, label, type)
  nameSubmitting.value = false
  if (!result.ok) {
    nameError.value = result.error // 内联显示（空区域/跨多段拦截），关闭后重新框选
    return
  }
  nameDialog.value = null
}

function onPopoverConfirm(): void {
  const t = popoverTarget.value
  popoverTarget.value = null
  if (t) {
    void store.confirmRegion(t.region.id)
  }
}

function onPopoverExclude(): void {
  const t = popoverTarget.value
  popoverTarget.value = null
  if (t) {
    void store.excludeRegion(t.region.id)
  }
}

function onPopoverReopen(): void {
  const t = popoverTarget.value
  popoverTarget.value = null
  if (t) {
    void store.reopenRegion(t.region.id)
  }
}

function onPopoverAdjust(): void {
  const t = popoverTarget.value
  popoverTarget.value = null
  if (!t || t.region.bbox === null) {
    return
  }
  adjustDraft.value = {
    regionId: t.region.id,
    page: t.page.index,
    rect: bboxToOverlayRect(t.region.bbox, t.page.viewport),
  }
}

async function onPopoverRemove(): Promise<void> {
  const t = popoverTarget.value
  popoverTarget.value = null
  if (!t) {
    return
  }
  if (!window.confirm(`删除区域「${t.region.label}」？其绑定关系将一并删除。`)) {
    return
  }
  await store.removeRegion(t.region.id)
}

/** 重建渲染：pdfData 变化重开文档；容器宽度变化仅按新 scale 重排。 */
function rebuild(): void {
  const seq = ++rebuildSeq
  doRebuild(seq).catch(err => {
    if (err instanceof Error && err.name === 'RenderingCancelledException') {
      return // 主动取消属正常流程（P22）
    }
    console.error('[TemplatePreview] 渲染失败：', err)
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
  const first = await opened.document.getPage(1)
  const baseWidth = first.getViewport({ scale: 1 }).width
  const scale = Math.max((width - 32) / baseWidth, 0.1) // 左右各留 16px
  const list: RenderedPage[] = []
  for (let i = 1; i <= opened.document.numPages; i++) {
    const page = await opened.document.getPage(i)
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
  await Promise.all(list.map((p, i) => p.render(canvases[i])))
}

watch(
  () => [store.pdfData, containerWidth.value, store.regions, store.status],
  () => {
    rebuild()
  },
)

// 切换校对模式：关闭所有弹层与草稿（popover 持有的 RenderedPage 引用即将失效）
watch(
  () => store.proofreadMode,
  () => {
    popoverTarget.value = null
    nameDialog.value = null
    nameError.value = null
    draftFrame.value = null
    adjustDraft.value = null
    versionDialog.value = null
    versionDialogError.value = null
  },
)

onMounted(() => {
  void store.loadTemplates() // 模板列表数据源（UI 调整③：下拉随工具条常驻）
  containerWidth.value = scrollRef.value?.clientWidth ?? 0
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(entries => {
      containerWidth.value = entries[0]?.contentRect.width ?? 0
    })
    if (scrollRef.value) {
      observer.observe(scrollRef.value)
    }
  }
  window.addEventListener('keydown', onCancelAdjust)
})

onBeforeUnmount(() => {
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
</script>

<template>
  <!-- 右栏：版本预览（模板+绑定替换成品）——pdfjs 渲染管线 PDF + 可交互覆盖层 -->
  <section class="template-preview">
    <!-- 顶部工具条：左组（块库展开按钮[仅收起态] + 模板下拉紧凑排列）+ 右侧图例，中间自然留白 -->
    <div class="preview-toolbar">
      <div class="toolbar-left">
        <button
          v-if="!blocksStore.libraryOpen"
          class="library-expand"
          title="展开块库"
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
        <select
          class="template-select"
          :value="store.currentTemplateId ?? ''"
          :disabled="store.templates.length === 0"
          :title="store.templatesError ?? '选择要预览的模板'"
          @change="onTemplateChange"
        >
          <option
            value=""
            disabled
          >
            {{ store.templatesError ?? (store.templates.length === 0 ? '（暂无模板）' : '（选择模板）') }}
          </option>
          <option
            v-for="t in store.templates"
            :key="t.id"
            :value="t.id"
          >
            {{ t.filename }}
          </option>
        </select>
        <!-- 版本控件组（M8）：下拉切换（整体刷新）+ 新建/重命名/删除；校对模式置灰 -->
        <template v-if="store.currentVersionId !== null">
          <select
            class="template-select version-select"
            :value="store.currentVersionId"
            :disabled="store.proofreadMode"
            title="切换内容版本（校对模式下不可用）"
            data-testid="version-select"
            @change="onVersionChange"
          >
            <option
              v-for="v in store.versions"
              :key="v.id"
              :value="v.id"
            >
              {{ v.name }}（{{ v.binding_count }} 项绑定）
            </option>
          </select>
          <button
            class="tool-btn"
            :disabled="store.proofreadMode"
            title="新建版本（可复制当前绑定内容为底稿）"
            data-testid="version-create"
            @click="versionDialog = 'create'"
          >
            新建
          </button>
          <button
            class="tool-btn"
            :disabled="store.proofreadMode"
            title="重命名当前版本"
            data-testid="version-rename"
            @click="versionDialog = 'rename'"
          >
            重命名
          </button>
          <button
            class="tool-btn danger"
            :disabled="store.proofreadMode"
            title="删除当前版本（至少保留一个）"
            data-testid="version-delete"
            @click="onDeleteVersion"
          >
            删除
          </button>
        </template>
      </div>
      <span class="legend">
        <span
          v-if="store.refreshing"
          class="refreshing"
        ><span class="spinner" />正在刷新预览…</span>
        <!-- 校对模式图例：候选按置信度分色 + 进度 -->
        <template v-if="store.status === 'ready' && store.proofreadMode">
          <i class="dot cand-high" />高置信候选
          <i class="dot cand-low" />低置信候选
          <i class="dot confirmed" />已确认
          <i class="dot excluded" />已排除
          <span
            class="progress"
            data-testid="proofread-progress"
          >已处理 {{ proofreadProgress.done }}/{{ proofreadProgress.total }}</span>
        </template>
        <template v-else-if="store.status === 'ready'">
          <i class="dot bound" />已绑定 {{ boundCount }}
          <i class="dot pending" />待校对 {{ pendingCount }}
          <i class="dot unrecognized" />未定位 {{ unplaced.length }}
        </template>
      </span>
    </div>

    <!-- 绑定/刷新错误横幅（不动摇 ready 态的已渲染内容） -->
    <div
      v-if="store.status === 'ready' && store.error"
      class="error-banner"
    >
      {{ store.error }}
    </div>

    <div
      ref="scrollRef"
      class="preview-scroll"
    >
      <div
        v-if="store.status === 'idle'"
        class="state empty"
      >
        请在上方工具条选择模板开始预览
      </div>
      <div
        v-else-if="store.status === 'loading'"
        class="state loading"
      >
        <span class="spinner" />
        正在生成预览…（首次渲染需调用 LibreOffice 转换，约需十几秒）
      </div>
      <div
        v-else-if="store.status === 'error'"
        class="state error"
      >
        {{ store.error }}
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
                { flashing: flashRegionId === region.id },
              ]"
              :style="overlayStyle(region, page)"
              :title="overlayTitle(region)"
              role="button"
              tabindex="0"
              @click="onRegionClick(region, page)"
              @keydown.enter="onRegionClick(region, page)"
              @mousedown.stop
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
          <span class="unplaced-title">未定位区域（渲染未匹配，待校对）：</span>
          <span
            v-for="region in unplaced"
            :key="region.id"
            class="unplaced-chip"
            :title="region.placeholder ?? ''"
          >
            {{ region.label }}
          </span>
        </div>
        <!-- 绑定浮层（区域内遮罩定位，M6a，正常模式） -->
        <BindingDialog
          v-if="dialogRegion"
          :region="dialogRegion"
          :blocks="blocksStore.blocks"
          @bind="onDialogBind"
          @unbind="onDialogUnbind"
          @close="dialogRegion = null"
        />
        <!-- 校对操作浮层（校对模式） -->
        <ProofreadPopover
          v-if="popoverTarget"
          :region="popoverTarget.region"
          @confirm="onPopoverConfirm"
          @exclude="onPopoverExclude"
          @reopen="onPopoverReopen"
          @adjust="onPopoverAdjust"
          @remove="onPopoverRemove"
          @close="popoverTarget = null"
        />
        <!-- 框选命名弹层（校对模式） -->
        <RegionNameDialog
          v-if="nameDialog"
          :error="nameError"
          :submitting="nameSubmitting"
          @submit="onNameSubmit"
          @close="nameDialog = null"
        />
        <!-- 版本弹层（M8：新建/重命名共用） -->
        <VersionDialog
          v-if="versionDialog"
          :mode="versionDialog"
          :initial-name="versionDialog === 'rename' ? currentVersionName : ''"
          :can-copy="store.currentVersionId !== null"
          :error="versionDialogError"
          :submitting="versionSubmitting"
          @submit="onVersionSubmit"
          @close="versionDialog = null"
        />
      </template>
    </div>

    <!-- M7 溢出状态条：固定预览区底部汇总；chip 点击跳转所在页并闪烁定位 -->
    <div
      v-if="overflowChips.length > 0"
      class="overflow-bar"
      data-testid="overflow-bar"
    >
      <span class="overflow-title">
        溢出区域 {{ overflowChips.length }} 个（大超出 {{ largeOverflowCount }}）：
      </span>
      <button
        v-for="chip in overflowChips"
        :key="chip.id"
        class="overflow-chip"
        :class="chip.level"
        :title="`点击定位到第 ${chip.page} 页`"
        @click="jumpToRegion(chip.region)"
      >
        {{ chip.label
        }}<template v-if="chip.clipped">
          （裁剪）
        </template>
        <template v-else>
          +{{ chip.ratioPct }}%
        </template>
      </button>
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
  background: #eceff1;
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-bottom: 1px solid #e2e3e5;
  container-type: inline-size; /* 容器查询基准：预览区宽度（抽屉挤压时隐藏图例） */
}

/* 预览区过窄时图例（已绑定/待校对/未定位）与下拉重叠 → 直接隐藏 */
@container (max-width: 620px) {
  .legend {
    display: none;
  }
}

/* 左组：块库按钮 + 模板下拉紧凑排列（中间留白由 space-between 拉开到右侧图例前） */
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.library-expand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 12px;
  color: #646a73;
  background: none;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  cursor: pointer;
}

.library-expand:hover {
  color: #3370ff;
  border-color: #3370ff;
}

.template-select {
  max-width: 280px;
  min-width: 140px;
  padding: 2px 4px;
  font-size: 12px;
  color: #1f2329;
}

/* 版本下拉：名称（N 项绑定）比文件名短，收窄留白给操作按钮 */
.version-select {
  max-width: 200px;
  min-width: 120px;
}

/* 版本操作小按钮（M8）：与 library-expand 同风格 */
.tool-btn {
  padding: 3px 8px;
  font-size: 12px;
  color: #646a73;
  background: none;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}

.tool-btn:hover:not(:disabled) {
  color: #3370ff;
  border-color: #3370ff;
}

.tool-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.tool-btn.danger:hover:not(:disabled) {
  color: #f54a45;
  border-color: #f54a45;
}

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
  color: #3370ff;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 12px;
  border-radius: 2px;
}

.dot.bound {
  background: rgba(52, 199, 36, 0.25);
  border: 1px solid #34c724;
}

.dot.pending {
  background: rgba(255, 196, 0, 0.35);
  border: 1px solid #ffb900;
}

.dot.unrecognized {
  background: transparent;
  border: 1px dashed #909399;
}

.error-banner {
  padding: 6px 16px;
  font-size: 12px;
  color: #f54a45;
  background: rgba(245, 74, 69, 0.06);
  border-bottom: 1px solid rgba(245, 74, 69, 0.2);
}

.preview-scroll {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
  position: relative;
}

.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8f959e;
}

.state.error {
  color: #f54a45;
}

.state.loading {
  gap: 8px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #d0d3d6;
  border-top-color: #3370ff;
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
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
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
  border: 1.5px solid #34c724;
  background: rgba(52, 199, 36, 0.15);
}

/* 黄=待校对（未绑定或 missing 回落） */
.overlay.pending {
  border: 1.5px solid #ffb900;
  background: rgba(255, 196, 0, 0.18);
}

/* ---- 溢出分级（M7，正常模式，优先级高于绑定态着色）---- */

/* 大超出 = 红 */
.overlay.overflow-large {
  border: 1.5px solid #f54a45;
  background: rgba(245, 74, 69, 0.15);
}

/* 小超出 = 橙（覆盖绑定态绿：分级警示优先于绑定语义） */
.overlay.overflow-small {
  border: 1.5px solid #ff7d00;
  background: rgba(255, 125, 0, 0.15);
}

/* 状态条 chip 跳转后的闪烁定位（蓝色环，与分级色无关） */
.overlay.flashing {
  animation: region-flash 0.5s ease-in-out 3;
}

@keyframes region-flash {
  0%,
  100% {
    box-shadow: none;
  }
  50% {
    box-shadow: 0 0 0 4px rgba(51, 112, 255, 0.5);
  }
}

.overlay:hover {
  border-color: #3370ff;
}

/* ---- 校对模式（M5b）---- */

/* 高置信候选（confidence ≥ 0.9）= 绿 */
.overlay.cand-high {
  border: 1.5px solid #34c724;
  background: rgba(52, 199, 36, 0.12);
}

/* 低置信候选 = 黄 */
.overlay.cand-low {
  border: 1.5px solid #ffb900;
  background: rgba(255, 196, 0, 0.15);
}

/* 已确认 = 蓝 */
.overlay.confirmed {
  border: 1.5px solid #3370ff;
  background: rgba(51, 112, 255, 0.12);
}

/* 已排除 = 灰虚线（正常模式下不渲染） */
.overlay.excluded {
  border: 1.5px dashed #909399;
  background: transparent;
}

/* 微调中：蓝实线 + 拖移光标 */
.overlay.adjusting {
  border: 1.5px solid #3370ff;
  background: rgba(51, 112, 255, 0.08);
  cursor: move;
}

.handle {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #fff;
  border: 1.5px solid #3370ff;
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
  border: 1.5px dashed #3370ff;
  background: rgba(51, 112, 255, 0.1);
  pointer-events: none;
}

.dot.cand-high {
  background: rgba(52, 199, 36, 0.2);
  border: 1px solid #34c724;
}

.dot.cand-low {
  background: rgba(255, 196, 0, 0.3);
  border: 1px solid #ffb900;
}

.dot.confirmed {
  background: rgba(51, 112, 255, 0.2);
  border: 1px solid #3370ff;
}

.dot.excluded {
  background: transparent;
  border: 1px dashed #909399;
}

.progress {
  margin-left: 12px;
  color: #3370ff;
  font-weight: 600;
}

.unplaced-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #e2e3e5;
  border-radius: 4px;
  font-size: 12px;
  color: #646a73;
}

.unplaced-title {
  flex-shrink: 0;
}

/* 虚线灰=未识别（bbox=null，无几何坐标） */
.unplaced-chip {
  border: 1px dashed #909399;
  border-radius: 3px;
  padding: 1px 6px;
  color: #909399;
}

/* ---- 溢出状态条（M7）：固定预览区底部 ---- */

.overflow-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-top: 1px solid #e2e3e5;
}

.overflow-title {
  flex-shrink: 0;
  font-weight: 600;
}

.overflow-chip {
  padding: 1px 8px;
  font-size: 12px;
  color: #1f2329;
  background: #fff;
  border: 1px solid #d0d3d6;
  border-radius: 3px;
  cursor: pointer;
}

.overflow-chip.large {
  border-color: #f54a45;
  color: #f54a45;
}

.overflow-chip.small {
  border-color: #ff7d00;
  color: #ff7d00;
}

.overflow-chip:hover {
  background: #f5f6f7;
}
</style>
