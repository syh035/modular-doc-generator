import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { Block } from '../api/blocks'
import type { DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'

const block = (id: number, name: string, content: string): Block => ({
  id,
  name,
  content,
  tags: [],
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


describe('绑定内容块搜索', () => {
  it('正文搜索叠加标签筛选，结果保留绑定 ID，当前绑定仍可见', async () => {
    const blocks = [
      { ...block(1, '工作经历', 'Vue 前端开发'), tags: [{ id: 2, name: '技术' }] },
      { ...block(2, '项目说明', '数据平台建设'), tags: [{ id: 3, name: '项目' }] },
    ]
    const wrapper = mountDialog(region({ block_id: 1, block_name: '工作经历', status: 'active' }), blocks)
    await wrapper.get('input[type="search"]').setValue('vue')
    expect(wrapper.findAll('.block-item')).toHaveLength(1)
    expect(wrapper.find('.current').text()).toContain('当前绑定')
    await wrapper.get('select[aria-label="按标签筛选内容块"]').setValue('3')
    expect(wrapper.findAll('.block-item')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配的内容块')
    await wrapper.get('select[aria-label="按标签筛选内容块"]').setValue('2')
    await wrapper.get('.block-item').trigger('click')
    expect(wrapper.emitted('bind')).toEqual([[1]])
  })
})


it('版本区域含原文时提供文字编辑入口', async () => {
  const w = mountDialog({ ...region(null), current_text: '原文' })
  await w.get('[data-testid=edit-region-text]').trigger('click')
  expect(w.emitted('edit')).toEqual([[]])
  w.unmount()
})


it('软回车选项随绑定提交，当前绑定可更新换行设置', async () => {
  const w = mountDialog(region({ block_id: 1, block_name: '多行', status: 'active' }), [block(1, '多行', '第一行\n第二行')])
  await w.get('[aria-label=多行内容换行方式]').setValue('soft')
  await w.get('.block-item').trigger('click')
  expect(w.emitted('bind')?.[0]).toEqual([1, 'soft'])
  w.unmount()
})


it('前后插入同时提交位置和换行，保留原文提示', async () => {
  const w = mountDialog(region(null), [block(1, '内容', '两行')])
  await w.get('[aria-label=绑定位置]').setValue('before')
  await w.get('[aria-label=多行内容换行方式]').setValue('soft')
  expect(w.text()).toContain('保留原段落')
  await w.get('.block-item').trigger('click')
  expect(w.emitted('bind')).toEqual([[1, 'soft', 'before']])
  w.unmount()
})
