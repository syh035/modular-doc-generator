import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/app'
import StatusBar from './StatusBar.vue'

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** stub /api/health（app store 探测）。 */
function stubHealth(ok: boolean, libreofficeAvailable = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      if (ok) {
        return Promise.resolve(
          Response.json({
            status: 'ok',
            libreoffice: {
              available: libreofficeAvailable,
              path: null,
              version: null,
              hint: libreofficeAvailable ? null : '未安装',
            },
          }),
        )
      }
      return Promise.reject(new Error('连接失败'))
    }),
  )
}

/** 挂载 StatusBar 并保证测试与组件共用同一 pinia 实例。 */
function mountStatusBar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(StatusBar, { global: { plugins: [pinia] } })
}

describe('StatusBar 健康指示（2026-09-18 自 TopBar 右上角迁入左下角）', () => {
  it('探测成功：绿点 + 服务正常', async () => {
    stubHealth(true)
    const wrapper = mountStatusBar()
    const appStore = useAppStore()
    await appStore.refreshHealth()
    await flushPromises()
    expect(wrapper.find('.health .dot').classes()).not.toContain('bad')
    expect(wrapper.text()).toContain('服务正常')
  })

  it('探测失败：红点 + 错误文字', async () => {
    stubHealth(false)
    const wrapper = mountStatusBar()
    const appStore = useAppStore()
    await appStore.refreshHealth()
    await flushPromises()
    expect(wrapper.find('.health.bad .dot').exists()).toBe(true)
    expect(wrapper.find('.health').classes()).toContain('bad')
  })

  it('LibreOffice 未安装时状态条内给出警告', async () => {
    stubHealth(true, false)
    const wrapper = mountStatusBar()
    const appStore = useAppStore()
    await appStore.refreshHealth()
    await flushPromises()
    expect(wrapper.text()).toContain('LibreOffice 未安装')
  })
})
