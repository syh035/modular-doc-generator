import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { MigrationPlan } from '../api/migrations'
import MigrationDialog from './MigrationDialog.vue'

/** 三清单齐全的方案：①自动 1 行 + ②候选 2 行（共享同 2 个目标）+ ③无匹配 1 行。 */
const PLAN: MigrationPlan = {
  source_version_id: 5,
  source_version_name: '默认版本',
  source_template_id: 1,
  target_template_id: 2,
  target_version_id: 6,
  auto: [
    {
      source_region_id: 11,
      source_label: '姓名',
      target_region_id: 21,
      target_label: '名字',
      block_id: 31,
      block_name: '姓名块',
    },
  ],
  candidates: [
    {
      source_region_id: 12,
      source_label: '工作一',
      block_id: 32,
      block_name: '工作块一',
      options: [
        { region_id: 22, label: '目标工一', type: 'work' },
        { region_id: 23, label: '目标工二', type: 'work' },
      ],
    },
    {
      source_region_id: 13,
      source_label: '工作二',
      block_id: 33,
      block_name: '工作块二',
      options: [
        { region_id: 22, label: '目标工一', type: 'work' },
        { region_id: 23, label: '目标工二', type: 'work' },
      ],
    },
  ],
  unmatched: [
    {
      source_region_id: 14,
      source_label: '自定义',
      block_id: 34,
      block_name: '自定义块',
      manual_options: [{ region_id: 24, label: '目标自一', type: 'custom' }],
    },
  ],
}

function mountDialog(
  props: Partial<{
    stage: 'prompt' | 'plan'
    plan: MigrationPlan | null
    error: string | null
    submitting: boolean
  }> = {},
) {
  return mount(MigrationDialog, {
    props: {
      stage: 'prompt',
      sourceTemplateName: '旧模板.docx',
      sourceVersionName: '默认版本',
      sourceBindingCount: 3,
      targetTemplateName: '新模板.docx',
      plan: null,
      error: null,
      submitting: false,
      ...props,
    },
  })
}

describe('MigrationDialog（M10）', () => {
  it('prompt 段：展示源/目标上下文与绑定数', () => {
    const wrapper = mountDialog()
    expect(wrapper.text()).toContain('换模板迁移')
    expect(wrapper.text()).toContain('旧模板.docx')
    expect(wrapper.text()).toContain('默认版本')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('新模板.docx')
  })

  it('prompt 段：跳过 emit(skip)，迁移 emit(proceed)', async () => {
    const wrapper = mountDialog()
    await wrapper.find('[data-testid="migration-skip"]').trigger('click')
    expect(wrapper.emitted('skip')).toHaveLength(1)
    await wrapper.find('[data-testid="migration-proceed"]').trigger('click')
    expect(wrapper.emitted('proceed')).toHaveLength(1)
  })

  it('plan 段：②候选按序预选首个可用者，跨行互斥（行 2 拿不到行 1 已占的目标）', () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN })
    const s1 = wrapper.find('[data-testid="migration-pick-12"]').element as HTMLSelectElement
    const s2 = wrapper.find('[data-testid="migration-pick-13"]').element as HTMLSelectElement
    expect(s1.value).toBe('22') // 行 1 预选目标工一
    expect(s2.value).toBe('23') // 行 2 自动避开被占的 22，预选 23
    const opts2 = [...s2.options].map(o => o.value)
    expect(opts2).not.toContain('22') // 被行 1 占用 → 不出现在行 2 选项
    expect(opts2).toContain('23')
  })

  it('plan 段：③默认留空；count = ①全部 + ②③已选数', () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN })
    const s3 = wrapper.find('[data-testid="migration-pick-14"]').element as HTMLSelectElement
    expect(s3.selectedIndex).toBe(0) // unmatched 默认选中「留空」
    expect(s3.options[0]!.text).toBe('留空')
    expect(wrapper.find('[data-testid="migration-count"]').text()).toBe('将迁移 3 个绑定')
  })

  it('plan 段：确认时整包 emit ①自动 + ②已选 + ③已选', async () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN })
    await wrapper.find('[data-testid="migration-apply"]').trigger('click')
    expect(wrapper.emitted('apply')![0]).toEqual([
      [
        { region_id: 21, block_id: 31 }, // ①自动
        { region_id: 22, block_id: 32 }, // ②行 1 预选
        { region_id: 23, block_id: 33 }, // ②行 2 预选
      ],
    ])
  })

  it('plan 段：②改为留空 / ③手动指定，emit 结果跟随', async () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN })
    // 「留空」选项绑定的 value 是 null（DOM value 为选项文本），经 selectedIndex + change 触发
    const sel12 = wrapper.find('[data-testid="migration-pick-12"]')
    ;(sel12.element as HTMLSelectElement).selectedIndex = 0
    await sel12.trigger('change')
    await wrapper.find('[data-testid="migration-pick-14"]').setValue(24)
    expect(wrapper.find('[data-testid="migration-count"]').text()).toBe('将迁移 3 个绑定')
    await wrapper.find('[data-testid="migration-apply"]').trigger('click')
    expect(wrapper.emitted('apply')![0]).toEqual([
      [
        { region_id: 21, block_id: 31 },
        { region_id: 23, block_id: 33 },
        { region_id: 24, block_id: 34 },
      ],
    ])
  })

  it('plan 段：三清单全空显示空态文案，applyCount 为 0', () => {
    const empty: MigrationPlan = { ...PLAN, auto: [], candidates: [], unmatched: [] }
    const wrapper = mountDialog({ stage: 'plan', plan: empty })
    expect(wrapper.text()).toContain('源版本没有可迁移的绑定')
    expect(wrapper.find('[data-testid="migration-count"]').text()).toBe('将迁移 0 个绑定')
  })

  it('plan 段：取消 emit(close)', async () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN })
    await wrapper.find('[data-testid="migration-cancel"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('错误内联显示（plan/apply 失败）', () => {
    const wrapper = mountDialog({ stage: 'plan', plan: PLAN, error: '目标默认版本非空白' })
    expect(wrapper.find('[data-testid="migration-error"]').text()).toBe('目标默认版本非空白')
  })

  it('submitting：迁移按钮禁用', () => {
    const wrapper = mountDialog({ submitting: true })
    expect((wrapper.find('[data-testid="migration-proceed"]').element as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
