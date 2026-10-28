import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'
import type { DocumentTrial } from '../api/migrations'
import MigrationPreview from './MigrationPreview.vue'

vi.mock('../pdf/viewer', () => ({ openDocument: vi.fn(), preparePage: vi.fn() }))
const trial: DocumentTrial = { plan_token: 'p', pdf_base64: btoa('PDF'), pdf_sha256: 'sha', items: [
  { id: 1, label: '可放位置', bbox: { page: 0, x0: 10, y0: 20, x1: 50, y1: 40 }, review_status: 'confirmed', overflow: null },
  { id: 2, label: '未定位字段', bbox: null, review_status: 'pending', overflow: null },
  { id: 3, label: '排除字段', bbox: null, review_status: 'excluded', overflow: null },
] }
function pdf(): OpenedPdf {
  return { document: { numPages: 1, getPage: vi.fn(async () => ({ getViewport: () => ({ width: 612 }) })) }, destroy: vi.fn(async () => {}) } as unknown as OpenedPdf
}
function renderedPage(): RenderedPage {
  return { index: 0, width: 120, height: 160,
    viewport: { viewBox: [0, 0, 120, 160], convertToViewportPoint: (x: number, y: number) => [x, 160 - y] },
    render: vi.fn(async () => {}), cancel: vi.fn(),
  } as unknown as RenderedPage
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(openDocument).mockResolvedValue(pdf())
  vi.mocked(preparePage).mockReturnValue(renderedPage())
})
it('完成画布渲染后才开放同批位置，未定位可按名称放置，排除项隐藏', async () => {
  let finish!: () => void
  const page = renderedPage()
  page.render = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  vi.mocked(preparePage).mockReturnValue(page)
  const wrapper = mount(MigrationPreview, { props: { trial, occupied: {}, disabled: false } })
  await flushPromises()
  expect(wrapper.findAll('button')).toHaveLength(0)
  finish(); await flushPromises()
  expect(wrapper.findAll('button')).toHaveLength(2)
  expect(wrapper.text()).not.toContain('排除字段')
  await wrapper.find('.position').trigger('click')
  expect(wrapper.emitted('place')).toEqual([[1]])
  wrapper.unmount()
})
it('迟到的 PDF 加载不能恢复旧框或覆盖新画布', async () => {
  let finish!: (value: OpenedPdf) => void
  const oldPdf = pdf()
  vi.mocked(openDocument).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const wrapper = mount(MigrationPreview, { props: { trial, occupied: {}, disabled: false } })
  await flushPromises()
  await wrapper.setProps({ trial: { ...trial, pdf_sha256: 'new', items: [] } }); await flushPromises()
  finish(oldPdf); await flushPromises()
  expect(oldPdf.destroy).toHaveBeenCalledTimes(1)
  expect(wrapper.findAll('button')).toHaveLength(0)
  wrapper.unmount()
})
