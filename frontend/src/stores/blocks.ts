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

  async function loadTags(): Promise<void> {
    try {
      tags.value = await listTags()
    } catch (err) {
      error.value = _errMessage(err)
    }
  }

  async function createNewBlock(
    name: string,
    content: string,
    tagNames: string[] = [],
  ): Promise<boolean> {
    creating.value = true
    createError.value = null
    try {
      const payload: BlockPayload = { name, content }
      if (tagNames.length > 0) {
        payload.tags = tagNames
      }
      const block = await createBlock(payload)
      blocks.value = [block, ...blocks.value] // 更新时间倒序：新块排最前
      selectedBlockId.value = block.id // 新建即选中：建完可直接点区域绑定
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
      void loadTags()
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

  function selectBlock(id: number | null): void {
    selectedBlockId.value = selectedBlockId.value === id ? null : id
  }

  return {
    blocks,
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
    selectBlock,
  }
})
