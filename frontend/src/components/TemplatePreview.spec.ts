import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Region } from '../api/templates'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import TemplatePreview from './TemplatePreview.vue'

/** 假 PDF 页（612×792pt，rotation=0），与真实 pdfjs 行为对齐。 */
const fakePage = {
  getViewport: () => ({ width: 612, height: 792 }),
}

/** P22 回归：渲染/取消共享 spy（vi.hoisted 使 mock 工厂可引用）。 */
const { renderSpy, cancelSpy } = vi.hoisted(() => ({
  renderSpy: vi.fn(async () => {}),
  cancelSpy: vi.fn(),
}))

vi.mock('../pdf/viewer', () => {
  const fakeViewport = (scale: number) => ({
    viewBox: [0, 0, 612, 792],
    convertToViewportPoint: (x: number, y: number): number[] => [x * scale, (792 - y) * scale],
  })
  return {
    openDocument: vi.fn(async () => ({
      document: {
        numPages: 1,
        getPage: vi.fn(async () => fakePage),
      },
      destroy: vi.fn(),
    })),
    preparePage: vi.fn(() => ({
      index: 0,
      width: 61.2,
      height: 79.2,
      viewport: fakeViewport(0.1),
      render: renderSpy,
      cancel: cancelSpy,
    })),
  }
})

function region(id: number, bbox: Region['bbox'], binding: DisplayRegion['binding'] = null): DisplayRegion {
  return {
    id,
    template_id: 1,
    type: 'custom',
    label: `字段${id}`,
    placeholder: `{{字段${id}}}`,
    anchor: { kind: 'p', path: [id] },
    order_index: id,
    bbox,
    confidence: null,
    review_status: 'pending',
    created_at: '',
    updated_at: '',
    binding,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function mountPreview() {
  return mount(TemplatePreview, {
    global: { plugins: [createPinia()] },
  })
}

/** 置 ready 态并渲染一页（含区域覆盖层）。 */
async function readyWith(regions: DisplayRegion[]) {
  const wrapper = mountPreview()
  const store = usePreviewStore()
  store.status = 'ready'
  store.currentTemplateId = 1
  store.pdfData = new ArrayBuffer(8)
  store.regions = regions
  await flushPromises()
  return { wrapper, store }
}

describe('TemplatePreview（M5a 只读预览）', () => {
  it('idle 态：提示选择模板', () => {
    const wrapper = mountPreview()
    expect(wrapper.text()).toContain('请在上方工具条选择模板开始预览')
  })

  it('loading 态：显示生成中提示（D12 首次渲染进度反馈）', async () => {
    const wrapper = mountPreview()
    const store = usePreviewStore()
    store.status = 'loading'
    await flushPromises()
    expect(wrapper.text()).toContain('正在生成预览')
  })

  it('error 态：渲染错误信息', async () => {
    const wrapper = mountPreview()
    const store = usePreviewStore()
    store.status = 'error'
    store.error = 'LibreOffice 未安装'
    await flushPromises()
    expect(wrapper.text()).toContain('LibreOffice 未安装')
  })

  it('ready 态：黄/绿覆盖层按 bbox 定位 + 未定位区域画虚线徽标 + 图例统计', async () => {
    const { wrapper } = await readyWith([
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
      region(2, null),
      region(3, { page: 0, x0: 10, y0: 20, x1: 30, y1: 25 }, {
        block_id: 9,
        block_name: '姓名块',
        status: 'active',
      }),
    ])

    // 页容器（fit-width scale 在 jsdom 无宽度 → 保底 0.1）
    const page = wrapper.find('.pdf-page')
    expect(page.exists()).toBe(true)
    expect(page.find('canvas').exists()).toBe(true)

    // 黄色覆盖层：scale=0.1 → left=10px / top=20px / width=20px / height=5px
    const overlay = wrapper.find('.overlay.pending')
    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('style')).toContain('left: 10px')
    expect(overlay.attributes('style')).toContain('top: 20px')
    expect(overlay.attributes('style')).toContain('width: 20px')
    expect(overlay.attributes('style')).toContain('height: 5px')
    expect(overlay.attributes('title')).toBe('字段1（未绑定，点击选择字符块）')

    // 绿色覆盖层（M6a：active 绑定）
    const bound = wrapper.find('.overlay.bound')
    expect(bound.exists()).toBe(true)
    expect(bound.attributes('title')).toBe('字段3（已绑定：姓名块）')

    // 未定位（bbox=null）→ 虚线徽标列表
    const chip = wrapper.find('.unplaced-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('字段2')

    // 工具条图例统计
    expect(wrapper.find('.preview-toolbar').text()).toContain('已绑定 1')
    expect(wrapper.find('.preview-toolbar').text()).toContain('待校对 1')
    expect(wrapper.find('.preview-toolbar').text()).toContain('未定位 1')
  })

  it('missing 绑定回落黄框且 title 提示', async () => {
    const { wrapper } = await readyWith([
      region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }, {
        block_id: 9,
        block_name: null,
        status: 'missing',
      }),
    ])
    const overlay = wrapper.find('.overlay.pending')
    expect(overlay.exists()).toBe(true)
    expect(overlay.attributes('title')).toContain('待重新绑定')
  })

  it('切回 idle（pdfData 置空）：清空页面渲染', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    expect(wrapper.find('.pdf-page').exists()).toBe(true)

    store.pdfData = null
    store.status = 'idle'
    await flushPromises()
    expect(wrapper.find('.pdf-page').exists()).toBe(false)
    expect(wrapper.text()).toContain('请在上方工具条选择模板开始预览')
  })

  it('P22 回归：loading 态 pdfData 先到不渲染（DOM 无 canvas），ready 后补渲染', async () => {
    const wrapper = mountPreview()
    const store = usePreviewStore()
    store.pdfData = new ArrayBuffer(8)
    store.status = 'loading'
    await flushPromises()
    expect(renderSpy).not.toHaveBeenCalled() // loading 态无 canvas，不盲目渲染

    store.regions = [region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })]
    store.status = 'ready'
    await flushPromises()
    expect(renderSpy).toHaveBeenCalledTimes(1) // ready 触发补渲染
    expect(wrapper.find('.pdf-page').exists()).toBe(true)
  })

  it('P22 回归：重排（regions 变化）触发 rebuild 时取消上一批在飞渲染', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).not.toHaveBeenCalled()

    store.regions = [region(2, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })]
    await flushPromises()
    expect(cancelSpy).toHaveBeenCalledTimes(1) // 旧批次先取消再重排
    expect(renderSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.overlay.pending').attributes('title')).toBe('字段2（未绑定，点击选择字符块）')
  })
})

describe('TemplatePreview 绑定交互（M6a）', () => {
  it('正向：左栏已选块 → 点区域直接绑定', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    const blocksStore = useBlocksStore()
    blocksStore.selectedBlockId = 7
    const bindSpy = vi.spyOn(store, 'bindRegionToBlock').mockResolvedValue(true)

    await wrapper.find('.overlay').trigger('click')
    expect(bindSpy).toHaveBeenCalledWith(1, 7)
    expect(wrapper.find('[data-testid="binding-dialog"]').exists()).toBe(false)
  })

  it('反向：未选块 → 点区域弹浮层，点块项绑定', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    const bindSpy = vi.spyOn(store, 'bindRegionToBlock').mockResolvedValue(true)
    const blocksStore = useBlocksStore()
    blocksStore.blocks = [
      {
        id: 9,
        name: '姓名块',
        content: '张三',
        tags: [],
        created_at: '',
        updated_at: '',
      },
    ]

    await wrapper.find('.overlay').trigger('click')
    const dialog = wrapper.find('[data-testid="binding-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('区域：字段1')

    await dialog.find('.block-item').trigger('click')
    expect(bindSpy).toHaveBeenCalledWith(1, 9)
    expect(wrapper.find('[data-testid="binding-dialog"]').exists()).toBe(false)
  })

  it('已绑定区域：浮层显示当前块，点解绑', async () => {
    const { wrapper, store } = await readyWith([
      region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }, {
        block_id: 9,
        block_name: '姓名块',
        status: 'active',
      }),
    ])
    const unbindSpy = vi.spyOn(store, 'unbindRegionFromBlock').mockResolvedValue(true)

    await wrapper.find('.overlay.bound').trigger('click')
    const dialog = wrapper.find('[data-testid="binding-dialog"]')
    expect(dialog.text()).toContain('当前绑定')
    expect(dialog.text()).toContain('姓名块')

    await dialog.find('.danger').trigger('click')
    expect(unbindSpy).toHaveBeenCalledWith(1)
    expect(wrapper.find('[data-testid="binding-dialog"]').exists()).toBe(false)
  })

  it('浮层遮罩点击关闭', async () => {
    const { wrapper } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    await wrapper.find('.overlay').trigger('click')
    expect(wrapper.find('[data-testid="binding-dialog"]').exists()).toBe(true)
    await wrapper.find('[data-testid="binding-dialog"]').trigger('click')
    expect(wrapper.find('[data-testid="binding-dialog"]').exists()).toBe(false)
  })

  it('绑定失败：error 横幅展示（不动摇已渲染内容）', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    store.error = '块不存在'
    await flushPromises()
    expect(wrapper.find('.error-banner').text()).toBe('块不存在')
    expect(wrapper.find('.pdf-page').exists()).toBe(true)
  })

  it('refreshing：工具条显示刷新指示（D12）', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    store.refreshing = true
    await flushPromises()
    expect(wrapper.find('.preview-toolbar').text()).toContain('正在刷新预览')
  })
})

describe('TemplatePreview 工具条模板下拉（UI 调整③，idle 态可选）', () => {
  /** stub /api/templates（组件挂载即 loadTemplates）。 */
  function stubTemplates(list: unknown[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        if (String(input) === '/api/templates') {
          return Promise.resolve(Response.json({ templates: list }))
        }
        return Promise.resolve(Response.json({}, { status: 404 }))
      }),
    )
  }

  it('挂载即加载模板列表并渲染下拉项（工具条常驻）', async () => {
    stubTemplates([
      { id: 1, filename: '简历模板A.docx', regions_count: 3 },
      { id: 2, filename: '简历模板B.docx', regions_count: 0 },
    ])
    const wrapper = mountPreview()
    await flushPromises()
    const options = wrapper.findAll('.template-select option')
    expect(options).toHaveLength(3) // 占位项 + 2 模板
    expect(options[1].text()).toBe('简历模板A.docx')
    expect(options[2].text()).toBe('简历模板B.docx')
  })

  it('列表为空：下拉禁用并显示（暂无模板）', async () => {
    stubTemplates([])
    const wrapper = mountPreview()
    await flushPromises()
    const select = wrapper.find('.template-select')
    expect((select.element as HTMLSelectElement).disabled).toBe(true)
    expect(select.text()).toContain('（暂无模板）')
  })

  it('idle 态选择模板触发 store.selectTemplate', async () => {
    stubTemplates([{ id: 7, filename: '模板七.docx', regions_count: 1 }])
    const wrapper = mountPreview()
    await flushPromises()
    const store = usePreviewStore()
    expect(store.status).toBe('idle')
    const spy = vi.spyOn(store, 'selectTemplate').mockResolvedValue(undefined)
    await wrapper.find('.template-select').setValue('7')
    expect(spy).toHaveBeenCalledWith(7)
  })
})

describe('块库展开按钮（UI 调整②批）', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ templates: [] }))),
    )
  })

  it('展开态：工具条不显示展开按钮', async () => {
    const wrapper = mountPreview()
    await flushPromises()
    expect(useBlocksStore().libraryOpen).toBe(true)
    expect(wrapper.find('button.library-expand').exists()).toBe(false)
  })

  it('收起态：工具条最左显示 [块库] 按钮，点击展开', async () => {
    const wrapper = mountPreview()
    const blocksStore = useBlocksStore() // mount 后取：与组件同一 pinia 实例
    blocksStore.libraryOpen = false
    await flushPromises()
    const btn = wrapper.find('button.library-expand')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('块库')
    expect(btn.find('svg').exists()).toBe(true)
    await btn.trigger('click')
    expect(blocksStore.libraryOpen).toBe(true)
  })
})
