import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'
import { LIBRARY_MAX_WIDTH, LIBRARY_MIN_WIDTH, useBlocksStore } from './stores/blocks'
import { useAppStore } from './stores/app'
import { usePreviewStore } from './stores/preview'

vi.mock('./pdf/viewer', () => ({ openDocument: vi.fn(), preparePage: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

function editingPinia() {
  const pinia = createPinia()
  useAppStore(pinia).setTab('workbench')
  return pinia
}

it('首页展示文稿列表，返回列表保留编辑器，窄屏抽屉不会覆盖列表', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const wrapper = shallowMount(App, { global: { plugins: [createPinia()] }, attachTo: document.body })
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent({ name: 'DocumentList' }).exists()).toBe(true)
  expect(wrapper.findComponent({ name: 'TemplatePreview' }).exists()).toBe(false)
  const app = useAppStore()
  app.setTab('workbench')
  await wrapper.vm.$nextTick()
  const editor = wrapper.getComponent({ name: 'TemplatePreview' }).element
  expect(wrapper.findComponent({ name: 'BlockDrawer' }).exists()).toBe(true)
  for (const page of ['documents', 'templates', 'materials', 'archives', 'guide'] as const) {
    app.setTab(page)
    await wrapper.vm.$nextTick()
    expect(wrapper.getComponent({ name: 'TemplatePreview' }).element).toBe(editor)
    expect(wrapper.get('.main-columns').isVisible()).toBe(false)
    expect(wrapper.findComponent({ name: 'BlockDrawer' }).exists()).toBe(false)
    if (page === 'templates') expect(wrapper.getComponent({ name: 'TemplateManager' }).props('embedded')).toBe(true)
    if (page === 'materials') expect(wrapper.get('.materials-page').findComponent({ name: 'BlockLibrary' }).props('standalone')).toBe(true)
    if (page === 'archives') expect(wrapper.getComponent({ name: 'LibraryDialog' }).props('embedded')).toBe(true)
  }
  app.setTab('workbench')
  await wrapper.vm.$nextTick()
  expect(wrapper.getComponent({ name: 'TemplatePreview' }).element).toBe(editor)
  expect(wrapper.get('.main-columns').isVisible()).toBe(true)
  wrapper.unmount()
})

it('模板页显式打开指定稿，离开页面后旧结果不抢回编辑器', async () => {
  const wrapper = shallowMount(App, { global: { plugins: [createPinia()] } })
  const app = useAppStore(), preview = usePreviewStore()
  app.setTab('templates')
  await wrapper.vm.$nextTick()
  let complete!: () => void
  const select = vi.spyOn(preview, 'selectTemplate').mockImplementation(async (id, options) => {
    await new Promise<void>(resolve => { complete = resolve })
    preview.currentTemplateId = id; preview.currentVersionId = options?.versionId ?? null; preview.status = 'ready'
  })
  wrapper.getComponent({ name: 'TemplateManager' }).vm.$emit('use', 2, 23)
  app.setTab('guide')
  complete()
  await flushPromises()
  expect(select).toHaveBeenCalledWith(2, { versionId: 23 })
  expect(app.activeTab).toBe('guide')
  wrapper.unmount()
})

it('模板页再次编辑当前稿直接返回现有编辑器，不重复转换或清空编辑状态', async () => {
  const wrapper = shallowMount(App, { global: { plugins: [editingPinia()] } })
  const app = useAppStore(), preview = usePreviewStore()
  preview.currentTemplateId = 2; preview.currentVersionId = 23; preview.status = 'ready'
  const select = vi.spyOn(preview, 'selectTemplate')
  const editor = wrapper.getComponent({ name: 'TemplatePreview' }).element
  app.setTab('templates')
  await wrapper.vm.$nextTick()
  wrapper.getComponent({ name: 'TemplateManager' }).vm.$emit('use', 2, 23)
  await flushPromises()
  expect(select).not.toHaveBeenCalled()
  expect(app.activeTab).toBe('workbench')
  expect(wrapper.getComponent({ name: 'TemplatePreview' }).element).toBe(editor)
  wrapper.unmount()
})

it('归档打开当前来源复用编辑器，来源预览失败留在归档页供重试', async () => {
  const wrapper = shallowMount(App, { global: { plugins: [editingPinia()] } })
  const app = useAppStore(), preview = usePreviewStore()
  preview.currentTemplateId = 2; preview.currentVersionId = 23; preview.status = 'ready'
  const select = vi.spyOn(preview, 'selectTemplate')
  app.openArchives()
  await wrapper.vm.$nextTick()
  wrapper.getComponent({ name: 'LibraryDialog' }).vm.$emit('open-source', 2, 23)
  await flushPromises()
  expect(select).not.toHaveBeenCalled()
  expect(app.activeTab).toBe('workbench')
  app.openArchives()
  await wrapper.vm.$nextTick()
  select.mockImplementation(async () => { preview.status = 'error'; preview.error = '来源未能打开' })
  wrapper.getComponent({ name: 'LibraryDialog' }).vm.$emit('open-source', 3, 30)
  await flushPromises()
  expect(select).toHaveBeenCalledWith(3, { versionId: 30 })
  expect(app.activeTab).toBe('archives')
  expect(wrapper.get('[role=alert]').text()).toBe('来源未能打开')
  wrapper.unmount()
})

it('模板页打开失败显示错误并归还发起按钮焦点，允许原位重试', async () => {
  const wrapper = shallowMount(App, {
    attachTo: document.body,
    global: { plugins: [createPinia()], stubs: {
      TemplateManager: { name: 'TemplateManager', emits: ['use'], template: '<button @click="$emit(\'use\', 2, 23)">编辑文稿</button>' },
    } },
  })
  const app = useAppStore(), preview = usePreviewStore()
  app.setTab('templates')
  await wrapper.vm.$nextTick()
  vi.spyOn(preview, 'selectTemplate').mockImplementation(async () => { preview.status = 'error'; preview.error = '无法打开' })
  const opener = wrapper.getComponent({ name: 'TemplateManager' }).get('button')
  ;(opener.element as HTMLButtonElement).focus()
  await opener.trigger('click')
  await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toBe('无法打开')
  expect(document.activeElement).toBe(opener.element)
  expect(app.activeTab).toBe('templates')
  wrapper.unmount()
})

describe('M12 块库分隔条', () => {
  it('窄屏使用模态抽屉，选块或关闭后归还完整预览宽度', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const wrapper = shallowMount(App, { global: { plugins: [editingPinia()] } })
    await wrapper.vm.$nextTick()
    expect(wrapper.findComponent({ name: 'BlockDrawer' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'BlockLibrary' }).exists()).toBe(false)
    wrapper.findComponent({ name: 'BlockDrawer' }).vm.$emit('close')
    await wrapper.vm.$nextTick()
    expect(useBlocksStore().libraryOpen).toBe(false)
    expect(wrapper.findComponent({ name: 'BlockDrawer' }).exists()).toBe(false)
    wrapper.unmount()
  })
  it('可 Tab 聚焦，左右键以 16px 调整并持久化，边界与 ARIA 同步', async () => {
    const wrapper = shallowMount(App, { global: { plugins: [editingPinia()] } })
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
    const wrapper = shallowMount(App, { global: { plugins: [editingPinia()] }, attachTo: document.body })
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
