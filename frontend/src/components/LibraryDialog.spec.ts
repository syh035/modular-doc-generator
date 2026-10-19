import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreviewStore } from '../stores/preview'
import LibraryDialog from './LibraryDialog.vue'

vi.mock('./ArchivePreview.vue', () => ({ default: { template: '<div>只读 PDF</div>' } }))
vi.mock('./DataMaintenance.vue', () => ({ default: { template: '<div />' } }))
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals() })
describe('冻结归档', () => {
  it('无版本时禁止冻结，已有归档仍可查看下载', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ archives: [
      { id: 7, name: '定稿', template_name: '模板', version_name: '版本', created_at: '2026-10-17T00:00:00Z' },
    ] }))))
    const wrapper = mount(LibraryDialog)
    await flushPromises()
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('a[download]').attributes('href')).toBe('/api/archives/7/docx')
    wrapper.unmount()
  })
  it('大超出须明确确认，成功后显示只读归档', async () => {
    usePreviewStore().currentVersionId = 3
    const archive = { id: 1, name: '定稿', template_name: '模板', version_name: '版本', created_at: '2026-10-17T00:00:00Z' }
    let saved = false
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/archives') return new Response(JSON.stringify({ archives: saved ? [archive] : [] }))
      const body = JSON.parse(String(options?.body))
      if (!body.confirm_large_overflow) return new Response(JSON.stringify({ error: { code: 'EXPORT_LARGE_OVERFLOW', message: '存在大超出' } }), { status: 409 })
      saved = true
      return new Response(JSON.stringify(archive), { status: 201 })
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(LibraryDialog)
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('存在大超出')
    await wrapper.get('input[type=checkbox]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('已冻结归档')
    expect(wrapper.text()).toContain('只读 PDF')
    wrapper.unmount()
  })
})
