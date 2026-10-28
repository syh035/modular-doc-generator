import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DataMaintenance from './DataMaintenance.vue'
import { usePreviewStore } from '../stores/preview'

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => vi.unstubAllGlobals())
it('只查询缓存状态，维护弹层不再提供备份或恢复入口', async () => {
  const fetch = vi.fn(async () => Response.json({ bytes: 1048576, files: 3 }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  expect(wrapper.get('dialog').attributes('aria-label')).toBe('预览维护')
  expect(wrapper.text()).toContain('3 份缓存，占用 1.0 MB')
  expect(wrapper.text()).not.toMatch(/备份|恢复/)
  expect(wrapper.find('input').exists()).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('/api/maintenance/cache', undefined)
  wrapper.unmount()
})
it('清理缓存失败时显示错误，不给出成功提示', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ error: { code: 'CACHE_FAILED', message: '缓存正在使用，请稍后重试' } }, { status: 500 })
    : Response.json({ bytes: 0, files: 0 })))
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '清理缓存并重新预览')!.trigger('click')
  await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toContain('缓存正在使用，请稍后重试')
  expect(wrapper.find('[role=status]').exists()).toBe(false)
  wrapper.unmount()
})

it('无文档时清理缓存提示下次生成，不宣称已重新预览', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ bytes: 0, files: 0 })))
  usePreviewStore().error = '之前的文档读取失败'
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '清理缓存并重新预览')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('下次打开文档时会重新生成预览')
  expect(wrapper.find('[role=alert]').exists()).toBe(false)
  wrapper.unmount()
})

it('当前预览重新生成后再报告成功', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ bytes: 0, files: 0 })))
  const preview = usePreviewStore()
  preview.status = 'ready'; preview.currentTemplateId = 1
  const refresh = vi.spyOn(preview, 'refreshVersionRender').mockResolvedValue()
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '清理缓存并重新预览')!.trigger('click')
  await flushPromises()
  expect(refresh).toHaveBeenCalledOnce()
  expect(wrapper.text()).toContain('当前预览已重新生成')
  wrapper.unmount()
})

it('清理进行中禁止关闭，完成后恢复关闭和 Esc 操作', async () => {
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE'
    ? new Promise<Response>(resolve => { finish = resolve })
    : Response.json({ bytes: 0, files: 0 })))
  const wrapper = mount(DataMaintenance, { attachTo: document.body })
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '清理缓存并重新预览')!.trigger('click')
  expect(wrapper.get('[aria-label="关闭预览维护"]').attributes('disabled')).toBeDefined()
  await wrapper.get('dialog').trigger('click')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await wrapper.get('dialog').trigger('cancel')
  expect(wrapper.emitted('close')).toBeUndefined()
  finish(Response.json({ bytes: 0, files: 0 }))
  await flushPromises()
  expect(wrapper.get('[aria-label="关闭预览维护"]').attributes('disabled')).toBeUndefined()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})
