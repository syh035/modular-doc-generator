import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import BlockDrawer from './BlockDrawer.vue'
import { usePreviewStore } from '../stores/preview'

beforeEach(() => {
  setActivePinia(createPinia())
  usePreviewStore().currentTemplateId = 1
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/tags'
    ? { tags: [] } : { blocks: [] })))
})
afterEach(() => vi.unstubAllGlobals())

it('窄屏只保留一层标题，菜单先处理 Esc，再次 Esc 才退出抽屉', async () => {
  const wrapper = mount(BlockDrawer, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.findAll('.header')).toHaveLength(1)
  expect(wrapper.text()).not.toContain('选择内容块后，点击文档区域绑定')
  expect(wrapper.find('[aria-label="+ 新建素材"]').exists()).toBe(true)
  const menu = wrapper.get<HTMLDetailsElement>('.library-actions')
  menu.element.open = true
  ;(menu.get('summary').element as HTMLElement).focus()
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(menu.element.open).toBe(false)
  expect(wrapper.emitted('close')).toBeUndefined()
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})

it('标题中的关闭按钮保留明确的可访问名称', async () => {
  const wrapper = mount(BlockDrawer)
  await flushPromises()
  await wrapper.get('[aria-label="关闭块库"]').trigger('click')
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})
