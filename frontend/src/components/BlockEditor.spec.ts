import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import BlockEditor from './BlockEditor.vue'

it('保存期间锁定输入和提交，防止请求期间继续改写未保存内容', async () => {
  const wrapper = mount(BlockEditor, { props: { editing: true, busy: true, error: null,
    submitLabel: '保存中…', name: '名称', content: '内容', tags: '', kind: 'text' } })
  for (const input of wrapper.findAll('input, textarea, select')) {
    expect(input.attributes('disabled')).toBeDefined()
  }
  await wrapper.get('form').trigger('submit')
  expect(wrapper.emitted('submit')).toBeUndefined()
  wrapper.unmount()
})
