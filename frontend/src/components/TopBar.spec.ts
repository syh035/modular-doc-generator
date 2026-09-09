import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore } from '../stores/preview'
import TopBar from './TopBar.vue'

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** 挂载 TopBar 并保证测试与组件共用同一 pinia 实例。 */
function mountTopBar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(TopBar, { global: { plugins: [pinia] } })
}

describe('TopBar 模板选择器（M5a）', () => {
  it('挂载即加载模板列表并渲染下拉项', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/templates') {
          return Promise.resolve(
            Response.json({
              templates: [
                { id: 1, filename: '简历模板A.docx', regions_count: 3 },
                { id: 2, filename: '简历模板B.docx', regions_count: 0 },
              ],
            }),
          )
        }
        if (url === '/api/health') {
          return Promise.resolve(
            Response.json({ status: 'ok', libreoffice: { available: true, path: null, version: null, hint: null } }),
          )
        }
        return Promise.resolve(Response.json({}, { status: 404 }))
      }),
    )
    const wrapper = mountTopBar()
    await flushPromises()
    const options = wrapper.findAll('.template-select option')
    expect(options).toHaveLength(3) // 占位项 + 2 模板
    expect(options[1].text()).toBe('简历模板A.docx')
    expect(options[2].text()).toBe('简历模板B.docx')
  })

  it('选择模板触发 store.selectTemplate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/templates') {
        return Promise.resolve(Response.json({ templates: [{ id: 7, filename: '模板七.docx', regions_count: 1 }] }))
      }
      return Promise.resolve(Response.json({ status: 'ok', libreoffice: { available: true, path: null, version: null, hint: null } }))
    }))
    const wrapper = mountTopBar()
    await flushPromises()
    const store = usePreviewStore()
    const spy = vi.spyOn(store, 'selectTemplate').mockResolvedValue(undefined)
    const select = wrapper.find('.template-select')
    await select.setValue('7')
    expect(spy).toHaveBeenCalledWith(7)
  })

  it('列表为空时下拉禁用并显示（暂无模板）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/templates') {
        return Promise.resolve(Response.json({ templates: [] }))
      }
      return Promise.resolve(Response.json({ status: 'ok', libreoffice: { available: true, path: null, version: null, hint: null } }))
    }))
    const wrapper = mountTopBar()
    await flushPromises()
    const select = wrapper.find('.template-select')
    expect((select.element as HTMLSelectElement).disabled).toBe(true)
    expect(select.text()).toContain('（暂无模板）')
  })
})
