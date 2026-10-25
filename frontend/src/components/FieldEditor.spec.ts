import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import { useBlocksStore } from '../stores/blocks'
import FieldEditor from './FieldEditor.vue'
const asset = { id: 9, name: '经验素材', content: '共享文字', tags: [{ id: 1, name: '项目' }], created_at: '', updated_at: '' }
function region(extra: Partial<DisplayRegion> = {}): DisplayRegion {
  return { id: 1, template_id: 1, label: '经历', type: 'custom', placeholder: null,
    current_text: '原文', anchor: { kind: 'p', path: [0] }, bbox: null, order_index: 0,
    confidence: null, review_status: 'confirmed', created_at: '', updated_at: '', binding: null, overflow: null, ...extra }
}
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => {
  setActivePinia(createPinia())
  const preview = usePreviewStore(); preview.currentTemplateId = 1; preview.currentVersionId = 7; preview.status = 'ready'
  vi.spyOn(preview, 'refreshVersionRender').mockResolvedValue()
  const blocks = useBlocksStore(); blocks.blocks = [asset]; vi.spyOn(blocks, 'loadBlocks').mockResolvedValue()
  fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/references')
    ? { token: 'snapshot', fields: [{ kind: 'region', version_id: 7, id: 1, document_name: '当前稿', template_name: '模板', label: '经历' }] }
    : { id: 42 }))
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function button(wrapper: ReturnType<typeof mount>, text: string) { return wrapper.findAll('button').find(b => b.text() === text)! }
it('选用素材与设定素材位于同一侧栏，返回保留未保存文字，按名称正文标签搜索', async () => {
  const wrapper = mount(FieldEditor, { props: { region: region() } })
  expect(wrapper.find('dialog').exists()).toBe(false)
  expect(wrapper.findAll('.material-actions button').slice(0, 2).map(b => b.text())).toEqual(['设定为素材', '选用素材'])
  await wrapper.get('textarea').setValue('未保存的编辑')
  await button(wrapper, '选用素材').trigger('click')
  await wrapper.get('[aria-label="搜索素材"]').setValue('项目')
  expect(wrapper.get('.material-item').text()).toContain('共享文字')
  await button(wrapper, '返回编辑（保留未保存文字）').trigger('click')
  expect(wrapper.get('textarea').element).toHaveProperty('value', '未保存的编辑')
  wrapper.unmount()
})
it('默认只编辑当前字段，携带原文冲突校验及换行方式', async () => {
  const wrapper = mount(FieldEditor, { props: { region: region() } })
  await wrapper.get('textarea').setValue('独立文字')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(fetcher).toHaveBeenCalledWith('/api/versions/7/regions/1/text', expect.objectContaining({ body: JSON.stringify({ content: '独立文字', sync_block: false, expected_content: '原文', line_break_mode: 'paragraph' }) }))
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})
it('写入成功而预览失败时仅重试刷新，不能再创建素材', async () => {
  vi.spyOn(usePreviewStore(), 'refreshVersionRender').mockImplementation(async () => { usePreviewStore().error = '转换失败' })
  const wrapper = mount(FieldEditor, { props: { region: region() } })
  await wrapper.get('select').setValue('soft')
  await button(wrapper, '设定为素材').trigger('click')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).line_break_mode).toBe('soft')
  expect(wrapper.get('[role="alert"]').text()).toContain('修改已保存')
  expect(fetcher).toHaveBeenCalledTimes(1)
  vi.spyOn(usePreviewStore(), 'refreshVersionRender').mockImplementation(async () => { usePreviewStore().error = null })
  await button(wrapper, '仅重试刷新预览').trigger('click'); await flushPromises()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(wrapper.emitted('close')).toHaveLength(1)
  wrapper.unmount()
})
it('插入行使用独立接口，允许编辑为空并能在其上下插入', async () => {
  const wrapper = mount(FieldEditor, { props: { region: region({ id: -23, field_ref: { kind: 'insertion', id: 23 } }) } })
  await wrapper.get('textarea').setValue('')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/versions/7/insertions/23')
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toMatchObject({ content: '', expected_content: '原文' })
  wrapper.unmount()
  const fresh = mount(FieldEditor, { props: { region: region({ id: -23, field_ref: { kind: 'insertion', id: 23 } }) } })
  await button(fresh, '上方插入空行').trigger('click'); await flushPromises()
  expect(JSON.parse(fetcher.mock.lastCall?.[1].body)).toEqual({ kind: 'insertion', id: 23, side: 'before' })
  expect(fresh.emitted('select')).toEqual([[-42]])
  fresh.unmount()
})
it('共享更新默认不选任何引用，勾选后按明确字段提交', async () => {
  const wrapper = mount(FieldEditor, { props: { region: region({ binding: { block_id: 9, block_name: '素材', status: 'active', is_material: true } }) } })
  await wrapper.get('textarea').setValue('更新素材文字')
  await wrapper.get('.check input').setValue(true); await flushPromises()
  const option = wrapper.get('.material-scope input')
  expect((option.element as HTMLInputElement).checked).toBe(false)
  await option.setValue(true)
  await wrapper.get('form').trigger('submit'); await flushPromises()
  const write = fetcher.mock.calls.find(call => String(call[0]).endsWith('/scoped'))!
  expect(JSON.parse(write[1].body)).toEqual({ action: 'update', content: '更新素材文字', token: 'snapshot', selected: [{ kind: 'region', version_id: 7, id: 1 }] })
  wrapper.unmount()
})
