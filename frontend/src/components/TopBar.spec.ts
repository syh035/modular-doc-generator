import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/app'
import TopBar from './TopBar.vue'

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** stub /api/health（TopBar 挂载即探测）。 */
function stubHealth(ok: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      if (ok) {
        return Promise.resolve(
          Response.json({
            status: 'ok',
            libreoffice: { available: true, path: null, version: null, hint: null },
          }),
        )
      }
      return Promise.reject(new Error('连接失败'))
    }),
  )
}

/** 挂载 TopBar 并保证测试与组件共用同一 pinia 实例。 */
function mountTopBar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(TopBar, { global: { plugins: [pinia] } })
}

describe('TopBar tab 导航（UI 调整①）', () => {
  it('渲染两个 tab，默认工作台激活', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const tabs = wrapper.findAll('.tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].text()).toBe('工作台')
    expect(tabs[1].text()).toBe('模板制作指南')
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
  })

  it('点击 tab 切换 appStore.activeTab', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const appStore = useAppStore()
    expect(appStore.activeTab).toBe('workbench')

    await wrapper.findAll('.tab')[1].trigger('click')
    expect(appStore.activeTab).toBe('guide')
    expect(wrapper.findAll('.tab')[1].classes()).toContain('active')

    await wrapper.findAll('.tab')[0].trigger('click')
    expect(appStore.activeTab).toBe('workbench')
  })

  it('导入/导出按钮为占位禁用（M8 前不动）', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const buttons = wrapper.findAll('.actions button')
    expect(buttons.map(b => b.text())).toEqual(['导入模板', '导出 DOCX'])
    for (const b of buttons) {
      expect(b.attributes('disabled')).toBeDefined()
    }
  })
})

describe('TopBar 健康指示', () => {
  it('探测成功：绿点（ok）', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    await flushPromises()
    expect(wrapper.find('.health-dot.ok').exists()).toBe(true)
  })

  it('探测失败：红点（bad）', async () => {
    stubHealth(false)
    const wrapper = mountTopBar()
    await flushPromises()
    expect(wrapper.find('.health-dot.bad').exists()).toBe(true)
  })
})
