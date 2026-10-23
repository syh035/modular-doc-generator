<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { deleteArchive, listArchives, type Archive } from '../api/archives'
import { useModalEsc } from '../composables/useModalEsc'
import ArchivePreview from './ArchivePreview.vue'
import { useDocumentsStore } from '../stores/documents'
const props = defineProps<{ initialArchiveId?: number | null; embedded?: boolean; sourceDocument?: { id: number; name: string } | null }>()
const emit = defineEmits<{ close: []; all: []; 'open-source': [templateId: number, versionId: number] }>()
const documents = useDocumentsStore()
const sourceLoading = ref(false)
const sourceError = ref(false)
const sources = computed(() => new Map(documents.error ? [] : documents.groups.flatMap(group =>
  group.loaded && !group.error && !group.loading ? group.documents.map(document => [document.id, document] as const) : [],
)))
const archives = ref<Archive[]>([])
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const selected = ref<number | null>(props.initialArchiveId ?? null)
const selectedArchive = computed(() => archives.value.find(archive => archive.id === selected.value))
const card = ref<HTMLElement | null>(null)
const query = ref('')
let disposed = false
let request = 0
let sourceRequest = 0
watch(() => props.initialArchiveId, id => { selected.value = id ?? null })
watch(() => props.sourceDocument?.id, async () => {
  selected.value = null; query.value = ''
  await nextTick()
  if (document.activeElement === document.body) focusSearch()
})
function focusSearch(): void { card.value?.querySelector<HTMLInputElement>('.archive-search input')?.focus({ preventScroll: true }) }
const scopedArchives = computed(() => archives.value.filter(archive => !props.sourceDocument || archive.source_version_id === props.sourceDocument.id))
const visibleArchives = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return scopedArchives.value.filter(archive =>
    `${archive.name} ${archive.template_name} ${archive.version_name}`.toLocaleLowerCase().includes(term),
  )
})
function close(): void { if (!busy.value) emit('close') }
async function selectArchive(id: number): Promise<void> {
  selected.value = id
  await nextTick()
  card.value?.scrollTo?.({ top: 0, behavior: 'smooth' })
}
if (!props.embedded) useModalEsc(close)
async function load(): Promise<void> {
  const seq = ++request
  sourceRequest++; sourceLoading.value = false; sourceError.value = false
  loading.value = true; error.value = ''
  try {
    const result = await listArchives()
    if (!disposed && seq === request) {
      archives.value = result
      if (result.some(archive => archive.source_version_id)) void loadSources(seq)
    }
  } catch (err) {
    if (!disposed && seq === request) error.value = err instanceof Error ? err.message : String(err)
  } finally { if (!disposed && seq === request) loading.value = false }
}
async function loadSources(seq = request): Promise<void> {
  const sourceSeq = ++sourceRequest
  sourceLoading.value = true; sourceError.value = false
  await documents.load()
  if (!disposed && seq === request && sourceSeq === sourceRequest) {
    sourceLoading.value = false
    sourceError.value = documents.incomplete || documents.loading
  }
}
function openSource(archive: Archive): void {
  if (sourceLoading.value || busy.value) return
  const source = sources.value.get(archive.source_version_id)
  if (source) emit('open-source', source.template_id, source.id)
}
onMounted(() => { void load(); if (props.embedded && props.sourceDocument) focusSearch() })
onBeforeUnmount(() => { disposed = true; request++ })
async function remove(archive: Archive): Promise<void> {
  if (!confirm(`永久删除归档「${archive.name}」？此操作无法撤销，原内容版本不受影响。`)) return
  busy.value = true; error.value = ''
  try {
    await deleteArchive(archive.id)
    if (selected.value === archive.id) selected.value = null
    await load()
    await nextTick()
    if (document.activeElement === document.body) card.value?.querySelector<HTMLInputElement>('.archive-search input')?.focus()
  } catch (err) { error.value = String(err) } finally { busy.value = false }
}
</script>

<template>
  <component
    :is="embedded ? 'main' : 'dialog'"
    ref="modal"
    class="library-dialog"
    :class="{ embedded }"
    aria-label="归档库"
    @click.self="close"
  >
    <section
      ref="card"
      class="library-card"
    >
      <header>
        <h2>归档库</h2><button
          v-if="!embedded"
          :disabled="busy"
          aria-label="关闭归档库"
          @click="close"
        >
          关闭
        </button>
      </header>
      <p class="description">
        已保存的稿件集中在这里。后续编辑或删除来源，不会改变归档中的 Word 和 PDF。
      </p>
      <label class="archive-search">查找归档<input
        v-model="query"
        data-modal-autofocus
        type="search"
        placeholder="搜索归档名称或来源"
        aria-label="搜索归档"
      ></label>
      <div
        v-if="sourceDocument"
        class="source-filter"
      >
        <span>此文稿的归档：{{ sourceDocument.name }}</span>
        <button
          :disabled="busy"
          @click="emit('all')"
        >
          查看全部归档
        </button>
      </div>
      <p class="description">
        {{ query.trim() ? `找到 ${visibleArchives.length} / ${scopedArchives.length}` : `共 ${scopedArchives.length}` }} 份归档
      </p>
      <p
        v-if="sourceError"
        class="description"
        role="status"
      >
        暂时无法核对部分来源，归档仍可查看和下载。
        <button
          :disabled="sourceLoading || busy"
          @click="loadSources()"
        >
          重试核对来源
        </button>
      </p>
      <p
        v-if="loading"
        class="description"
        role="status"
      >
        正在加载归档…
      </p>
      <p
        v-if="error"
        role="alert"
        class="error"
      >
        {{ error }}
        <button
          :disabled="loading || busy"
          @click="load"
        >
          重试
        </button>
      </p>
      <div
        class="archive-layout"
        :class="{ 'has-preview': selected !== null }"
      >
        <section
          v-if="selected !== null"
          class="archive-result"
          aria-label="所选归档"
        >
          <header>
            <h3>{{ selectedArchive?.name ?? '归档预览' }}</h3>
            <button @click="selected = null">
              收起预览
            </button>
          </header>
          <ArchivePreview
            :key="selected"
            :archive-id="selected"
          />
        </section>
        <div class="archive-list">
          <p v-if="!loading && !error && !scopedArchives.length">
            {{ sourceDocument ? '此文稿暂无归档。可在编辑页点击“归档”保存当前稿件。' : '暂无归档。在文稿编辑页点击“归档”，即可把当前稿件保存到这里。' }}
          </p>
          <p v-else-if="!loading && scopedArchives.length && !visibleArchives.length">
            没有找到匹配的归档。
          </p>
          <article
            v-for="archive in visibleArchives"
            :key="archive.id"
            :class="{ selected: selected === archive.id }"
          >
            <strong>{{ archive.name }}</strong>
            <p>{{ archive.template_name }} · {{ archive.version_name }}</p>
            <p>{{ new Date(archive.created_at).toLocaleString() }}</p>
            <p v-if="sourceLoading">
              正在核对来源…
            </p>
            <p v-else-if="!archive.source_version_id">
              未记录来源文稿，归档独立保留。
            </p>
            <p v-else-if="!sources.has(archive.source_version_id)">
              {{ sourceError ? '来源暂无法核对' : '来源文稿已不存在，归档独立保留。' }}
            </p>
            <p v-else>
              当前来源：{{ sources.get(archive.source_version_id)?.name }}（归档仍是保存时的内容）
            </p>
            <div class="row-actions">
              <button
                v-if="!sourceLoading && sources.has(archive.source_version_id)"
                :disabled="busy"
                @click="openSource(archive)"
              >
                打开来源文稿
              </button>
              <button
                :disabled="busy"
                @click="selectArchive(archive.id)"
              >
                查看
              </button>
              <a
                :href="`/api/archives/${archive.id}/docx`"
                download
              >下载 Word</a>
              <a
                :href="`/api/archives/${archive.id}/pdf`"
                download
              >下载 PDF</a>
              <button
                :disabled="busy"
                @click="remove(archive)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
      </div>
    </section>
  </component>
</template>

<style scoped>
.library-dialog { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 20px; border: 0; background: transparent; }
.library-dialog::backdrop { background: var(--modal-backdrop); }
.library-dialog.embedded { position: static; flex: 1; width: auto; height: auto; min-height: 0; padding: 24px; overflow: auto; }
.embedded .library-card { width: min(1100px, 100%); max-height: none; box-shadow: none; border: 1px solid var(--border); }
.library-card { width: min(1060px, 100%); max-height: calc(100dvh - 40px); margin: auto; padding: 24px; overflow: auto; background: var(--bg-surface); color: var(--text-1); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); }
header, .row-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
header { justify-content: space-between; } h2, p { margin: 0 0 12px; }
.description, article p { color: var(--text-2); font-size: 13px; line-height: 1.6; }
.archive-search { display: flex; align-items: center; gap: 12px; margin: 18px 0 12px; font-size: 13px; } input { flex: 1; min-width: 0; padding: 8px; border: 1px solid var(--border-control); border-radius: 6px; }
button, a { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; } a { color: var(--primary); text-decoration: none; }
.archive-layout { display: grid; grid-template-columns: 1fr; gap: 20px; margin-top: 16px; }
.archive-layout.has-preview { grid-template-columns: minmax(240px, 1fr) minmax(0, 1.5fr); }
.archive-list { grid-area: 1 / 1; min-width: 0; } article { padding: 14px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; overflow-wrap: anywhere; }
.archive-result { grid-area: 1 / 2; min-width: 0; } .archive-result header { margin-bottom: 10px; flex-wrap: nowrap; align-items: flex-start; }
.archive-result h3 { min-width: 0; font-size: 14px; overflow-wrap: anywhere; } .archive-result button { flex-shrink: 0; font-size: 12px; }
.archive-result :deep(.archive-preview) { max-height: calc(100dvh - 290px); }
article.selected { border-color: var(--primary); } article strong { display: block; margin-bottom: 8px; }
.row-actions { gap: 8px; font-size: 12px; } .error { color: var(--danger); }
.source-filter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; margin-bottom: 12px; background: var(--primary-bg-subtle); border-radius: 6px; font-size: 13px; overflow-wrap: anywhere; }
@media (max-width: 760px) { .archive-layout.has-preview { grid-template-columns: 1fr; } .archive-result, .archive-list { grid-area: auto; } .archive-result :deep(.archive-preview) { max-height: 46dvh; } .library-card { padding: 16px; } }
@media (max-width: 600px) { .library-dialog.embedded { padding: 16px 12px; } }
</style>
