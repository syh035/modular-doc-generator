import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DataMaintenance from './DataMaintenance.vue'

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => vi.unstubAllGlobals())
it('备份验证失败时不给出替换入口，错误可见', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/backups')) return new Response(JSON.stringify({ backups: [] }))
    if (url.endsWith('/cache')) return new Response(JSON.stringify({ bytes: 0, files: 0 }))
    return new Response(JSON.stringify({ error: { code: 'BACKUP_INVALID', message: '备份校验失败' } }), { status: 400 })
  }))
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  const input = wrapper.get('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: [new File(['bad'], 'bad.zip')] })
  await input.trigger('change'); await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toContain('备份校验失败')
  expect(wrapper.find('input[type=checkbox]').exists()).toBe(false)
  wrapper.unmount()
})
it('先展示备份内容，再要求显式替换确认', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/backups')) return new Response(JSON.stringify({ backups: [] }))
    if (url.endsWith('/cache')) return new Response(JSON.stringify({ bytes: 0, files: 0 }))
    return new Response(JSON.stringify({ sha256: 'digest', counts: { templates: 2, versions: 3, blocks: 4, archives: 5 } }))
  }))
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  const input = wrapper.get('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: [new File(['backup'], 'backup.zip')] })
  await input.trigger('change'); await flushPromises()
  expect(wrapper.text()).toContain('2 个模板、3 个版本、4 个字符块、5 份归档')
  const restore = wrapper.findAll('button').find(button => button.text() === '恢复备份')!
  expect(restore.attributes('disabled')).toBeDefined()
  await wrapper.get('input[type=checkbox]').setValue(true)
  expect(restore.attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('无文档时清理缓存提示下次生成，不宣称已重新预览', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/backups')
    ? { backups: [] } : { bytes: 0, files: 0 })))
  const wrapper = mount(DataMaintenance)
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '清理缓存并重新预览')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('下次打开文档时会重新生成预览')
  wrapper.unmount()
})
