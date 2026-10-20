<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { deleteArchive, listArchives, type Archive } from '../api/archives'
import { useModalEsc } from '../composables/useModalEsc'
import ArchivePreview from './ArchivePreview.vue'
const props = defineProps<{ initialArchiveId?: number | null }>()
const emit = defineEmits<{ close: [] }>()
const archives = ref<Archive[]>([])
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const selected = ref<number | null>(props.initialArchiveId ?? null)
const selectedArchive = computed(() => archives.value.find(archive => archive.id === selected.value))
const card = ref<HTMLElement | null>(null)
const query = ref('')
const visibleArchives = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return archives.value.filter(archive =>
    `${archive.name} ${archive.template_name} ${archive.version_name}`.toLocaleLowerCase().includes(term),
  )
})
function close(): void { if (!busy.value) emit('close') }
async function selectArchive(id: number): Promise<void> {
  selected.value = id
  await nextTick()
  card.value?.scrollTo?.({ top: 0, behavior: 'smooth' })
}
useModalEsc(close)
async function load(): Promise<void> {
  archives.value = await listArchives()
}
onMounted(async () => {
  try { await load() } catch (err) { error.value = String(err) }
  finally { loading.value = false }
})
async function remove(archive: Archive): Promise<void> {
  if (!confirm(`永久删除归档「${archive.name}」？此操作无法撤销，原内容版本不受影响。`)) return
  busy.value = true; error.value = ''
  try {
    await deleteArchive(archive.id)
    if (selected.value === archive.id) selected.value = null
    await load()
  } catch (err) { error.value = String(err) } finally { busy.value = false }
}
</script>

<template>
  <dialog
    ref="modal"
    class="library-dialog"
    aria-label="归档库"
    @click.self="close"
  >
    <section
      ref="card"
      class="library-card"
    >
      <header>
        <h2>归档库</h2><button
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
      <p class="description">
        {{ query.trim() ? `找到 ${visibleArchives.length} / ${archives.length}` : `共 ${archives.length}` }} 份归档
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
          <p v-if="!loading && !error && !archives.length">
            暂无归档。在工作台点击“归档”，即可把当前稿件保存到这里。
          </p>
          <p v-else-if="!loading && archives.length && !visibleArchives.length">
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
            <div class="row-actions">
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
  </dialog>
</template>

<style scoped>
.library-dialog { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 20px; border: 0; background: transparent; }
.library-dialog::backdrop { background: var(--modal-backdrop); }
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
@media (max-width: 760px) { .archive-layout.has-preview { grid-template-columns: 1fr; } .archive-result, .archive-list { grid-area: auto; } .archive-result :deep(.archive-preview) { max-height: 46dvh; } .library-card { padding: 16px; } }
</style>
