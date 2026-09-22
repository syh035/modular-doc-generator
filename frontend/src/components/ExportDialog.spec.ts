import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ExportWarning } from '../api/exports'
import ExportDialog from './ExportDialog.vue'

/** 警示清单：1 高度大超出 + 1 固定行高裁剪。 */
const WARNINGS: ExportWarning[] = [
  { region_id: 7, label: '项目经历', ratio: 1.5, clipped: false, fixed_row: false },
  { region_id: 9, label: '自我评价', ratio: 0.02, clipped: true, fixed_row: true },
]

function mountDialog(
  props: Partial<{ warnings: ExportWarning[]; error: string | null; submitting: boolean }> = {},
) {
  return mount(ExportDialog, {
    props: {
      warnings: WARNINGS,
      error: null,
      submitting: false,
      ...props,
    },
  })
}

describe('ExportDialog（M9 大超出警示）', () => {
  it('渲染全部警示项：高度溢出显示 +N%，裁剪显示固定行高提示', () => {
    const w = mountDialog()
    expect(w.findAll('.warning-row')).toHaveLength(2)
    expect(w.text()).toContain('项目经历')
    expect(w.text()).toContain('+150%')
    expect(w.text()).toContain('自我评价')
    expect(w.text()).toContain('固定行高裁剪内容')
  })

  it('确认按钮触发 confirm 事件（默认仍重排导出）', async () => {
    const w = mountDialog()
    await w.get('[data-testid="export-confirm"]').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
  })

  it('关闭按钮与遮罩点击触发 close（返回修改）', async () => {
    const w = mountDialog()
    await w.find('.icon-btn').trigger('click')
    await w.find('.dialog-mask').trigger('click.self')
    expect(w.emitted('close')).toHaveLength(2)
  })

  it('提交中禁用确认按钮；错误内联显示', async () => {
    const w = mountDialog({ submitting: true, error: '导出文件写入失败' })
    expect(w.get('[data-testid="export-confirm"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="export-error"]').text()).toContain('写入失败')
  })
})
