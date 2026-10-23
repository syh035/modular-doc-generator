import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Region } from '../api/templates'
import * as blocksApi from '../api/blocks'
import { useAppStore } from '../stores/app'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import TemplatePreview from './TemplatePreview.vue'
import { openDocument } from '../pdf/viewer'
import StatusBar from './StatusBar.vue'
import DocumentActions from './DocumentActions.vue'
import { useHistoryStore } from '../stores/history'

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
    convertToPdfPoint: (x: number, y: number): number[] => [x / scale, 792 - y / scale],
  })
  return {
    openDocument: vi.fn(async () => ({
      document: {
        numPages: 1,
        getPage: vi.fn(async () => fakePage),
      },
      destroy: vi.fn(),
    })),
    preparePage: vi.fn((page: { pageNumber?: number }) => ({
      index: (page.pageNumber ?? 1) - 1,
      width: 61.2,
      height: 79.2,
      viewport: fakeViewport(0.1),
      render: renderSpy,
      cancel: cancelSpy,
    })),
  }
})

function region(
  id: number,
  bbox: Region['bbox'],
  binding: DisplayRegion['binding'] = null,
  overflow: DisplayRegion['overflow'] = null,
): DisplayRegion {
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
    overflow,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

function mountPreview() {
  const wrapper = mount(TemplatePreview, {
    global: { plugins: [createPinia()] },
  })
  useAppStore().setTab('workbench')
  return wrapper
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

it('校对保存期间保留浮层并锁定，失败内联展示，成功后才关闭', async () => {
  const { wrapper, store } = await readyWith([
    region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
  ])
  store.proofreadMode = true
  await flushPromises()
  let complete!: (result: { ok: boolean; error: string | null }) => void
  const save = vi.spyOn(store, 'confirmRegion').mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await wrapper.get('.overlay').trigger('click')
  await wrapper.get('[data-testid=proofread-confirm]').trigger('click')
  expect(wrapper.find('[data-testid=proofread-popover]').exists()).toBe(true)
  expect(wrapper.get('[data-testid=proofread-confirm]').attributes('disabled')).toBeDefined()
  complete({ ok: false, error: '保存失败，请重试' })
  await flushPromises()
  expect(wrapper.get('[data-testid=proofread-popover] [role=alert]').text()).toContain('保存失败')
  save.mockResolvedValue({ ok: true, error: null })
  await wrapper.get('[data-testid=proofread-confirm]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid=proofread-popover]').exists()).toBe(false)
  wrapper.unmount()
})

describe('TemplatePreview（M5a 只读预览）', () => {
  it('预览工具默认折叠，展开后可按 Esc 或点外部收起', async () => {
    const { wrapper } = await readyWith([])
    const tools = wrapper.get('details.legend-menu')
    expect(tools.attributes('open')).toBeUndefined()
    const element = tools.element as HTMLDetailsElement
    element.open = true
    await tools.trigger('keydown', { key: 'Escape' })
    expect(element.open).toBe(false)
    element.open = true
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(element.open).toBe(false)
    wrapper.unmount()
  })
  it('正常稿件可从工具条归档，校对或刷新时不归档模板画面', async () => {
    const { wrapper, store } = await readyWith([])
    store.currentVersionId = 3
    await flushPromises()
    await wrapper.get('[data-testid=archive-btn]').trigger('click')
    expect(wrapper.emitted('archive')).toHaveLength(1)
    store.proofreadMode = true
    await flushPromises()
    expect(wrapper.get('[data-testid=archive-btn]').attributes('disabled')).toBeDefined()
    store.proofreadMode = false
    store.refreshing = true
    await flushPromises()
    expect(wrapper.get('[data-testid=archive-btn]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('idle 态：提示选择模板', () => {
    const wrapper = mountPreview()
    expect(wrapper.text()).toContain('选择文稿开始编辑')
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
    expect(chip.text()).toBe('字段2 · 重新框选')

    // 工具条图例统计
    expect(wrapper.find('.preview-controls').text()).toContain('已绑定 1')
    expect(wrapper.find('.preview-controls').text()).toContain('待绑定 1')
    expect(wrapper.find('.preview-controls').text()).toContain('未定位 1')
  })

  it('Q4 回归：excluded 区域不计入「待校对」统计（与 overlay 可见数一致）', async () => {
    const excluded = {
      ...region(4, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
      review_status: 'excluded' as const,
    }
    const { wrapper } = await readyWith([
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
      excluded,
    ])
    // overlay 只渲染非 excluded 的 1 个，统计同口径
    expect(wrapper.findAll('.overlay')).toHaveLength(1)
    expect(wrapper.find('.preview-controls').text()).toContain('待绑定 1')
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
    expect(wrapper.text()).toContain('选择文稿开始编辑')
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
    expect(renderSpy).toHaveBeenCalledTimes(1) // 同一 PDF，仅更新覆盖层
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

    const listSpy = vi.spyOn(blocksApi, 'listBlocks').mockResolvedValueOnce(blocksStore.blocks)
    await blocksStore.loadTemplateBlocks(1)
    listSpy.mockRestore()
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
    expect(wrapper.find('.error-banner').text()).toContain('块不存在')
    expect(wrapper.find('.error-banner button').text()).toBe('重试预览')
    expect(wrapper.find('.pdf-page').exists()).toBe(true)
  })

  it('refreshing：工具条显示刷新指示（D12）', async () => {
    const { wrapper, store } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    store.refreshing = true
    await flushPromises()
    expect(wrapper.find('.preview-controls').text()).toContain('正在刷新预览')
  })
})

describe('TemplatePreview 模板浏览与文稿入口', () => {
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

  it('缺少模板元数据时仍加载列表，空白编辑页不直接切换模板', async () => {
    stubTemplates([
      { id: 1, filename: '简历模板A.docx', regions_count: 3 },
      { id: 2, filename: '简历模板B.docx', regions_count: 0 },
    ])
    const wrapper = mountPreview()
    await flushPromises()
    expect(usePreviewStore().templates.map(template => template.filename)).toEqual(['简历模板A.docx', '简历模板B.docx'])
    expect(wrapper.find('.template-select').exists()).toBe(false)
    expect(wrapper.text()).toContain('查看文稿')
  })

  it('列表为空仍可导入或回到文稿页，不显示空模板选择器', async () => {
    stubTemplates([])
    const wrapper = mountPreview()
    await flushPromises()
    expect(wrapper.find('.template-select').exists()).toBe(false)
    expect(wrapper.text()).toContain('导入模板')
  })

  it('浏览所用模板只进入模板页，不调用预览切换', async () => {
    stubTemplates([{ id: 7, filename: '模板七.docx', regions_count: 1 }])
    const wrapper = mountPreview()
    await flushPromises()
    const store = usePreviewStore()
    expect(store.status).toBe('idle')
    const spy = vi.spyOn(store, 'selectTemplate').mockResolvedValue(undefined)
    await wrapper.get('.template-context').trigger('click')
    expect(useAppStore().activeTab).toBe('templates')
    expect(spy).not.toHaveBeenCalled()
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

  it('展开态：切换入口保持原位置，可收起块库', async () => {
    const wrapper = mountPreview()
    await flushPromises()
    expect(useBlocksStore().libraryOpen).toBe(true)
    const button = wrapper.get('button.library-expand')
    expect(button.attributes('aria-expanded')).toBe('true')
    await button.trigger('click')
    expect(useBlocksStore().libraryOpen).toBe(false)
    expect(button.attributes('aria-expanded')).toBe('false')
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

describe('TemplatePreview 当前文稿上下文', () => {
  it('直接显示当前稿名称和保存状态，不把版本下拉当成文稿入口', async () => {
    const { wrapper, store } = await readyWith([])
    store.currentVersionId = 5
    store.versions = [
      { id: 5, template_id: 1, name: '默认版本', binding_count: 1, created_at: '', updated_at: '' },
      { id: 6, template_id: 1, name: '投递B岗', binding_count: 0, created_at: '', updated_at: '' },
    ]
    await flushPromises()

    expect(wrapper.get('[data-testid=current-document-name]').text()).toBe('默认版本')
    expect(wrapper.get('[data-testid=document-save-state]').text()).toBe('修改已保存')
    expect(wrapper.find('[data-testid=version-select]').exists()).toBe(false)
    expect(wrapper.findComponent(DocumentActions).exists()).toBe(true)
    useHistoryStore().pending = 1
    await flushPromises()
    expect(wrapper.get('[data-testid=document-save-state]').text()).toContain('正在保存')
  })

  it('无版本（历史模板兜底）：不渲染版本控件', async () => {
    const { wrapper } = await readyWith([])
    expect(wrapper.find('[data-testid="version-select"]').exists()).toBe(false)
    expect(wrapper.findComponent(DocumentActions).exists()).toBe(false)
    expect(wrapper.get('[data-testid=current-document-name]').text()).toBe('模板原文')
  })

  it('校对模式：版本控件全部置灰', async () => {
    const { wrapper, store } = await readyWith([])
    store.currentVersionId = 5
    store.versions = [
      { id: 5, template_id: 1, name: '默认版本', binding_count: 0, created_at: '', updated_at: '' },
    ]
    store.proofreadMode = true
    await flushPromises()
    expect(wrapper.findComponent(DocumentActions).props('disabled')).toBe(true)
    expect(wrapper.get('[data-testid=document-save-state]').text()).toContain('正在检查所用模板')
  })

  it('另存完成后直接打开返回的文稿 ID', async () => {
    const { wrapper, store } = await readyWith([])
    store.currentVersionId = 5
    store.versions = [
      { id: 5, template_id: 1, name: '默认版本', binding_count: 0, created_at: '', updated_at: '' },
      { id: 6, template_id: 1, name: '投递B岗', binding_count: 0, created_at: '', updated_at: '' },
    ]
    await flushPromises()
    const spy = vi.spyOn(store, 'selectTemplate').mockResolvedValue(undefined)
    wrapper.getComponent(DocumentActions).vm.$emit('open', store.versions[1])
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(1, { versionId: 6 })
  })

  it('浏览模板入口不会打开包含文稿操作的旧管理弹窗', async () => {
    const { wrapper, store } = await readyWith([])
    const spy = vi.spyOn(store, 'selectTemplate').mockResolvedValue(undefined)
    await wrapper.get('.template-context').trigger('click')
    expect(useAppStore().activeTab).toBe('templates')
    expect(wrapper.find('[aria-label="模板与版本管理"]').exists()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('预览失败重试保持当前稿 ID，不退回默认稿', async () => {
    const { wrapper, store } = await readyWith([])
    store.currentVersionId = 6; store.status = 'error'; store.error = '转换失败'
    const select = vi.spyOn(store, 'selectTemplate').mockResolvedValue()
    await flushPromises()
    await wrapper.get('.state.error button').trigger('click')
    expect(select).toHaveBeenCalledWith(1, { versionId: 6 })
  })
})

describe('TemplatePreview 溢出分级（M7）', () => {
  const LARGE = {
    orig_height: 20,
    new_height: 60,
    ratio: 2.0,
    level: 'large' as const,
    clipped: false,
    fixed_row: false,
  }
  const SMALL = {
    orig_height: 20,
    new_height: 25,
    ratio: 0.25,
    level: 'small' as const,
    clipped: false,
    fixed_row: false,
  }
  const CLIPPED = {
    orig_height: 12,
    new_height: 12.5,
    ratio: 0.0417,
    level: 'large' as const,
    clipped: true,
    fixed_row: true,
  }

  it('大超出红框 / 小超出橙框（覆盖绑定态绿），无溢出区域不受影响', async () => {
    const { wrapper } = await readyWith([
      region(
        1,
        { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 },
        { block_id: 9, block_name: '块A', status: 'active' },
        LARGE,
      ),
      region(
        2,
        { page: 0, x0: 10, y0: 20, x1: 30, y1: 25 },
        { block_id: 8, block_name: '块B', status: 'active' },
        SMALL,
      ),
      region(3, { page: 0, x0: 40, y0: 50, x1: 60, y1: 55 }),
    ])
    const large = wrapper.find('.overlay.overflow-large')
    expect(large.exists()).toBe(true)
    expect(large.classes()).not.toContain('bound') // 溢出着色优先于绑定态
    expect(large.attributes('title')).toContain('溢出 +200%')
    expect(wrapper.find('.overlay.overflow-small').exists()).toBe(true)
    expect(wrapper.find('.overlay.pending').exists()).toBe(true)
  })

  it('clipped：title 提示固定行高裁剪', async () => {
    const { wrapper } = await readyWith([
      region(
        1,
        { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 },
        { block_id: 9, block_name: '块A', status: 'active' },
        CLIPPED,
      ),
    ])
    expect(wrapper.find('.overlay.overflow-large').attributes('title')).toContain('固定行高裁剪')
  })

  it('无溢出数据（模板预览/未测量）：不显示溢出状态条', async () => {
    const { wrapper } = await readyWith([region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })])
    expect(wrapper.find('[data-testid="overflow-bar"]').exists()).toBe(false)
  })

  it('状态条：汇总计数、大超出在前，chip 点击滚动定位并闪烁 1.8s', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper } = await readyWith([
        region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }, null, SMALL),
        region(2, { page: 0, x0: 5, y0: 6, x1: 7, y1: 8 }, null, LARGE),
      ])
      const status = mount(StatusBar, {
        global: { plugins: [getActivePinia()!] },
        props: { onLocate: (r: DisplayRegion) => wrapper.vm.jumpToRegion(r) },
      })
      expect(wrapper.find('[data-testid="overflow-bar"]').exists()).toBe(false)
      const bar = status.find('[data-testid="overflow-bar"]')
      expect(bar.exists()).toBe(true)
      expect(bar.text()).toContain('溢出区域 2 个')
      expect(bar.text()).toContain('大超出 1')

      const chips = bar.findAll('.overflow-chip')
      expect(chips).toHaveLength(2)
      expect(chips[0].classes()).toContain('large') // 大超出排序在前
      expect(chips[0].text()).toContain('字段2')
      expect(chips[0].text()).toContain('+200%')
      expect(chips[1].classes()).toContain('small')
      expect(chips[1].text()).toContain('+25%')

      // 点击 chip → scrollTo 定位 + flashing 类；1.8s 后闪烁清除
      const scrollTo = vi.fn()
      const container = wrapper.find('.preview-scroll').element as HTMLElement
      container.scrollTo = scrollTo
      const pageEl = wrapper.find('[data-page="0"]').element as HTMLElement
      Object.defineProperty(pageEl, 'offsetTop', { value: 100, configurable: true })
      await chips[0].trigger('click')
      expect(scrollTo).toHaveBeenCalledWith({ top: 84, behavior: 'smooth' })
      expect(wrapper.find('.overlay.flashing').exists()).toBe(true)

      vi.advanceTimersByTime(1800)
      await flushPromises()
      expect(wrapper.find('.overlay.flashing').exists()).toBe(false)
      useAppStore().activeTab = 'guide'
      await flushPromises()
      expect(status.find('[data-testid="overflow-bar"]').exists()).toBe(false)
      status.unmount()
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})


it('添加遗漏区域提供显式框选指引，Esc 取消', async () => {
  const { wrapper, store } = await readyWith([])
  store.proofreadMode = true
  await flushPromises()
  await wrapper.get('[data-testid="add-region"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('.frame-guide').text()).toContain('添加可编辑区域：')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(wrapper.find('.frame-guide').text()).not.toContain('添加可编辑区域：')
  await wrapper.get('.pdf-page').trigger('mousedown', { clientX: 5, clientY: 5, button: 0 })
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20 }))
  window.dispatchEvent(new MouseEvent('mouseup'))
  await flushPromises()
  expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
  wrapper.unmount()
})

describe('区域检查与补选任务', () => {
  async function workflow(items: DisplayRegion[] = []) {
    const result = await readyWith(items)
    ;(result.wrapper.get('.preview-scroll').element as HTMLElement).scrollTo = vi.fn()
    result.store.currentVersionId = 8
    const mode = vi.spyOn(result.store, 'toggleProofreadMode').mockImplementation(async on => {
      result.store.proofreadMode = on
      result.store.pdfData = new ArrayBuffer(on ? 9 : 10)
    })
    await flushPromises()
    return { ...result, mode }
  }
  async function draw(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.get('.pdf-page').trigger('mousedown', { clientX: 10, clientY: 20, button: 0 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 24, clientY: 34 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushPromises()
  }
  function action(wrapper: ReturnType<typeof mount>, text: string) {
    return wrapper.findAll('button').find(button => button.text() === text)!
  }

  it('检查入口直接进入任务，下一处定位并打开浮层，返回恢复内容版本、缩放与滚动', async () => {
    const { wrapper, store, mode } = await workflow([
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
    ])
    const confirm = vi.spyOn(store, 'confirmRegion')
    const container = wrapper.get('.preview-scroll').element as HTMLElement
    container.scrollTo = vi.fn()
    container.scrollTop = 85; container.scrollLeft = 12
    await wrapper.get('[aria-label="预览缩放"]').setValue('1.25'); await flushPromises()
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    expect(wrapper.get('.frame-guide').text()).toContain('检查可编辑区域')
    expect(wrapper.get('[data-testid=proofread-progress]').text()).toBe('已处理 0/1')
    await action(wrapper, '下一处待检查').trigger('click')
    expect(wrapper.get('[data-testid=proofread-popover]').text()).toContain('字段1')
    expect(confirm).not.toHaveBeenCalled()
    await wrapper.get('[data-testid=proofread-popover] .icon-btn').trigger('click')
    container.scrollTop = 150; container.scrollLeft = 30
    await wrapper.get('[aria-label="预览缩放"]').setValue('0.5'); await flushPromises()
    await wrapper.get('[data-testid=finish-region-review]').trigger('click'); await flushPromises()
    expect(mode.mock.calls.map(call => call[0])).toEqual([true, false])
    expect(store.currentVersionId).toBe(8)
    expect(wrapper.get('[aria-label="预览缩放"]').element).toHaveProperty('value', '1.25')
    expect(container.scrollTop).toBe(85); expect(container.scrollLeft).toBe(12)
    expect(wrapper.find('.frame-guide').exists()).toBe(false)
    wrapper.unmount()
  })

  it('默认名称避开已用序号，保存一次即返回文档，不追加重复确认', async () => {
    const { wrapper, store, mode } = await workflow([1, 3].map(id => ({
      ...region(id, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }), label: `补选区域${id}`,
    })))
    const create = vi.spyOn(store, 'createFrameRegion').mockResolvedValue({ ok: true, error: null })
    const confirm = vi.spyOn(store, 'confirmRegion')
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    expect(wrapper.get('[data-testid=region-name-input]').element).toHaveProperty('value', '补选区域2')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit'); await flushPromises()
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]?.slice(1)).toEqual(['补选区域2', 'custom'])
    expect(confirm).not.toHaveBeenCalled()
    expect(mode.mock.calls.map(call => call[0])).toEqual([true, false])
    expect(store.proofreadMode).toBe(false)
    expect(wrapper.get('.region-feedback').text()).toContain('已保存区域「补选区域2」')
    expect(store.currentVersionId).toBe(8)
    wrapper.unmount()
  })

  it('继续添加保持框选，下一次保存可直接返回文档', async () => {
    const { wrapper, store } = await workflow()
    const create = vi.spyOn(store, 'createFrameRegion').mockImplementation(async (_frame, label) => {
      store.regions = [...store.regions, {
        ...region(store.regions.length + 1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }), label, review_status: 'confirmed',
      }]
      return { ok: true, error: null }
    })
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    await action(wrapper, '保存并继续添加').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(true)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    expect(wrapper.get('.region-feedback').text()).toContain('可继续框选下一处')
    await draw(wrapper)
    expect(wrapper.get('[data-testid=region-name-input]').element).toHaveProperty('value', '补选区域2')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit'); await flushPromises()
    expect(create).toHaveBeenCalledTimes(2)
    expect(store.proofreadMode).toBe(false)
    wrapper.unmount()
  })

  it('补选失败可直接重新框选并保留名称与类型', async () => {
    const { wrapper, store } = await workflow()
    const create = vi.spyOn(store, 'createFrameRegion').mockResolvedValueOnce({ ok: false, error: '框选包含多个段落' })
      .mockResolvedValue({ ok: true, error: null })
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    await wrapper.get('[data-testid=region-name-input]').setValue('自定义经历')
    await wrapper.get('[data-testid=region-type-select]').setValue('work')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit'); await flushPromises()
    expect(store.proofreadMode).toBe(true)
    await wrapper.get('[data-testid=reframe-region]').trigger('click')
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    await draw(wrapper)
    expect(wrapper.get('[data-testid=region-name-input]').element).toHaveProperty('value', '自定义经历')
    expect(wrapper.get('[data-testid=region-type-select]').element).toHaveProperty('value', 'work')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit'); await flushPromises()
    expect(create.mock.calls.map(call => call.slice(1))).toEqual([
      ['自定义经历', 'work'], ['自定义经历', 'work'],
    ])
    expect(store.proofreadMode).toBe(false)
    wrapper.unmount()
  })

  it('从文档取消补选会返回文档，从检查任务取消只返回检查', async () => {
    const { wrapper, store } = await workflow()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await wrapper.get('[data-testid=cancel-region-task]').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(false)
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await wrapper.get('[data-testid=cancel-region-task]').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(true)
    expect(wrapper.get('.frame-guide').text()).toContain('检查可编辑区域')
    await draw(wrapper)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('返回失败仍保留文档位置，重试成功才结束检查', async () => {
    const { wrapper, store, mode } = await workflow()
    const container = wrapper.get('.preview-scroll').element as HTMLElement
    container.scrollTop = 85
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    container.scrollTop = 150
    mode.mockImplementationOnce(async () => { store.error = '无法返回文档'; store.proofreadMode = true })
    await wrapper.get('[data-testid=finish-region-review]').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(true)
    expect(wrapper.get('.error-banner').text()).toContain('无法返回文档')
    await wrapper.get('[data-testid=finish-region-review]').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(false)
    expect(container.scrollTop).toBe(85)
    wrapper.unmount()
  })

  it('模板加载期间不能完成检查或翻转预览模式', async () => {
    const { wrapper, store, mode } = await workflow()
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    store.status = 'loading'; await flushPromises()
    expect(wrapper.get('[data-testid=finish-region-review]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid=add-region]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid=finish-region-review]').trigger('click')
    expect(mode).toHaveBeenCalledTimes(1)
    expect(store.proofreadMode).toBe(true)
    wrapper.unmount()
  })

  it('旧的返回请求完成后不清除后来同模板的新返回位置', async () => {
    const { wrapper, store, mode } = await workflow()
    const container = wrapper.get('.preview-scroll').element as HTMLElement
    container.scrollTop = 85
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    let finish!: () => void
    mode.mockImplementationOnce(async () => {
      store.proofreadMode = false
      await new Promise<void>(resolve => { finish = resolve })
    })
    await wrapper.get('[data-testid=finish-region-review]').trigger('click')
    store.currentTemplateId = 2; store.currentTemplateId = 1
    await flushPromises()
    container.scrollTop = 220
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    finish(); await flushPromises()
    container.scrollTop = 300
    await wrapper.get('[data-testid=finish-region-review]').trigger('click'); await flushPromises()
    expect(store.proofreadMode).toBe(false)
    expect(container.scrollTop).toBe(220)
    wrapper.unmount()
  })

  it.each(['template', 'mode'])('同一 tick 的 %s 往返也隔离旧创建与新命名草稿', async context => {
    const { wrapper, store } = await workflow()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    let finish!: (result: { ok: boolean; error: string | null }) => void
    vi.spyOn(store, 'createFrameRegion').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await wrapper.get('[data-testid=region-name-input]').setValue('旧任务')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit')
    if (context === 'template') { store.currentTemplateId = 2; store.currentTemplateId = 1 }
    else { store.proofreadMode = false; store.proofreadMode = true }
    await flushPromises()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    await wrapper.get('[data-testid=region-name-input]').setValue('新的同模板任务')
    finish({ ok: true, error: null }); await flushPromises()
    expect(wrapper.get('[data-testid=region-name-input]').element).toHaveProperty('value', '新的同模板任务')
    expect(wrapper.get('[data-testid=region-name-dialog] button[type=submit]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('切回同模板可开始新的检查保存，旧请求结束不会解锁新请求', async () => {
    const { wrapper, store } = await workflow([
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
    ])
    const pending: ((result: { ok: boolean; error: string | null }) => void)[] = []
    vi.spyOn(store, 'confirmRegion').mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
    await wrapper.get('[data-testid=review-regions]').trigger('click'); await flushPromises()
    await action(wrapper, '下一处待检查').trigger('click')
    await wrapper.get('[data-testid=proofread-confirm]').trigger('click')
    store.currentTemplateId = 2; store.currentTemplateId = 1
    await flushPromises()
    await action(wrapper, '下一处待检查').trigger('click')
    await wrapper.get('[data-testid=proofread-confirm]').trigger('click')
    expect(pending).toHaveLength(2)
    pending[0]!({ ok: true, error: null }); await flushPromises()
    expect(wrapper.get('[data-testid=proofread-confirm]').attributes('disabled')).toBeDefined()
    pending[1]!({ ok: false, error: '新任务保存失败' }); await flushPromises()
    expect(wrapper.get('[data-testid=proofread-popover] [role=alert]').text()).toContain('新任务保存失败')
    expect(wrapper.get('[data-testid=proofread-confirm]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('区域框选与位置写入的交互保护', () => {
  async function draw(wrapper: ReturnType<typeof mount>, selector = '.pdf-page'): Promise<void> {
    await wrapper.get(selector).trigger('mousedown', { clientX: 10, clientY: 20, button: 0 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 24, clientY: 34 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await flushPromises()
  }
  it('等待模板请求及新画布全部完成，加载期间不可重入或在旧 PDF 框选', async () => {
    const { wrapper, store } = await readyWith([])
    let finishRequest!: () => void
    let finishCanvas!: () => void
    const toggle = vi.spyOn(store, 'toggleProofreadMode').mockImplementation(async () => {
      store.proofreadMode = true; store.refreshing = true
      await new Promise<void>(resolve => { finishRequest = resolve })
      store.pdfData = new ArrayBuffer(9); store.refreshing = false
    })
    renderSpy.mockImplementationOnce(() => new Promise<void>(resolve => { finishCanvas = resolve }))
    await wrapper.get('[data-testid=add-region]').trigger('click')
    await draw(wrapper)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=add-region]').exists()).toBe(false)
    expect(toggle).toHaveBeenCalledTimes(1)
    finishRequest(); await flushPromises()
    expect(wrapper.get('.frame-guide').text()).toContain('正在准备模板原文')
    await draw(wrapper)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    finishCanvas(); await flushPromises()
    await draw(wrapper)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('取消加载后旧请求完成不会重新进入框选', async () => {
    const { wrapper, store } = await readyWith([])
    let finish!: () => void
    vi.spyOn(store, 'toggleProofreadMode').mockImplementation(async on => {
      if (!on) { store.proofreadMode = false; store.refreshing = false; return }
      store.proofreadMode = true; store.refreshing = true
      await new Promise<void>(resolve => { finish = resolve })
      store.pdfData = new ArrayBuffer(9); store.refreshing = false
    })
    await wrapper.get('[data-testid=add-region]').trigger('click')
    await wrapper.get('[data-testid=cancel-region-task]').trigger('click')
    finish(); await flushPromises()
    await draw(wrapper)
    expect(wrapper.find('[data-testid=region-name-dialog]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('微调保存期间锁定拖动，失败保留矩形并可按相同身份重试', async () => {
    const { wrapper, store } = await readyWith([
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
    ])
    store.proofreadMode = true; await flushPromises()
    await wrapper.get('.overlay').trigger('click')
    await wrapper.get('[data-testid=proofread-adjust]').trigger('click')
    let finish!: (result: { ok: boolean; error: string | null }) => void
    const patch = vi.spyOn(store, 'adjustRegionBBox').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await draw(wrapper, '[data-testid=adjust-frame]')
    expect(wrapper.get('.frame-guide').text()).toContain('正在保存区域位置')
    await draw(wrapper, '[data-testid=adjust-frame]')
    expect(patch).toHaveBeenCalledTimes(1)
    finish({ ok: false, error: '位置保存失败，请重试' }); await flushPromises()
    expect(wrapper.get('.frame-guide [role=alert]').text()).toContain('位置保存失败')
    expect(wrapper.find('[data-testid=adjust-frame]').exists()).toBe(true)
    const first = patch.mock.calls[0]
    patch.mockResolvedValue({ ok: true, error: null })
    await wrapper.get('[data-testid=retry-region-position]').trigger('click')
    await flushPromises()
    expect(patch.mock.calls[1]).toEqual(first)
    expect(first[0]).toBe(1)
    expect(wrapper.find('[data-testid=adjust-frame]').exists()).toBe(false)
    expect(store.regions.map(item => item.id)).toEqual([1])
    wrapper.unmount()
  })
  it('重新定位失败保留任务，重试不会创建新的区域', async () => {
    const { wrapper, store } = await readyWith([region(7, null)])
    store.proofreadMode = true; await flushPromises()
    const create = vi.spyOn(store, 'createFrameRegion')
    const patch = vi.spyOn(store, 'adjustRegionBBox').mockResolvedValue({ ok: false, error: '位置范围不正确' })
    await wrapper.get('.unplaced-chip').trigger('click'); await flushPromises()
    await draw(wrapper)
    expect(wrapper.get('.frame-guide [role=alert]').text()).toContain('位置范围不正确')
    expect(wrapper.get('.frame-guide').text()).toContain('重新定位「字段7」')
    patch.mockResolvedValue({ ok: true, error: null })
    await wrapper.get('[data-testid=retry-region-position]').trigger('click'); await flushPromises()
    expect(patch.mock.calls.map(call => call[0])).toEqual([7, 7])
    expect(create).not.toHaveBeenCalled()
    expect(store.regions.map(item => item.id)).toEqual([7])
    wrapper.unmount()
  })
  it('区域创建防重复，旧模板请求完成不会清除新模板命名草稿', async () => {
    const { wrapper, store } = await readyWith([])
    store.proofreadMode = true; await flushPromises()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    let finish!: (result: { ok: boolean; error: string | null }) => void
    const create = vi.spyOn(store, 'createFrameRegion').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await wrapper.get('[data-testid=region-name-input]').setValue('旧任务')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit')
    await wrapper.get('[data-testid=region-name-dialog] form').trigger('submit')
    expect(create).toHaveBeenCalledTimes(1)
    store.currentTemplateId = 2; store.pdfData = new ArrayBuffer(10)
    await flushPromises()
    await wrapper.get('[data-testid=add-region]').trigger('click'); await flushPromises()
    await draw(wrapper)
    await wrapper.get('[data-testid=region-name-input]').setValue('新的命名草稿')
    finish({ ok: true, error: null }); await flushPromises()
    expect(wrapper.get('[data-testid=region-name-input]').element).toHaveProperty('value', '新的命名草稿')
    expect(wrapper.get('[data-testid=region-name-dialog] button[type=submit]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})


it('未定位项可直接重新框选并保留原区域身份', async () => {
  const { wrapper, store } = await readyWith([region(7, null)])
  store.proofreadMode = true
  await flushPromises()
  await wrapper.get('.unplaced-chip').trigger('click')
  await flushPromises()
  expect(wrapper.find('.frame-guide').text()).toContain('重新定位「字段7」')
  expect(store.regions.map(r => r.id)).toEqual([7])
  await wrapper.get('[data-testid=cancel-region-task]').trigger('click')
  await flushPromises()
  expect(wrapper.find('.frame-guide').text()).not.toContain('重新定位「字段7」')
  wrapper.unmount()
})


it('按当前页选择跨页片段，不使用另一页的首框坐标', async () => {
  const otherPage = { page: 1, x0: 400, y0: 400, x1: 500, y1: 450 }
  const thisPage = { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }
  const { wrapper } = await readyWith([region(9, { ...otherPage, fragments: [otherPage, thisPage] })])
  const overlay = wrapper.get('.overlay')
  expect(overlay.attributes('style')).toContain('left: 10px')
  expect(overlay.attributes('style')).toContain('top: 20px')
  expect(overlay.attributes('style')).toContain('width: 20px')
  wrapper.unmount()
})


describe('M15 标题着色和溢出显示', () => {
  it('新词表标题使用高置信候选和标题样式', async () => {
    const r = { ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
      label: '个人技能', placeholder: null, type: 'skills', confidence: 0.9 }
    const { wrapper, store } = await readyWith([r])
    store.proofreadMode = true
    await flushPromises()
    const overlay = wrapper.get('.overlay')
    expect(overlay.classes()).toContain('cand-high')
    expect(overlay.classes()).toContain('heading')
    expect(overlay.attributes('title')).toContain('标题候选：个人技能')
    wrapper.unmount()
  })
  it('真实小幅增高在区域与状态栏使用相同小数，裁剪仍保留警告', async () => {
    const binding = { block_id: 1, block_name: '块', status: 'active' as const }
    const ov = { orig_height: 20, new_height: 20.04, ratio: 0.002,
      level: 'small' as const, clipped: false, fixed_row: false }
    const { wrapper } = await readyWith([
      { ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }, binding, ov), confidence: 0.9, placeholder: null },
      region(2, { page: 0, x0: 1, y0: 5, x1: 3, y1: 7 }, binding,
        { ...ov, ratio: 0, level: 'large', clipped: true, fixed_row: true }),
    ])
    const status = mount(StatusBar, { global: { plugins: [getActivePinia()!] } })
    expect(wrapper.get('.overlay.overflow-small').attributes('title')).toContain('+0.2%')
    expect(status.get('.overflow-chip.small').text()).toContain('+0.2%')
    expect(status.get('.overflow-chip.large').text()).toContain('裁剪')
    expect(status.text()).not.toContain('+0%')
    status.unmount()
    wrapper.unmount()
  })
})


it('M24 两页绑定刷新只重画变化页；缩放后全部重画', async () => {
  const open = vi.mocked(openDocument)
  const oldImpl = open.getMockImplementation()
  const page = { ...fakePage }
  open.mockImplementation(async () => ({ document: { numPages: 2, getPage: vi.fn(async (i: number) => ({ ...page, pageNumber: i })) }, destroy: vi.fn() }) as never)
  try {
    const wrapper = mountPreview(), store = usePreviewStore()
    store.status = 'ready'
    store.pdfData = new ArrayBuffer(8)
    store.pageFingerprints = ['first', 'second']
    await flushPromises()
    expect(renderSpy).toHaveBeenCalledTimes(2)
    const canvases = wrapper.findAll('canvas').map(c => c.element)
    store.pageFingerprints = ['edited', 'second']
    store.pdfData = new ArrayBuffer(9)
    await flushPromises()
    expect(renderSpy).toHaveBeenCalledTimes(3)
    expect(wrapper.findAll('canvas').map(c => c.element)).toEqual(canvases)
    await wrapper.get('[aria-label="预览缩放"]').setValue('1')
    await flushPromises()
    expect(renderSpy).toHaveBeenCalledTimes(5)
    wrapper.unmount()
  } finally { if (oldImpl) open.mockImplementation(oldImpl) }
})


it('M24 在飞渲染取消后不能复用未完成画布', async () => {
  let release: (() => void) | undefined
  renderSpy.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const { wrapper, store } = await readyWith([])
  expect(renderSpy).toHaveBeenCalledTimes(1)
  store.regions = [region(3, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })]
  await flushPromises()
  expect(cancelSpy).toHaveBeenCalled()
  expect(renderSpy).toHaveBeenCalledTimes(2)
  release?.()
  await flushPromises()
  store.regions = []
  await flushPromises()
  expect(renderSpy).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})
