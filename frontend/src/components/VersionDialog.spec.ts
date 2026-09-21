import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VersionDialog from './VersionDialog.vue'

function mountDialog(
  props: Partial<{
    mode: 'create' | 'rename'
    initialName: string
    canCopy: boolean
    error: string | null
    submitting: boolean
  }> = {},
) {
  return mount(VersionDialog, {
    props: {
      mode: 'create',
      initialName: '',
      canCopy: true,
      error: null,
      submitting: false,
      ...props,
    },
  })
}

describe('VersionDialog（M8）', () => {
  it('create 模式：标题 + 复制底稿选项默认勾选；提交 emit(name, true)', async () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('新建内容版本')
    const cb = wrapper.find('[data-testid="version-copy-checkbox"]')
    expect(cb.exists()).toBe(true)
    expect((cb.element as HTMLInputElement).checked).toBe(true)

    await wrapper.find('[data-testid="version-name-input"]').setValue('投递A岗')
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('submit')![0]).toEqual(['投递A岗', true])
  })

  it('取消勾选复制底稿：emit(name, false)', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-testid="version-copy-checkbox"]').setValue(false)
    await wrapper.find('[data-testid="version-name-input"]').setValue('空白版')
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('submit')![0]).toEqual(['空白版', false])
  })

  it('rename 模式：预填当前名 + 无复制选项 + emit(name, false)', async () => {
    const wrapper = mountDialog({ mode: 'rename', initialName: '默认版本' })
    expect(wrapper.text()).toContain('重命名版本')
    expect(wrapper.find('[data-testid="version-copy-checkbox"]').exists()).toBe(false)
    expect((wrapper.find('[data-testid="version-name-input"]').element as HTMLInputElement).value).toBe(
      '默认版本',
    )
    await wrapper.find('[data-testid="version-name-input"]').setValue('主力版本')
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('submit')![0]).toEqual(['主力版本', false])
  })

  it('空名不 emit；超 30 字不 emit（前端先行拦截）', async () => {
    const wrapper = mountDialog()
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.find('[data-testid="version-name-input"]').setValue('a'.repeat(31))
    await wrapper.find('form').trigger('submit.prevent')
    expect(wrapper.emitted('submit')).toBeUndefined()
  })

  it('错误内联显示（重名 / 名称非法）', () => {
    const wrapper = mountDialog({ error: '同模板下已存在同名版本「投递A岗」' })
    const err = wrapper.find('[data-testid="version-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toBe('同模板下已存在同名版本「投递A岗」')
  })

  it('submitting：提交按钮禁用', () => {
    const wrapper = mountDialog({ submitting: true })
    expect((wrapper.find('.primary').element as HTMLButtonElement).disabled).toBe(true)
  })
})
