import { shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { LIBRARY_MAX_WIDTH, LIBRARY_MIN_WIDTH, useBlocksStore } from './stores/blocks'

vi.mock('./pdf/viewer', () => ({ openDocument: vi.fn(), preparePage: vi.fn() }))

beforeEach(() => localStorage.clear())
afterEach(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('M12 块库分隔条', () => {
  it('可 Tab 聚焦，左右键以 16px 调整并持久化，边界与 ARIA 同步', async () => {
    const wrapper = shallowMount(App, { global: { plugins: [createPinia()] } })
    const store = useBlocksStore()
    const separator = wrapper.get('[role="separator"]')
    expect(separator.attributes('tabindex')).toBe('0')
    expect(separator.attributes('aria-orientation')).toBe('vertical')
    store.setLibraryWidth(300)
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(store.libraryWidth).toBe(316)
    expect(separator.attributes('aria-valuenow')).toBe('316')
    expect(localStorage.getItem('blocks.libraryWidth')).toBe('316')
    await separator.trigger('keydown', { key: 'ArrowLeft' })
    expect(store.libraryWidth).toBe(300)
    store.setLibraryWidth(LIBRARY_MAX_WIDTH)
    await separator.trigger('keydown', { key: 'ArrowRight' })
    expect(store.libraryWidth).toBe(LIBRARY_MAX_WIDTH)
    store.setLibraryWidth(LIBRARY_MIN_WIDTH)
    await separator.trigger('keydown', { key: 'ArrowLeft' })
    expect(store.libraryWidth).toBe(LIBRARY_MIN_WIDTH)
    await separator.trigger('keydown', { key: 'ArrowUp' })
    expect(store.libraryWidth).toBe(LIBRARY_MIN_WIDTH)
    wrapper.unmount()
  })

  it('鼠标拖拽保留原行为，卸载时释放监听并还原原有 body 样式', async () => {
    const wrapper = shallowMount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
    const store = useBlocksStore()
    store.setLibraryWidth(300)
    document.body.style.cursor = 'default'
    await wrapper.get('.drawer-resizer').trigger('mousedown', { clientX: 300, button: 0 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 320 }))
    expect(store.libraryWidth).toBe(320)
    expect(document.body.style.cursor).toBe('col-resize')
    wrapper.unmount()
    expect(document.body.style.cursor).toBe('default')
    expect(document.body.style.userSelect).toBe('')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 350 }))
    expect(store.libraryWidth).toBe(320)
  })
})
