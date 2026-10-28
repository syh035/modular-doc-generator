import { mount } from '@vue/test-utils'
import { afterEach, expect, it } from 'vitest'
import RegionNameDialog from './RegionNameDialog.vue'

const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it('提交中锁定输入、取消、关闭、Esc 和原生取消，防重复提交', async () => {
  const wrapper = mount(RegionNameDialog, { attachTo: document.body, props: { error: null, submitting: false } })
  wrappers.push(wrapper)
  await wrapper.get('input').setValue('工作经历')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('submit')).toEqual([['工作经历', 'custom', false]])
  await wrapper.setProps({ submitting: true })
  expect(wrapper.findAll('input, select, button').every(control => control.attributes('disabled') !== undefined)).toBe(true)
  await wrapper.get('form').trigger('submit')
  await wrapper.get('dialog').trigger('click')
  await wrapper.get('dialog').trigger('cancel')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(wrapper.emitted('submit')).toHaveLength(1)
  expect(wrapper.emitted('close')).toBeUndefined()
  await wrapper.setProps({ submitting: false })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(wrapper.emitted('close')).toHaveLength(1)
})

it('重新框选传回填写内容，保存期间禁止重新框选', async () => {
  const wrapper = mount(RegionNameDialog, { props: { error: '框选跨越多段', submitting: false, initialName: '已填名称', initialType: 'work' } })
  wrappers.push(wrapper)
  await wrapper.get('[data-testid=reframe-region]').trigger('click')
  expect(wrapper.emitted('reframe')).toEqual([['已填名称', 'work']])
  await wrapper.setProps({ submitting: true })
  expect(wrapper.get('[data-testid=reframe-region]').attributes('disabled')).toBeDefined()
  await wrapper.get('[data-testid=reframe-region]').trigger('click')
  expect(wrapper.emitted('reframe')).toHaveLength(1)
})
