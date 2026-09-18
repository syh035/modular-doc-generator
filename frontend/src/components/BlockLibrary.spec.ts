import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from '../stores/blocks'
import BlockLibrary from './BlockLibrary.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 复用 active pinia：组件内 useBlocksStore() 回落到 activePinia，与测试同一实例。 */
function mountLibrary() {
  return mount(BlockLibrary)
}

describe('BlockLibrary 头部折叠与宽度绑定（UI 调整②批）', () => {
  const stubList = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        return Promise.resolve(Response.json({ blocks: [] }))
      }),
    )
  }

  it('头部有矩形竖线折叠按钮，点击收起抽屉（store.libraryOpen=false）', async () => {
    stubList()
    const wrapper = mountLibrary()
    await flushPromises()
    const btn = wrapper.find('button.icon-collapse')
    expect(btn.exists()).toBe(true)
    expect(btn.find('svg').exists()).toBe(true) // 矩形内置竖线用 SVG 呈现
    await btn.trigger('click')
    expect(useBlocksStore().libraryOpen).toBe(false)
  })

  it('抽屉宽度跟随 store.libraryWidth', async () => {
    stubList()
    const store = useBlocksStore()
    store.setLibraryWidth(355)
    const wrapper = mountLibrary()
    await flushPromises()
    expect(wrapper.find('aside.block-library').attributes('style')).toContain('355px')
  })
})

describe('BlockLibrary（M6a 最小实现）', () => {
  it('挂载即加载块列表', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        return Promise.resolve(
          Response.json({
            blocks: [
              {
                id: 1,
                name: '姓名',
                content: '张三',
                tags: [],
                created_at: '',
                updated_at: '',
              },
            ],
          }),
        )
      }),
    )
    const wrapper = mountLibrary()
    await flushPromises()
    expect(wrapper.text()).toContain('张三')
    expect(wrapper.text()).not.toContain('Body is unusable')
  })

  it('新建表单：提交成功后收起并追加列表', async () => {
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/tags') {
        return Promise.resolve(Response.json({ tags: [] }))
      }
      if (url === '/api/blocks' && init?.method === 'POST') {
        return Promise.resolve(
          Response.json(
            {
              id: 7,
              name: '新块',
              content: '内容',
              tags: [],
              created_at: '',
              updated_at: '',
            },
            { status: 201 },
          ),
        )
      }
      return Promise.resolve(Response.json({ blocks: [] }))
    })
    vi.stubGlobal('fetch', fetchFn)
    const wrapper = mountLibrary()
    await flushPromises()

    await wrapper.find('.header .primary').trigger('click')
    const inputs = wrapper.findAll('.input')
    await inputs[0].setValue('新块')
    await inputs[1].setValue('内容')
    await wrapper.find('form button[type="submit"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('form').exists()).toBe(false) // 收起
    expect(wrapper.text()).toContain('新块')
    const store = useBlocksStore()
    expect(store.blocks).toHaveLength(1)
  })

  it('新建表单：失败展示错误、表单保留', async () => {
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/tags') {
        return Promise.resolve(Response.json({ tags: [] }))
      }
      if (String(input) === '/api/blocks') {
        return Promise.resolve(
          Response.json(
            { error: { code: 'BLOCK_INVALID', message: '块名称长度须在 2–30 字之间' } },
            { status: 400 },
          ),
        )
      }
      return Promise.resolve(Response.json({ blocks: [] }))
    })
    vi.stubGlobal('fetch', fetchFn)
    const wrapper = mountLibrary()
    await flushPromises()

    await wrapper.find('.header .primary').trigger('click')
    const inputs = wrapper.findAll('.input')
    await inputs[0].setValue('名')
    await inputs[1].setValue('内容')
    await wrapper.find('form button[type="submit"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.form-error').text()).toContain('块名称长度')
    expect(wrapper.find('form').exists()).toBe(true)
  })

  it('点选块高亮 + 提示正向绑定流；再点取消', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        return Promise.resolve(Response.json({ blocks: [] }))
      }),
    )
    const store = useBlocksStore()
    store.blocks = [
      {
        id: 3,
        name: '姓名块',
        content: '张三',
        tags: [],
        created_at: '',
        updated_at: '',
      },
    ]
    const wrapper = mountLibrary()

    await wrapper.find('.block-item').trigger('click')
    expect(store.selectedBlockId).toBe(3)
    expect(wrapper.find('.selected-tip').text()).toContain('姓名块')
    expect(wrapper.find('.block-item.selected').exists()).toBe(true)

    await wrapper.find('.block-item').trigger('click')
    expect(store.selectedBlockId).toBeNull()
    expect(wrapper.find('.selected-tip').exists()).toBe(false)
  })

  it('空库提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/tags') {
          return Promise.resolve(Response.json({ tags: [] }))
        }
        return Promise.resolve(Response.json({ blocks: [] }))
      }),
    )
    const store = useBlocksStore()
    store.blocks = []
    const wrapper = mountLibrary()
    await flushPromises()
    expect(wrapper.find('.empty').text()).toContain('暂无字符块')
  })
})
