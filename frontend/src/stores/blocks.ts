/**
 * 块库状态：块列表 + 新建 + 选中（M6a 最小实现）。
 *
 * 正向绑定流（PRD 4.4）：左栏点选块 → 高亮 selectedBlockId →
 * 右栏点目标区域即绑定；再点同块取消选中。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createBlock, listBlocks, type Block } from '../api/blocks'

export const useBlocksStore = defineStore('blocks', () => {
  const blocks = ref<Block[]>([])
  const error = ref<string | null>(null)
  /** 正向绑定流选中的块（null = 未选中）。 */
  const selectedBlockId = ref<number | null>(null)
  const selectedBlock = computed(
    () => blocks.value.find(b => b.id === selectedBlockId.value) ?? null,
  )

  /** 新建表单态。 */
  const creating = ref(false)
  const createError = ref<string | null>(null)

  async function loadBlocks(): Promise<void> {
    try {
      blocks.value = await listBlocks()
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function createNewBlock(name: string, content: string): Promise<boolean> {
    creating.value = true
    createError.value = null
    try {
      const block = await createBlock({ name, content })
      blocks.value = [...blocks.value, block]
      selectedBlockId.value = block.id // 新建即选中：建完可直接点区域绑定
      return true
    } catch (err) {
      createError.value = err instanceof Error ? err.message : String(err)
      return false
    } finally {
      creating.value = false
    }
  }

  function selectBlock(id: number | null): void {
    selectedBlockId.value = selectedBlockId.value === id ? null : id
  }

  return {
    blocks,
    error,
    selectedBlockId,
    selectedBlock,
    creating,
    createError,
    loadBlocks,
    createNewBlock,
    selectBlock,
  }
})
