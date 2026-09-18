/**
 * 块库状态：块 CRUD + 标签筛选/管理 + 抽屉开关（M2）。
 *
 * 正向绑定流（PRD 4.4）：左栏点选块 → 高亮 selectedBlockId →
 * 右栏点目标区域即绑定；再点同块取消选中。
 * 列表分组/筛选在 computed 侧完成（本地单机，数据量小）。
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

/** 分组视图：按分类聚拢（分类名 → 该类块），供列表分组渲染。 */
export interface BlockGroup {
  category: string
  blocks: Block[]
}

export const useBlocksStore = defineStore('blocks', () => {
  const blocks = ref<Block[]>([])
  const tags = ref<TagInfo[]>([])
  const error = ref<string | null>(null)
  /** 块库抽屉展开态（UI 调整②：左缘按钮控制，默认展开）。 */
  const libraryOpen = ref(true)

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

  /** 按分类分组（分类名 zh 排序，未分类殿后）。 */
  const groupedBlocks = computed<BlockGroup[]>(() => {
    const map = new Map<string, Block[]>()
    for (const b of filteredBlocks.value) {
      const list = map.get(b.category)
      if (list) {
        list.push(b)
      } else {
        map.set(b.category, [b])
      }
    }
    return [...map.entries()]
      .sort(([a], [b]) =>
        a === '未分类' ? 1 : b === '未分类' ? -1 : a.localeCompare(b, 'zh'),
      )
      .map(([category, groupBlocks]) => ({ category, blocks: groupBlocks }))
  })

  const categories = computed(() => groupedBlocks.value.map(g => g.category))

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
    category = '未分类',
    tagNames: string[] = [],
  ): Promise<boolean> {
    creating.value = true
    createError.value = null
    try {
      const payload: BlockPayload = { name, content, category }
      if (tagNames.length > 0) {
        payload.tags = tagNames
      }
      const block = await createBlock(payload)
      blocks.value = [...blocks.value, block]
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
      blocks.value = blocks.value.map(b => (b.id === updated.id ? updated : b))
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
    selectedBlockId,
    selectedBlock,
    activeTagId,
    filteredBlocks,
    groupedBlocks,
    categories,
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
