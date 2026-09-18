import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from './blocks'

function stubFetch(routes: Record<string, () => unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const handler = routes[url]
      if (handler === undefined) {
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }
      return Promise.resolve(Response.json(handler(), { status: 200 }))
    }),
  )
}

const block = (id: number, name: string, category = '未分类', tags: { id: number; name: string }[] = []) => ({
  id,
  name,
  content: `${name}内容`,
  category,
  tags,
  created_at: '',
  updated_at: '',
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('blocks store（M6a 基础）', () => {
  it('loadBlocks：列表写入', async () => {
    stubFetch({
      '/api/blocks': () => ({ blocks: [block(1, '姓名'), block(2, '电话')] }),
    })
    const store = useBlocksStore()
    await store.loadBlocks()
    expect(store.blocks.map(b => b.name)).toEqual(['姓名', '电话'])
    expect(store.error).toBeNull()
  })

  it('loadBlocks：失败写 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const store = useBlocksStore()
    await store.loadBlocks()
    expect(store.error).toBe('无法连接本地服务，请确认后端已启动')
  })

  it('createNewBlock：成功追加列表并复位表单态', async () => {
    stubFetch({
      '/api/blocks': () => ({ blocks: [] }),
      '/api/tags': () => ({ tags: [] }),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/blocks' && init?.method === 'POST') {
          return Promise.resolve(Response.json(block(7, '新块'), { status: 201 }))
        }
        if (String(input) === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        return Promise.reject(new Error('unexpected'))
      }),
    )
    const store = useBlocksStore()
    const ok = await store.createNewBlock('新块', '内容')
    expect(ok).toBe(true)
    expect(store.blocks).toHaveLength(1)
    expect(store.blocks[0].name).toBe('新块')
    expect(store.selectedBlockId).toBe(7) // 新建即选中（建完可直接点区域绑定）
    expect(store.createError).toBeNull()
  })

  it('createNewBlock：校验失败写 createError、返回 false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { error: { code: 'BLOCK_INVALID', message: '块名称长度须在 2–30 字之间' } },
          { status: 400 },
        ),
      ),
    )
    const store = useBlocksStore()
    const ok = await store.createNewBlock('名', '内容')
    expect(ok).toBe(false)
    expect(store.createError).toContain('块名称长度')
    expect(store.blocks).toHaveLength(0)
  })

  it('selectBlock：点选高亮、再点同块取消', () => {
    const store = useBlocksStore()
    store.selectBlock(3)
    expect(store.selectedBlockId).toBe(3)
    store.selectBlock(3)
    expect(store.selectedBlockId).toBeNull()
  })
})

describe('blocks store（M2 更新/删除）', () => {
  it('updateExistingBlock：成功替换列表项', async () => {
    const store = useBlocksStore()
    store.blocks = [block(1, '姓名')]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/blocks/1' && init?.method === 'PUT') {
          return Promise.resolve(Response.json(block(1, '姓名改')))
        }
        return Promise.reject(new Error('unexpected'))
      }),
    )
    const ok = await store.updateExistingBlock(1, { name: '姓名改' })
    expect(ok).toBe(true)
    expect(store.blocks[0].name).toBe('姓名改')
    expect(store.updateError).toBeNull()
  })

  it('updateExistingBlock：失败写 updateError 返回 false', async () => {
    const store = useBlocksStore()
    store.blocks = [block(1, '姓名')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { error: { code: 'BLOCK_INVALID', message: '块名称长度须在 2–30 字之间' } },
          { status: 400 },
        ),
      ),
    )
    const ok = await store.updateExistingBlock(1, { name: '名' })
    expect(ok).toBe(false)
    expect(store.updateError).toContain('块名称长度')
    expect(store.blocks[0].name).toBe('姓名') // 原项不动
  })

  it('removeBlock：成功移除并清空选中（D11）', async () => {
    const store = useBlocksStore()
    store.blocks = [block(1, '姓名'), block(2, '电话')]
    store.selectedBlockId = 1
    stubFetch({ '/api/tags': () => ({ tags: [] }) })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/blocks/1') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (String(input) === '/api/tags') {
        return Promise.resolve(Response.json({ tags: [] }))
      }
      return Promise.reject(new Error('unexpected'))
    }))
    const ok = await store.removeBlock(1)
    expect(ok).toBe(true)
    expect(store.blocks.map(b => b.id)).toEqual([2])
    expect(store.selectedBlockId).toBeNull() // 删的是选中块
  })

  it('removeBlock：失败写 mutationError', async () => {
    const store = useBlocksStore()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ error: { code: 'BLOCK_NOT_FOUND', message: '不存在' } }, { status: 404 }),
      ),
    )
    const ok = await store.removeBlock(99)
    expect(ok).toBe(false)
    expect(store.mutationError).toContain('不存在')
  })
})

describe('blocks store（M2 标签筛选与管理）', () => {
  it('toggleTagFilter + filteredBlocks + groupedBlocks 分组', () => {
    const store = useBlocksStore()
    store.blocks = [
      block(1, '姓名', '基本信息', [{ id: 10, name: '求职' }]),
      block(2, '电话', '基本信息', []),
      block(3, '评价', '其他', [{ id: 10, name: '求职' }]),
    ]
    expect(store.groupedBlocks.map(g => g.category)).toEqual(['基本信息', '其他'])
    expect(store.groupedBlocks[0].blocks.map(b => b.id)).toEqual([1, 2])

    store.toggleTagFilter(10)
    expect(store.filteredBlocks.map(b => b.id)).toEqual([1, 3])
    expect(store.groupedBlocks.map(g => g.category)).toEqual(['基本信息', '其他'])

    store.toggleTagFilter(10) // 再点取消筛选
    expect(store.activeTagId).toBeNull()
    expect(store.filteredBlocks).toHaveLength(3)
  })

  it('loadTags：写入标签列表', async () => {
    stubFetch({
      '/api/tags': () => ({
        tags: [{ id: 10, name: '求职', block_count: 2, created_at: '' }],
      }),
    })
    const store = useBlocksStore()
    await store.loadTags()
    expect(store.tags).toHaveLength(1)
    expect(store.tags[0].block_count).toBe(2)
  })

  it('renameExistingTag：成功返回 null 并刷新列表', async () => {
    const store = useBlocksStore()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/tags/10' && init?.method === 'PUT') {
          return Promise.resolve(Response.json({ id: 11, name: '找工作', created_at: '' }))
        }
        if (url === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [{ id: 11, name: '找工作', block_count: 2, created_at: '' }] }))
        }
        if (url === '/api/blocks') {
          return Promise.resolve(Response.json({ blocks: [] }))
        }
        return Promise.reject(new Error('unexpected'))
      }),
    )
    const err = await store.renameExistingTag(10, '找工作')
    expect(err).toBeNull()
    expect(store.tags[0].name).toBe('找工作')
  })

  it('renameExistingTag：失败返回错误信息', async () => {
    const store = useBlocksStore()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ error: { code: 'TAG_INVALID', message: '标签名不能为空' } }, { status: 400 }),
      ),
    )
    const err = await store.renameExistingTag(10, ' ')
    expect(err).toBe('标签名不能为空')
  })

  it('removeTag：成功且在被筛选标签上时清空筛选', async () => {
    const store = useBlocksStore()
    store.activeTagId = 10
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/tags/10') {
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (url === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        if (url === '/api/blocks') {
          return Promise.resolve(Response.json({ blocks: [] }))
        }
        return Promise.reject(new Error('unexpected'))
      }),
    )
    const ok = await store.removeTag(10)
    expect(ok).toBe(true)
    expect(store.activeTagId).toBeNull()
  })

  it('libraryOpen：默认展开可切换（UI 调整②）', () => {
    const store = useBlocksStore()
    expect(store.libraryOpen).toBe(true)
    store.libraryOpen = false
    expect(store.libraryOpen).toBe(false)
  })
})
