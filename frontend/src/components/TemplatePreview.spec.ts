import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Region } from '../api/templates'
import { usePreviewStore } from '../stores/preview'
import TemplatePreview from './TemplatePreview.vue'

/** 假 PDF 页（612×792pt，rotation=0），与真实 pdfjs 行为对齐。 */
const fakePage = {
  getViewport: () => ({ width: 612, height: 792 }),
}

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
      render: vi.fn(async () => {}),
    })),
  }
})

function region(id: number, bbox: Region['bbox']): Region {
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

describe('TemplatePreview（M5a 只读预览）', () => {
  it('idle 态：提示选择模板', () => {
    const wrapper = mountPreview()
    expect(wrapper.text()).toContain('请在顶部选择模板开始预览')
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

  it('ready 态：渲染页容器 + 黄色覆盖层按 bbox 定位 + 未定位区域画虚线徽标', async () => {
    const wrapper = mountPreview()
    const store = usePreviewStore()
    store.status = 'ready'
    store.currentTemplateId = 1
    store.pdfData = new ArrayBuffer(8)
    store.regions = [
      region(1, { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }),
      region(2, null),
    ]
    await flushPromises()

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
    expect(overlay.attributes('title')).toBe('字段1')

    // 未定位（bbox=null）→ 虚线徽标列表
    const chip = wrapper.find('.unplaced-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('字段2')

    // 工具条图例统计
    expect(wrapper.find('.preview-toolbar').text()).toContain('待校对 1')
    expect(wrapper.find('.preview-toolbar').text()).toContain('未定位 1')
  })

  it('切回 idle（pdfData 置空）：清空页面渲染', async () => {
    const wrapper = mountPreview()
    const store = usePreviewStore()
    store.status = 'ready'
    store.pdfData = new ArrayBuffer(8)
    store.regions = [region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })]
    await flushPromises()
    expect(wrapper.find('.pdf-page').exists()).toBe(true)

    store.pdfData = null
    store.status = 'idle'
    await flushPromises()
    expect(wrapper.find('.pdf-page').exists()).toBe(false)
    expect(wrapper.text()).toContain('请在顶部选择模板开始预览')
  })
})
