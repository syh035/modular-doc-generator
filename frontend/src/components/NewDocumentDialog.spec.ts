import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '../api/client'
import { createMigratedDocument, planNewDocument, previewNewDocument, type DocumentPlan, type DocumentTrial } from '../api/migrations'
import type { TemplateListItem } from '../api/templates'
import NewDocumentDialog from './NewDocumentDialog.vue'
import MigrationPreview from './MigrationPreview.vue'

vi.mock('../api/migrations', () => ({ planNewDocument: vi.fn(), previewNewDocument: vi.fn(), createMigratedDocument: vi.fn() }))
vi.mock('../pdf/viewer', () => ({ openDocument: vi.fn(), preparePage: vi.fn() }))
const template = (id: number): TemplateListItem => ({ id, filename: `模板${id}`, storage_name: '', sha256: '', status: 'ready', created_at: '', updated_at: '', regions_count: 2 })
const plan: DocumentPlan = {
  mode: 'new_document', source_version_id: 10, source_version_name: '原稿', source_template_id: 1, target_template_id: 2, target_version_id: null, plan_token: 'fresh',
  source_items: [{ source_region_id: 1, source_label: '姓名', content: '测试姓名', kind: 'text' }, { source_region_id: 2, source_label: '经历', content: '实际经历正文', kind: 'text' }],
  auto: [{ source_region_id: 1, source_label: '姓名', target_region_id: 11, target_label: '姓名位置', block_id: 21, block_name: '姓名' }], candidates: [], unmatched: [],
}
const trial: DocumentTrial = { plan_token: 'fresh', pdf_base64: '', pdf_sha256: 'pdf', items: [
  { id: 11, label: '姓名位置', bbox: null, review_status: 'confirmed', overflow: null },
  { id: 12, label: '经历位置', bbox: null, review_status: 'confirmed', overflow: null },
] }
function mountDialog(openDocument = vi.fn(async () => {})) {
  return mount(NewDocumentDialog, { props: { source: { id: 10, template_id: 1, name: '原稿' }, templates: [template(1), template(2), template(3)], openDocument },
    global: { stubs: { MigrationPreview: true } } })
}
function button(wrapper: ReturnType<typeof mountDialog>, text: string) { return wrapper.findAll('button').find(item => item.text() === text)! }
async function choose(wrapper: ReturnType<typeof mountDialog>) {
  await wrapper.find('select').setValue('2'); await flushPromises()
  wrapper.findComponent(MigrationPreview).vm.$emit('ready', true); await flushPromises()
}
async function omitRemaining(wrapper: ReturnType<typeof mountDialog>) {
  await button(wrapper, '本次不带入').trigger('click'); await flushPromises()
  wrapper.findComponent(MigrationPreview).vm.$emit('ready', true); await flushPromises()
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(planNewDocument).mockResolvedValue(structuredClone(plan))
  vi.mocked(previewNewDocument).mockResolvedValue(structuredClone(trial))
  vi.mocked(createMigratedDocument).mockResolvedValue({ version_id: 30, template_id: 2, name: '新稿', created: 1 })
})
describe('可视更换模板', () => {
  it('显示实际文字，取消不建稿且不暴露技术匹配清单', async () => {
    const wrapper = mountDialog()
    await choose(wrapper)
    expect(wrapper.text()).toContain('实际经历正文')
    expect(wrapper.text()).not.toMatch(/自动匹配|同类型|候选/)
    expect(button(wrapper, '生成新文稿').attributes('disabled')).toBeDefined()
    await button(wrapper, '取消').trigger('click')
    expect(wrapper.emitted('close')).toEqual([[null]])
    expect(createMigratedDocument).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('不能覆盖已占位置，逐段明确不带入后才可生成', async () => {
    const wrapper = mountDialog()
    await choose(wrapper)
    wrapper.findComponent(MigrationPreview).vm.$emit('place', 11); await flushPromises()
    expect(wrapper.text()).toContain('此位置已有文字')
    expect(previewNewDocument).toHaveBeenCalledTimes(1)
    await omitRemaining(wrapper)
    expect(button(wrapper, '生成新文稿').attributes('disabled')).toBeUndefined()
    await button(wrapper, '生成新文稿').trigger('click'); await flushPromises()
    expect(createMigratedDocument).toHaveBeenCalledWith(2, expect.objectContaining({ source_version_id: 10, placements: [{ source_region_id: 1, target_region_id: 11 }], omitted_source_region_ids: [2] }), expect.any(String), expect.any(String))
    wrapper.unmount()
  })
  it('可以将已有文字移动到另一个空位置', async () => {
    const wrapper = mountDialog()
    await choose(wrapper)
    await wrapper.findAll('.source')[0]!.trigger('click')
    wrapper.findComponent(MigrationPreview).vm.$emit('update:zoom', '1'); await flushPromises()
    wrapper.findComponent(MigrationPreview).vm.$emit('place', 12); await flushPromises()
    expect(previewNewDocument).toHaveBeenLastCalledWith(2, expect.objectContaining({ placements: [{ source_region_id: 1, target_region_id: 12 }] }))
    expect(wrapper.findComponent(MigrationPreview).props('zoom')).toBe('1')
    wrapper.unmount()
  })
  it('试排失败保留安排并可重试，过期计划必须重新读取', async () => {
    const wrapper = mountDialog()
    await choose(wrapper)
    vi.mocked(previewNewDocument).mockRejectedValueOnce(new Error('转换失败'))
    await button(wrapper, '本次不带入').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('转换失败')
    await button(wrapper, '重试试排').trigger('click'); await flushPromises()
    expect(previewNewDocument).toHaveBeenLastCalledWith(2, expect.objectContaining({ omitted_source_region_ids: [2] }))
    vi.mocked(previewNewDocument).mockRejectedValueOnce(new ApiRequestError('MIGRATION_PLAN_STALE', '计划过期'))
    wrapper.findComponent(MigrationPreview).vm.$emit('ready', true); await flushPromises()
    await button(wrapper, '本次不带入').trigger('click'); await flushPromises()
    expect(button(wrapper, '重新读取原稿与模板').exists()).toBe(true)
    expect(button(wrapper, '生成新文稿').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('网络中断的生成重试使用同一请求和键，期间不能修改安排', async () => {
    const wrapper = mountDialog()
    await choose(wrapper); await omitRemaining(wrapper)
    vi.mocked(createMigratedDocument).mockRejectedValueOnce(new ApiRequestError('NETWORK_ERROR', '断线'))
    await button(wrapper, '生成新文稿').trigger('click'); await flushPromises()
    expect(wrapper.find('select').attributes('disabled')).toBeDefined()
    await button(wrapper, '重试确认生成结果').trigger('click'); await flushPromises()
    expect(vi.mocked(createMigratedDocument).mock.calls[0]).toEqual(vi.mocked(createMigratedDocument).mock.calls[1])
    wrapper.unmount()
  })
  it('新稿生成后打开失败只重试打开，不再次提交创建', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('预览失败')).mockResolvedValue(undefined)
    const wrapper = mountDialog(open)
    await choose(wrapper); await omitRemaining(wrapper)
    await button(wrapper, '生成新文稿').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('新稿已生成')
    await button(wrapper, '重试打开新稿').trigger('click'); await flushPromises()
    expect(createMigratedDocument).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('迟到的模板计划不能覆盖后来选择的模板', async () => {
    let resolve!: (value: DocumentPlan) => void
    vi.mocked(planNewDocument).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const wrapper = mountDialog()
    await wrapper.find('select').setValue('2')
    await wrapper.find('select').setValue('3'); await flushPromises()
    resolve({ ...plan, source_items: [] }); await flushPromises()
    expect(wrapper.text()).toContain('实际经历正文')
    expect(previewNewDocument).toHaveBeenCalledTimes(1)
    expect(previewNewDocument).toHaveBeenCalledWith(3, expect.anything())
    wrapper.unmount()
  })
})
