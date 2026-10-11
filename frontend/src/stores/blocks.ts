/**
 * 块库状态：块 CRUD + 标签筛选/管理 + 抽屉开关（M2）。
 *
 * 正向绑定流（PRD 4.4）：左栏点选块 → 高亮 selectedBlockId →
 * 右栏点目标区域即绑定；再点同块取消选中。
 * 块列表平铺（更新时间倒序）+ 标签筛选在 computed 侧完成（本地单机，数据量小）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  addBlockToTemplate,
  createBlock,
  deleteBlock,
  deleteTag,
  listBlocks,
  listTags,
  renameTag,
  updateBlock,
  type Block,
  type BlockPayload,
  type TagInfo,
} from '../api/blocks'

/** 抽屉宽度边界（UI 调整②批）：上限 360，下限=头部内容 + 约一半呼吸空白（分类移除后头部精简，实测校准）。 */
export const LIBRARY_MIN_WIDTH = 230
export const LIBRARY_MAX_WIDTH = 360
export const LIBRARY_DEFAULT_WIDTH = 320

const LIBRARY_WIDTH_KEY = 'blocks.libraryWidth'
const LIBRARY_OPEN_KEY = 'blocks.libraryOpen'

function _readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // localStorage 不可用（隐私模式/测试环境）时静默降级
  }
}

function _writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 忽略写入失败
  }
}

export const useBlocksStore = defineStore('blocks', () => {
  const blocks = ref<Block[]>([])
  const tags = ref<TagInfo[]>([])
  const libraryTemplateId = ref<number | null>(null)
  const libraryBlockIds = ref<number[]>([])
  const libraryLoading = ref(false)
  const libraryError = ref<string | null>(null)
  let libraryRequest = 0
  const libraryBlocks = computed(() => libraryTemplateId.value === null ? []
    : blocks.value.filter(b => libraryBlockIds.value.includes(b.id)))
  const libraryTags = computed(() => {
    const counts = new Map<number, TagInfo>()
    for (const block of libraryBlocks.value) for (const tag of block.tags) {
      const current = counts.get(tag.id)
      counts.set(tag.id, { ...tag, created_at: '', block_count: (current?.block_count ?? 0) + 1 })
    }
    return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

  async function loadTemplateBlocks(templateId: number | null): Promise<void> {
    const request = ++libraryRequest
    if (libraryTemplateId.value !== templateId) {
      libraryBlockIds.value = []
      selectedBlockId.value = null
      activeTagId.value = null
    }
    libraryTemplateId.value = templateId
    libraryError.value = null
    libraryLoading.value = templateId !== null
    if (templateId === null) { libraryBlockIds.value = []; return }
    try {
      const result = await listBlocks(templateId)
      if (request !== libraryRequest) return
      const ids = new Set(result.map(b => b.id))
      blocks.value = [...result, ...blocks.value.filter(b => !ids.has(b.id))]
      libraryBlockIds.value = [...ids]
    } catch (err) {
      if (request !== libraryRequest) return
      libraryBlockIds.value = []
      libraryError.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (request === libraryRequest) libraryLoading.value = false
    }
  }
  const error = ref<string | null>(null)
  /** 块库抽屉展开态（UI 调整②，展开/收起均 localStorage 记忆）。 */
  const libraryOpen = ref(_readStored(LIBRARY_OPEN_KEY) !== '0')
  /** 抽屉宽度（拖拽可调，持久化）。 */
  const libraryWidth = ref(LIBRARY_DEFAULT_WIDTH)
  {
    const stored = Number(_readStored(LIBRARY_WIDTH_KEY))
    if (Number.isFinite(stored) && stored > 0) {
      libraryWidth.value = _clampWidth(stored)
    }
  }

  function _clampWidth(raw: number): number {
    return Math.min(
      LIBRARY_MAX_WIDTH,
      Math.max(LIBRARY_MIN_WIDTH, Math.round(raw)),
    )
  }

  /** 拖拽落定入口：越界值收敛到 [MIN, MAX]。 */
  function setLibraryWidth(px: number): void {
    libraryWidth.value = _clampWidth(px)
    _writeStored(LIBRARY_WIDTH_KEY, String(libraryWidth.value))
  }

  /** 折叠开关（头部矩形竖线按钮 / 工具条左端按钮共用）。 */
  function toggleLibrary(): void {
    libraryOpen.value = !libraryOpen.value
    _writeStored(LIBRARY_OPEN_KEY, libraryOpen.value ? '1' : '0')
  }

  /** 正向绑定流选中的块（null = 未选中）。 */
  const selectedBlockId = ref<number | null>(null)
  const selectedBlock = computed(
    () => blocks.value.find(b => b.id === selectedBlockId.value) ?? null,
  )

  /** 标签筛选（单选开关，null = 全部）。 */
  const activeTagId = ref<number | null>(null)
  const filteredBlocks = computed(() => {
    if (activeTagId.value === null) {
      return blocks.value
    }
    return blocks.value.filter(b => b.tags.some(t => t.id === activeTagId.value))
  })

  /** 新建表单态。 */
  const creating = ref(false)
  const createError = ref<string | null>(null)
  /** 编辑表单态。 */
  const updating = ref(false)
  const updateError = ref<string | null>(null)
  /** 删除/标签管理错误横幅。 */
  const mutationError = ref<string | null>(null)

  function _errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async function loadBlocks(): Promise<void> {
    try {
      blocks.value = await listBlocks()
      error.value = null
    } catch (err) {
      error.value = _errMessage(err)
    }
  }

  let tagsRequest = 0
  async function loadTags(): Promise<void> {
    const request = ++tagsRequest
    try {
      const result = await listTags()
      if (request !== tagsRequest) return
      tags.value = result
      if (activeTagId.value !== null && !result.some(t => t.id === activeTagId.value)) activeTagId.value = null
    } catch (err) {
      if (request === tagsRequest) error.value = _errMessage(err)
    }
  }

  async function createNewBlock(
    name: string,
    content: string,
    tagNames: string[] = [],
    kind: 'text' | 'blank' = 'text',
    templateId?: number,
  ): Promise<boolean> {
    creating.value = true
    createError.value = null
    try {
      const payload: BlockPayload = { name, content }
      if (templateId !== undefined) payload.template_id = templateId
      if (kind === 'blank') payload.kind = kind
      if (tagNames.length > 0) {
        payload.tags = tagNames
      }
      const block = await createBlock(payload)
      blocks.value = [block, ...blocks.value] // 更新时间倒序：新块排最前
      if (templateId === undefined || libraryTemplateId.value === templateId) {
        selectedBlockId.value = block.id // New blocks are immediately available before region binding.
        if (templateId !== undefined) libraryBlockIds.value = [...new Set([...libraryBlockIds.value, block.id])]
      }
      void loadTags() // 新标签计数变化
      return true
    } catch (err) {
      createError.value = _errMessage(err)
      return false
    } finally {
      creating.value = false
    }
  }

  /** 更新块（部分更新，载荷由组件组好）。成功刷新列表并返回 true。 */
  async function updateExistingBlock(id: number, payload: BlockPayload): Promise<boolean> {
    updating.value = true
    updateError.value = null
    try {
      const updated = await updateBlock(id, payload)
      // 更新时间倒序：刚编辑过的块排最前，其余保持原相对顺序
      blocks.value = [updated, ...blocks.value.filter(b => b.id !== updated.id)]
      void loadTags()
      return true
    } catch (err) {
      updateError.value = _errMessage(err)
      return false
    } finally {
      updating.value = false
    }
  }

  /** 软删除块（D11）：列表移除；若是选中块清空选中；关联绑定已在后端置 missing。 */
  async function removeBlock(id: number): Promise<boolean> {
    mutationError.value = null
    try {
      await deleteBlock(id)
      blocks.value = blocks.value.filter(b => b.id !== id)
      if (selectedBlockId.value === id) {
        selectedBlockId.value = null
      }
      await loadTags()
      return true
    } catch (err) {
      mutationError.value = _errMessage(err)
      return false
    }
  }

  function toggleTagFilter(id: number | null): void {
    activeTagId.value = activeTagId.value === id ? null : id
  }

  /** 重命名标签（撞名即合并，后端返回目标标签）→ 全库刷新；成功返回 null。 */
  async function renameExistingTag(id: number, name: string): Promise<string | null> {
    mutationError.value = null
    try {
      await renameTag(id, name)
      await Promise.all([loadBlocks(), loadTags()])
      return null
    } catch (err) {
      return _errMessage(err)
    }
  }

  /** 删除标签（块本身不受影响）；若在被筛选的标签上则清空筛选。 */
  async function removeTag(id: number): Promise<boolean> {
    mutationError.value = null
    try {
      await deleteTag(id)
      if (activeTagId.value === id) {
        activeTagId.value = null
      }
      await Promise.all([loadBlocks(), loadTags()])
      return true
    } catch (err) {
      mutationError.value = _errMessage(err)
      return false
    }
  }

  async function retagBlocks(ids: number[], names: string[], mode: 'add' | 'replace' | 'remove') {
    const failedIds: number[] = []
    const failures: string[] = []
    const targets = [...new Set(ids)]
    for (const id of targets) {
      const block = blocks.value.find(b => b.id === id)
      if (!block) { failedIds.push(id); failures.push(`块 #${id} 已不存在`); continue }
      const previous = block.tags.map(t => t.name)
      const desired = mode === 'replace' ? names : mode === 'add'
        ? [...new Set([...previous, ...names])]
        : previous.filter(name => !names.includes(name))
      try { await updateBlock(id, { tags: desired }) }
      catch (err) { failedIds.push(id); failures.push(`${block.name}：${_errMessage(err)}`) }
    }
    await Promise.all([loadBlocks(), loadTags()])
    return { updated: targets.length - failedIds.length, failedIds, failures }
  }

  async function shareBlock(blockId: number, templateId: number): Promise<boolean> {
    mutationError.value = null
    try {
      await addBlockToTemplate(blockId, templateId)
      if (libraryTemplateId.value === templateId) await loadTemplateBlocks(templateId)
      return true
    } catch (err) {
      mutationError.value = _errMessage(err)
      return false
    }
  }

  function selectBlock(id: number | null): void {
    selectedBlockId.value = selectedBlockId.value === id ? null : id
  }

  return {
    blocks,
    libraryBlocks,
    libraryTags,
    libraryLoading,
    libraryError,
    loadTemplateBlocks,
    tags,
    error,
    libraryOpen,
    libraryWidth,
    setLibraryWidth,
    toggleLibrary,
    selectedBlockId,
    selectedBlock,
    activeTagId,
    filteredBlocks,
    creating,
    createError,
    updating,
    updateError,
    mutationError,
    loadBlocks,
    loadTags,
    createNewBlock,
    updateExistingBlock,
    removeBlock,
    toggleTagFilter,
    renameExistingTag,
    removeTag,
    retagBlocks,
    shareBlock,
    selectBlock,
  }
})
