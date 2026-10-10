import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { DisplayRegion } from '../stores/preview'
import RegionTextEditor from './RegionTextEditor.vue'
const region: DisplayRegion = {
  id: 1, template_id: 1, type: 'custom', label: '原段落', placeholder: null,
  anchor: { kind: 'p', path: [0] }, order_index: 0, bbox: null, confidence: 0.4,
  review_status: 'pending', created_at: '', updated_at: '', current_text: '原文字', binding: null,
}
function editor(bound = false) {
  return mount(RegionTextEditor, { props: { region: { ...region,
    binding: bound ? { block_id: 1, block_name: '共享块', status: 'active' } : null },
    submitting: false, error: null } })
}
describe('版本文字编辑', () => {
  it('显示已有文字，空白和未修改无法提交；默认只改当前版本', async () => {
    const w = editor()
    expect(w.get('textarea').element.value).toBe('原文字')
    expect(w.get('button[type=submit]').attributes('disabled')).toBeDefined()
    await w.get('textarea').setValue('  ')
    expect(w.get('button[type=submit]').attributes('disabled')).toBeDefined()
    await w.get('textarea').setValue('微调文字')
    await w.get('form').trigger('submit')
    expect(w.emitted('save')).toEqual([['微调文字', false]])
    expect(w.find('input[type=checkbox]').exists()).toBe(false)
    w.unmount()
  })
  it('同步共享块必须主动选择，并显示所有版本影响', async () => {
    const w = editor(true)
    expect(w.get('input').element.checked).toBe(false)
    await w.get('input').setValue(true)
    expect(w.text()).toContain('所有引用该字符块的版本')
    await w.get('textarea').setValue('共享新文字')
    await w.get('form').trigger('submit')
    expect(w.emitted('save')).toEqual([['共享新文字', true]])
    w.unmount()
  })
  it('提交期间锁定表单和关闭，保存失败保留输入', async () => {
    const w = editor()
    await w.get('textarea').setValue('待保存')
    await w.setProps({ submitting: true })
    await w.get('form').trigger('submit')
    await w.get('[aria-label=关闭文字编辑]').trigger('click')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.emitted('close')).toBeUndefined()
    await w.setProps({ submitting: false, error: '内容已发生变化' })
    expect(w.get('[role=alert]').text()).toBe('内容已发生变化')
    expect(w.get('textarea').element.value).toBe('待保存')
    w.unmount()
  })
  it('删除明确作用于整个版本段落，提交期间锁定', async () => {
    const w = editor()
    const button = w.findAll('button').find(b => b.text() === '删除本版本段落')!
    await button.trigger('click')
    expect(w.emitted('remove')).toEqual([[]])
    expect(w.text()).toContain('同段的其他区域也会一并隐藏')
    await w.setProps({ submitting: true })
    expect(button.attributes('disabled')).toBeDefined()
    w.unmount()
  })

})
