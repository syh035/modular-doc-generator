import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Block } from '../api/blocks'
import type { DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'

const block = (id: number, name: string, content: string): Block => ({
  id,
  name,
  content,
  category: '未分类',
  created_at: '',
  updated_at: '',
})

function region(binding: DisplayRegion['binding']): DisplayRegion {
  return {
    id: 1,
    template_id: 1,
    type: 'custom',
    label: '姓名',
    placeholder: '{{姓名}}',
    anchor: { kind: 'p', path: [0] },
    order_index: 0,
    bbox: null,
    confidence: null,
    review_status: 'pending',
    created_at: '',
    updated_at: '',
    binding,
  }
}

function mountDialog(region: DisplayRegion, blocks: Block[] = []) {
  return mount(BindingDialog, { props: { region, blocks } })
}

describe('BindingDialog（M6a）', () => {
  it('未绑定区域：展示块列表，点块 emit bind', async () => {
    const wrapper = mountDialog(region(null), [block(1, '姓名块', '张三'), block(2, '电话块', '138')])
    expect(wrapper.text()).toContain('区域：姓名')
    expect(wrapper.text()).not.toContain('当前绑定')

    const items = wrapper.findAll('.block-item')
    expect(items).toHaveLength(2)
    await items[1].trigger('click')
    expect(wrapper.emitted('bind')?.[0]).toEqual([2])
  })

  it('已绑定区域：显示当前块、当前项高亮、点其他块 = 换绑', async () => {
    const wrapper = mountDialog(
      region({ block_id: 1, block_name: '姓名块', status: 'active' }),
      [block(1, '姓名块', '张三'), block(2, '电话块', '138')],
    )
    expect(wrapper.text()).toContain('当前绑定')
    expect(wrapper.text()).toContain('姓名块')
    expect(wrapper.find('.block-item.current').text()).toContain('张三')

    await wrapper.findAll('.block-item')[1].trigger('click')
    expect(wrapper.emitted('bind')?.[0]).toEqual([2])
  })

  it('已绑定区域：解绑按钮 emit unbind（未绑定时隐藏）', async () => {
    const bound = mountDialog(region({ block_id: 1, block_name: 'x', status: 'active' }), [])
    expect(bound.find('.danger').exists()).toBe(true)
    await bound.find('.danger').trigger('click')
    expect(bound.emitted('unbind')).toHaveLength(1)

    const unbound = mountDialog(region(null), [])
    expect(unbound.find('.danger').exists()).toBe(false)
  })

  it('missing 绑定：提示重新绑定', () => {
    const wrapper = mountDialog(region({ block_id: 1, block_name: null, status: 'missing' }), [])
    expect(wrapper.text()).toContain('原绑定块已删除')
  })

  it('空块库：提示先新建', () => {
    const wrapper = mountDialog(region(null), [])
    expect(wrapper.text()).toContain('块库为空')
  })

  it('关闭按钮与遮罩点击 emit close', async () => {
    const wrapper = mountDialog(region(null), [])
    await wrapper.find('.icon-btn').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.find('[data-testid="binding-dialog"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
