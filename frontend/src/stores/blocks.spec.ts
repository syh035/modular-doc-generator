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

const block = (id: number, name: string) => ({
  id,
  name,
  content: `${name}内容`,
  category: '未分类',
  created_at: '',
  updated_at: '',
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('blocks store（M6a）', () => {
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
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/blocks') {
          return Promise.resolve(Response.json(block(7, '新块'), { status: 201 }))
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
