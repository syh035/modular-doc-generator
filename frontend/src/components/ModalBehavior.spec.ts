import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { useModalEsc } from '../composables/useModalEsc'
import type { DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'
import ExportDialog from './ExportDialog.vue'
import MigrationDialog from './MigrationDialog.vue'
import ProofreadPopover from './ProofreadPopover.vue'
import RegionNameDialog from './RegionNameDialog.vue'
import VersionDialog from './VersionDialog.vue'

const region: DisplayRegion = {
  id: 1, template_id: 1, type: 'custom', label: '项目', placeholder: '{{项目}}',
  anchor: { kind: 'p', path: [0] }, order_index: 0, bbox: null,
  confidence: null, review_status: 'pending', created_at: '', updated_at: '',
  binding: null, overflow: null,
}
const migrationProps = {
  stage: 'prompt' as const, sourceTemplateName: '旧模板', sourceVersionName: '上期',
  sourceBindingCount: 1, targetTemplateName: '新模板', plan: null,
  error: null, submitting: false,
}
const menuFixture = defineComponent({
  props: { hideActions: Boolean },
  setup() { useModalEsc(() => {}) },
  template: `<dialog ref="modal"><button class="first">新建</button>
    <div class="card" tabindex="0">内容块</div>
    <details><summary>管理内容块</summary>
      <button :style="hideActions ? { display: 'none' } : undefined">编辑</button>
      <button :style="hideActions ? { display: 'none' } : undefined">删除</button>
    </details></dialog>`,
})
let opener: HTMLButtonElement
const cleanup: (() => void)[] = []

beforeEach(() => {
  opener = document.createElement('button')
  opener.textContent = '打开弹层'
  document.body.append(opener)
  opener.focus()
})

afterEach(() => {
  cleanup.reverse().forEach(unmount => unmount())
  cleanup.length = 0
  document.body.replaceChildren()
})

function key(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  document.activeElement?.dispatchEvent(event)
  return event
}

describe('M12 弹层键盘与焦点', () => {
  it.each([
    ['绑定', () => mount(BindingDialog, { props: { region, blocks: [] }, attachTo: document.body })],
    ['校对', () => mount(ProofreadPopover, { props: { region }, attachTo: document.body })],
    ['区域命名', () => mount(RegionNameDialog, {
      props: { error: null, submitting: false }, attachTo: document.body,
    })],
    ['版本', () => mount(VersionDialog, {
      props: { mode: 'create', initialName: '', canCopy: true, error: null, submitting: false },
      attachTo: document.body,
    })],
    ['迁移', () => mount(MigrationDialog, { props: migrationProps, attachTo: document.body })],
    ['导出', () => mount(ExportDialog, {
      props: { warnings: [], error: null, submitting: false }, attachTo: document.body,
    })],
  ] as const)('%s：打开后焦点在弹层内，Esc 只请求关闭，卸载后归还焦点', (_name, create) => {
    const wrapper = create()
    cleanup.push(() => wrapper.unmount())
    const dialog = wrapper.get('dialog').element
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(key('Escape').defaultPrevented).toBe(true)
    expect(wrapper.emitted('close')).toHaveLength(1)
    // 迁移 Esc 与遮罩/关闭按钮共用 close，父组件将其解释为跳过，而非 proceed/apply。
    expect(wrapper.emitted('proceed')).toBeUndefined()
    expect(wrapper.emitted('apply')).toBeUndefined()
    wrapper.unmount()
    cleanup.pop()
    expect(document.activeElement).toBe(opener)
    expect(key('Escape').defaultPrevented).toBe(false)
  })

  it('命名输入优先获焦，Tab/Shift+Tab 双向循环且跳过禁用按钮', async () => {
    const wrapper = mount(VersionDialog, {
      props: { mode: 'create', initialName: '', canCopy: true, error: null, submitting: false },
      attachTo: document.body,
    })
    cleanup.push(() => wrapper.unmount())
    expect(document.activeElement).toBe(wrapper.get('input[type="text"], input:not([type])').element)
    const first = wrapper.get('.icon-btn').element as HTMLButtonElement
    const last = wrapper.get('.ghost').element as HTMLButtonElement
    last.focus() // 创建按钮因空名被禁用，不应成为循环终点。
    expect(key('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(key('Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)
    opener.focus()
    expect(wrapper.element.contains(document.activeElement)).toBe(true)
    await wrapper.get('[data-testid="version-name-input"]').setValue('本期')
    const submit = wrapper.get('.primary').element as HTMLButtonElement
    submit.focus()
    key('Tab')
    expect(document.activeElement).toBe(first)
  })

  it('迁移切换阶段移除当前按钮后，焦点保持在弹层内', async () => {
    const wrapper = mount(MigrationDialog, { props: migrationProps, attachTo: document.body })
    cleanup.push(() => wrapper.unmount())
    ;(wrapper.get('[data-testid="migration-proceed"]').element as HTMLElement).focus()
    await wrapper.setProps({ stage: 'plan', plan: {
      source_version_id: 1, source_version_name: '上期', source_template_id: 1,
      target_template_id: 2, target_version_id: 2, auto: [], candidates: [], unmatched: [],
    } })
    await flushPromises()
    expect(wrapper.element.contains(document.activeElement)).toBe(true)
  })

  it('最后卡片后的菜单入口仍可继续 Tab，并作为模态循环边界', () => {
    const wrapper = mount(menuFixture, { props: { hideActions: true }, attachTo: document.body })
    cleanup.push(() => wrapper.unmount())
    const first = wrapper.get('.first').element as HTMLButtonElement
    const card = wrapper.get('.card').element as HTMLElement
    const summary = wrapper.get('summary').element as HTMLElement
    card.focus()
    expect(key('Tab').defaultPrevented).toBe(false)
    summary.focus()
    expect(key('Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(key('Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(summary)
  })

  it('关闭的 details 动作不进入循环，展开后才纳入焦点边界', () => {
    const wrapper = mount(menuFixture, { attachTo: document.body })
    cleanup.push(() => wrapper.unmount())
    const first = wrapper.get('.first').element as HTMLButtonElement
    const summary = wrapper.get('summary').element as HTMLElement
    const details = wrapper.get('details').element as HTMLDetailsElement
    expect(key('Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(summary)
    details.open = true
    first.focus()
    expect(key('Tab', true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(wrapper.findAll('button').at(-1)!.element)
    details.open = false
    first.focus()
    key('Tab', true)
    expect(document.activeElement).toBe(summary)
  })

  it('叠加弹层只关闭最上层，关闭后回到前一层；IME Escape 不关闭', () => {
    const lower = mount(RegionNameDialog, {
      props: { error: null, submitting: false }, attachTo: document.body,
    })
    cleanup.push(() => lower.unmount())
    const previous = document.activeElement
    const upper = mount(ExportDialog, {
      props: { warnings: [], error: null, submitting: false }, attachTo: document.body,
    })
    cleanup.push(() => upper.unmount())
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', isComposing: true, bubbles: true,
    }))
    expect(upper.emitted('close')).toBeUndefined()
    key('Escape')
    expect(upper.emitted('close')).toHaveLength(1)
    expect(lower.emitted('close')).toBeUndefined()
    upper.unmount()
    cleanup.pop()
    expect(document.activeElement).toBe(previous)
    key('Escape')
    expect(lower.emitted('close')).toHaveLength(1)
  })
})
