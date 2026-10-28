import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore } from '../stores/preview'
import ArchiveDialog from './ArchiveDialog.vue'

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals() })
describe('归档当前稿件', () => {
  it('未选择稿件时不能归档', () => {
    const wrapper = mount(ArchiveDialog)
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('大超出须明确确认，成功后通知归档库打开新资料', async () => {
    usePreviewStore().currentVersionId = 3
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toBe('/api/versions/3/archives')
      const body = JSON.parse(String(options?.body))
      if (!body.confirm_large_overflow) return Response.json({ error: { code: 'EXPORT_LARGE_OVERFLOW', message: '存在大超出' } }, { status: 409 })
      return Response.json({ id: 7, name: body.name }, { status: 201 })
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(ArchiveDialog)
    await wrapper.get('[aria-label=归档名称]').setValue('  投递定稿  ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('存在大超出')
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('saved')).toBeUndefined()
    await wrapper.get('input[type=checkbox]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('saved')).toEqual([[7]])
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)).name).toBe('投递定稿')
    wrapper.unmount()
  })
  it('处理中不能重复提交或关闭，失败后保留名称供重试', async () => {
    usePreviewStore().currentVersionId = 3
    let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(ArchiveDialog)
    await wrapper.get('[aria-label=归档名称]').setValue('保留名称')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('[aria-label=关闭归档]').trigger('click')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(wrapper.emitted('close')).toBeUndefined()
    finish(Response.json({ error: { code: 'CONVERSION_FAILED', message: '转换失败，请重试' } }, { status: 500 }))
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('转换失败')
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('保留名称')
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})
