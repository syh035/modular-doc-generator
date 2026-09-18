<script setup lang="ts">
/**
 * 模板制作指南页（UI 调整①）。
 *
 * 占位符写法说明（D3 主路径 + M3b 词表预告 + D6 限制）+
 * 可复制示例段落 + 可下载示例模板 docx（后端现生成，显式中文字体防渲染空白）。
 */

import { ref } from 'vue'

/** 示例段落（点击复制；覆盖单段多占位符与成段占位）。 */
const sampleLines = [
  '姓名：{{姓名}}    手机号：{{手机号}}',
  '{{教育经历}}',
  '{{工作经历}}',
  '{{自我评价}}',
]

const copied = ref<string | null>(null)
let timer: number | undefined

/** 占位符字面量示例（模板内不能直接写 {{ }}——编译器按首个 }} 截断，经变量插值渲染）。 */
const placeholderExample = '{{字段名}}'
const multiExample = '姓名：{{姓名}}'

async function copy(line: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(line)
    copied.value = line
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      copied.value = null
    }, 2000)
  } catch {
    // 剪贴板不可用（如非安全上下文）静默失败，不阻塞页面
  }
}
</script>

<template>
  <main class="guide-page">
    <h1>模板制作指南</h1>

    <section class="card">
      <h2>占位符怎么写</h2>
      <ul>
        <li>
          在正文任意段落或表格单元格中写入
          <code>{{ placeholderExample }}</code>，上传模板后自动识别为可替换区域。
        </li>
        <li>
          同一段落可以写多个占位符，例如：
          <code>{{ multiExample }}</code>。
        </li>
        <li>
          页眉、页脚、文本框中的占位符<strong>不支持替换</strong>（解析时跳过）。
        </li>
        <li>常见字段名（姓名、手机号、教育经历等）后续会自动识别区域类型。</li>
      </ul>
    </section>

    <section class="card">
      <h2>示例段落（点击复制）</h2>
      <div
        v-for="line in sampleLines"
        :key="line"
        class="sample-row"
      >
        <code class="sample-text">{{ line }}</code>
        <button
          class="copy-btn"
          @click="copy(line)"
        >
          {{ copied === line ? '已复制' : '复制' }}
        </button>
      </div>
    </section>

    <section class="card">
      <h2>示例模板</h2>
      <p>
        下载可直接上传使用的示例模板（已内置中文字体声明，占位符齐全），
        也可作为自己制作模板的起点：
      </p>
      <a
        class="download-link"
        href="/api/guide/sample-template"
        download="示例模板.docx"
      >
        下载示例模板.docx
      </a>
    </section>
  </main>
</template>

<style scoped>
.guide-page {
  flex: 1;
  overflow: auto;
  padding: 24px;
  background: #f5f6f7;
}

h1 {
  margin: 0 0 16px;
  font-size: 20px;
  color: #1f2329;
}

.card {
  max-width: 720px;
  margin-bottom: 16px;
  padding: 16px 20px;
  background: #fff;
  border: 1px solid #e2e3e5;
  border-radius: 8px;
}

h2 {
  margin: 0 0 10px;
  font-size: 15px;
  color: #1f2329;
}

ul {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 2;
  color: #1f2329;
}

code {
  padding: 1px 6px;
  font-size: 12px;
  color: #c7392c;
  background: rgba(199, 57, 44, 0.06);
  border-radius: 3px;
}

.sample-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px dashed #f2f3f5;
}

.sample-row:last-of-type {
  border-bottom: none;
}

.sample-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn {
  flex-shrink: 0;
  padding: 3px 12px;
  font-size: 12px;
  color: #3370ff;
  background: none;
  border: 1px solid #3370ff;
  border-radius: 4px;
  cursor: pointer;
}

.copy-btn:hover {
  background: rgba(51, 112, 255, 0.06);
}

.download-link {
  display: inline-block;
  padding: 6px 16px;
  font-size: 13px;
  color: #fff;
  background: #3370ff;
  border-radius: 4px;
  text-decoration: none;
}

.download-link:hover {
  background: #2b5fd9;
}
</style>
