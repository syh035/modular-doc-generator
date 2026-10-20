import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from '../stores/blocks'
import BlockLibrary from './BlockLibrary.vue'
import { usePreviewStore } from '../stores/preview'

const wrappers: VueWrapper[] = []
beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
  localStorage.clear()
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function openLibraryMenu(wrapper: VueWrapper): Promise<void> {
  const menu = wrapper.get<HTMLDetailsElement>('.library-actions')
  menu.element.open = true
  await menu.trigger('toggle')
}

/** 复用 active pinia：组件内 useBlocksStore() 回落到 activePinia，与测试同一实例。 */
function mountLibrary(attach = false) {
  usePreviewStore().currentTemplateId = 1
  const wrapper = mount(BlockLibrary, { attachTo: attach ? document.body : undefined })
  wrappers.push(wrapper)
  return wrapper
}

describe('字符块批量删除', () => {
  async function library() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/usage') ? { versions: [], templates: [] } : String(input) === '/api/tags' ? { tags: [] } : { blocks: [1, 2].map(id => ({ id, name: id === 1 ? '工作' : '项目', content: '正文', tags: [], created_at: '', updated_at: '' })) })))
    const wrapper = mountLibrary()
    await flushPromises()
    return wrapper
  }
  function button(wrapper: ReturnType<typeof mount>, text: string) { return wrapper.findAll('button').find(b => b.text() === text)! }
  it('卡片管理收进菜单；全选限定搜索结果，换筛选清空勾选', async () => {
    const wrapper = await library()
    expect(wrapper.findAll('.item-head > .ops > .danger')).toHaveLength(0)
    expect(wrapper.findAll('.block-menu:not([open])')).toHaveLength(2)
    await openLibraryMenu(wrapper)
    await button(wrapper, '批量管理').trigger('click')
    await wrapper.get('.block-search input').setValue('工作')
    await wrapper.get('[aria-label="全选当前字符块列表"]').setValue(true)
    expect(wrapper.text()).toContain('已选 1 项')
    await wrapper.get('.block-search input').setValue('')
    expect(wrapper.text()).toContain('已选 0 项')
    expect(button(wrapper, '批量删除').attributes('disabled')).toBeDefined()
  })
  it('二次确认后逐项删除，失败项保留并显示错误', async () => {
    const wrapper = await library()
    const store = useBlocksStore()
    const spy = vi.spyOn(store, 'removeBlock').mockImplementation(async id => {
      if (id === 2) { store.mutationError = '保存失败'; return false }
      store.blocks = store.blocks.filter(b => b.id !== id)
      return true
    })
    await openLibraryMenu(wrapper)
    await button(wrapper, '批量管理').trigger('click')
    await wrapper.get('[aria-label="全选当前字符块列表"]').setValue(true)
    await button(wrapper, '批量删除').trigger('click')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    await button(wrapper, '确认批量删除').trigger('click')
    await flushPromises()
    expect(spy.mock.calls.map(c => c[0])).toEqual([1, 2])
    expect(wrapper.get('[role="status"]').text()).toContain('已删除 1 个字符块；未删除：项目：保存失败')
    expect(wrapper.text()).toContain('已选 1 项')
  })
})

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

  it('头部保留新建入口，块库开关集中在工具条', async () => {
    stubList()
    const wrapper = mountLibrary()
    await flushPromises()
    expect(wrapper.find('button.icon-collapse').exists()).toBe(false)
    expect(wrapper.get('.header .primary').attributes('aria-label')).toBe('+ 新建字符块')
    expect(wrapper.text()).toContain('当前模板')
    expect(wrapper.find('.scope-hint').exists()).toBe(false)
    expect(wrapper.find('.result-count').exists()).toBe(false)
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
    const inputs = wrapper.findAll('.editor-fields input, .editor-fields textarea')
    await inputs[0].setValue('新块')
    await inputs[1].setValue('内容')
    await wrapper.find('form button[type="submit"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('form').exists()).toBe(false) // 收起
    expect(wrapper.text()).toContain('新块')
    expect(wrapper.findAll('.block-item')).toHaveLength(1)
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
    const inputs = wrapper.findAll('.editor-fields input, .editor-fields textarea')
    await inputs[0].setValue('名')
    await inputs[1].setValue('内容')
    await wrapper.find('form button[type="submit"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('.editor-fields .error').text()).toContain('块名称长度')
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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/tags' ? { tags: [] } : { blocks: store.blocks })))
    const wrapper = mountLibrary()
    await flushPromises()

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
    expect(wrapper.find('.empty').text()).toContain('当前模板暂无字符块')
  })
})


it('未选模板隐藏详情；选模板与绑定变化刷新列表，切换关闭草稿和批量', async () => {
  const all = [1, 2].map(id => ({ id, name: `块${id}`, content: `正文${id}`, tags: [], created_at: '', updated_at: '' }))
  let bound = [all[0]]
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    return Promise.resolve(Response.json(url === '/api/tags' ? { tags: [] }
      : { blocks: url.includes('template_id=') ? bound : all }))
  }))
  const preview = usePreviewStore()
  const wrapper = mount(BlockLibrary)
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).toContain('请先选择模板')
  expect(wrapper.findAll('.block-item')).toHaveLength(0)
  expect(wrapper.get('.header .primary').attributes('disabled')).toBeDefined()
  preview.currentTemplateId = 1
  await flushPromises()
  expect(wrapper.findAll('.block-item')).toHaveLength(1)
  expect(wrapper.text()).not.toContain('正文2')
  bound = all
  preview.regions = []
  await flushPromises()
  expect(wrapper.findAll('.block-item')).toHaveLength(2)
  await wrapper.get('.header .primary').trigger('click')
  expect(wrapper.find('form').exists()).toBe(true)
  bound = []
  preview.currentTemplateId = 2
  await flushPromises()
  expect(wrapper.find('form').exists()).toBe(false)
  expect(wrapper.findAll('.block-item')).toHaveLength(0)
  expect(wrapper.text()).toContain('当前模板暂无')
  preview.currentTemplateId = null
  await flushPromises()
  expect(wrapper.text()).toContain('请先选择模板')
})


it('新建块归属当前模板，共享块显式加入并保持同一身份', async () => {
  const shared = { id: 8, name: '其他模板块', content: '共享正文', tags: [], created_at: '', updated_at: '' }
  let members: typeof shared[] = []
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/tags') return Promise.resolve(Response.json({ tags: [] }))
    if (url === '/api/blocks/8/templates/1' && init?.method === 'POST') { members = [shared]; return Promise.resolve(Response.json({ block_id: 8, template_id: 1 })) }
    if (url.includes('template_id=')) return Promise.resolve(Response.json({ blocks: members }))
    return Promise.resolve(Response.json({ blocks: [shared] }))
  })
  vi.stubGlobal('fetch', fetchFn)
  const wrapper = mountLibrary()
  await flushPromises()
  expect(wrapper.findAll('.block-item')).toHaveLength(0)
  const button = (text: string) => wrapper.findAll('button').find(b => b.text() === text)!
  await openLibraryMenu(wrapper)
  await button('共享块').trigger('click')
  await flushPromises()
  expect(wrapper.get('[aria-label="共享字符块"]').text()).toContain('影响所有使用它的模板')
  await button('加入当前模板').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('.block-item')).toHaveLength(1)
  expect(button('已加入').attributes('disabled')).toBeDefined()
  expect(fetchFn.mock.calls.some(([url, init]) => url === '/api/blocks/8/templates/1' && init?.method === 'POST')).toBe(true)
})


it('精简标签入口，统一搜索仍匹配标签且不受旧筛选状态影响', async () => {
  const blocks = [
    { id: 1, name: '经历', content: '第一段', tags: [{ id: 2, name: '研发' }], created_at: '', updated_at: '' },
    { id: 2, name: '成果', content: '第二段', tags: [{ id: 3, name: '设计' }], created_at: '', updated_at: '' },
  ]
  const fetchFn = vi.fn(async () => Response.json({ blocks, tags: [] }))
  vi.stubGlobal('fetch', fetchFn)
  const wrapper = mountLibrary()
  await flushPromises()
  useBlocksStore().activeTagId = 999
  await flushPromises()
  expect(wrapper.findAll('.block-item')).toHaveLength(2)
  expect(wrapper.find('.tag-bar').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('标签管理')
  await wrapper.get('.block-search input').setValue('研发')
  expect(wrapper.findAll('.block-item')).toHaveLength(1)
  expect(wrapper.get('.block-item').text()).toContain('第一段')
  await openLibraryMenu(wrapper)
  await wrapper.findAll('button').find(b => b.text() === '批量管理')!.trigger('click')
  expect(wrapper.text()).not.toContain('批量标签')
  await wrapper.get('[aria-label="全选当前字符块列表"]').setValue(true)
  expect(wrapper.text()).toContain('已选 1 项')
  await wrapper.get('.block-search input').setValue('')
  expect(wrapper.findAll('.block-item')).toHaveLength(2)
  expect(wrapper.text()).toContain('已选 0 项')
  expect(useBlocksStore().blocks[0].tags[0].name).toBe('研发')
})

describe('字符块库紧凑菜单', () => {
  const blocks = [{ id: 1, name: '经历', content: '第一行\n第二行\n第三行', tags: [], created_at: '', updated_at: '' }]
  function stubLibrary(): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/usage')
      ? { versions: [], templates: [] } : String(input) === '/api/tags' ? { tags: [] } : { blocks })))
  }
  it('库菜单和卡片菜单响应 Esc 与外部点击，不误选内容块', async () => {
    stubLibrary()
    const wrapper = mountLibrary(true)
    await flushPromises()
    await openLibraryMenu(wrapper)
    const libraryMenu = wrapper.get<HTMLDetailsElement>('.library-actions')
    const libraryTrigger = libraryMenu.get('summary')
    ;(libraryTrigger.element as HTMLElement).focus()
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(libraryMenu.element.open).toBe(false)
    expect(document.activeElement).toBe(libraryTrigger.element)

    const cardMenu = wrapper.get<HTMLDetailsElement>('.block-menu')
    cardMenu.element.open = true
    const search = wrapper.get('.block-search input')
    ;(search.element as HTMLInputElement).focus()
    await search.trigger('pointerdown')
    expect(cardMenu.element.open).toBe(false)
    expect(document.activeElement).toBe(search.element)
    expect(useBlocksStore().selectedBlockId).toBeNull()
  })
  it('编辑后关闭菜单，退出编辑归还卡片入口', async () => {
    stubLibrary()
    const wrapper = mountLibrary(true)
    await flushPromises()
    const menu = wrapper.get<HTMLDetailsElement>('.block-menu')
    menu.element.open = true
    const edit = menu.findAll('button').find(button => button.text() === '编辑')!
    ;(edit.element as HTMLButtonElement).focus()
    await edit.trigger('click')
    await flushPromises()
    expect(menu.element.open).toBe(false)
    expect(useBlocksStore().selectedBlockId).toBeNull()
    await wrapper.get('[aria-label="关闭块编辑"]').trigger('click')
    expect(document.activeElement).toBe(menu.get('summary').element)
  })
  it.each(['.library-actions', '.block-menu'])('Tab 可进入 %s 的操作，焦点离开后才收起', async selector => {
    stubLibrary()
    const wrapper = mountLibrary(true)
    await flushPromises()
    const menu = wrapper.get<HTMLDetailsElement>(selector)
    const summary = menu.get('summary')
    ;(summary.element as HTMLElement).focus()
    // jsdom 不合成 Enter 激活，使用 summary 的原生 click 展开 details。
    ;(summary.element as HTMLElement).click()
    expect(menu.element.open).toBe(true)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    summary.element.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(menu.element.open).toBe(true)
    // jsdom 不执行原生 Tab 移动，显式模拟浏览器随后产生的真实 focusin。
    const actions = menu.findAll('button')
    ;(actions[0].element as HTMLButtonElement).focus()
    expect(menu.element.open).toBe(true)
    ;(actions[1].element as HTMLButtonElement).focus()
    expect(menu.element.open).toBe(true)
    const search = wrapper.get('.block-search input')
    ;(search.element as HTMLInputElement).focus()
    expect(menu.element.open).toBe(false)
    expect(document.activeElement).toBe(search.element)
  })
  it('删除仍等待影响范围加载并二次确认，取消后归还卡片入口', async () => {
    let resolveUsage!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/usage')
      ? new Promise<Response>(resolve => { resolveUsage = resolve })
      : Response.json(String(input) === '/api/tags' ? { tags: [] } : { blocks })))
    const wrapper = mountLibrary(true)
    await flushPromises()
    const remove = vi.spyOn(useBlocksStore(), 'removeBlock')
    const menu = wrapper.get<HTMLDetailsElement>('.block-menu')
    menu.element.open = true
    await menu.findAll('button').find(button => button.text() === '删除')!.trigger('click')
    await flushPromises()
    const confirmation = wrapper.get('.delete-confirm')
    const confirm = confirmation.findAll('button').find(button => button.text() === '确认删除')!
    expect(menu.element.open).toBe(false)
    expect(confirm.attributes('disabled')).toBeDefined()
    expect(remove).not.toHaveBeenCalled()
    resolveUsage(Response.json({ versions: [], templates: [] }))
    await flushPromises()
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirmation.get('.cancel-delete').trigger('click')
    expect(wrapper.find('.delete-confirm').exists()).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(menu.get('summary').element)
  })
})
