import vue from '@vitejs/plugin-vue'
import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// Serve the installed PDF.js assets locally in development and ship the same files in dist.
function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const folders = ['cmaps', 'standard_fonts']
  return {
    name: 'local-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts)\/([A-Za-z0-9_-]+\.(?:bcmap|ttf|pfb))$/.exec((request.url ?? '').split('?')[0] ?? '')
        if (!match) { next(); return }
        const stream = createReadStream(join(root, match[1]!, match[2]!))
        stream.on('error', () => { response.statusCode = 404; response.end() })
        response.setHeader('Content-Type', 'application/octet-stream')
        stream.pipe(response)
      })
    },
    generateBundle() {
      for (const folder of folders) for (const file of readdirSync(join(root, folder))) {
        if (!/\.(bcmap|ttf|pfb)$/.test(file) && !file.startsWith('LICENSE')) continue
        this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${file}`, source: readFileSync(join(root, folder, file)) })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), pdfAssets()],
  server: {
    proxy: {
      // 前端 5173 → 后端 8740，浏览器同源访问 /api
      '/api': {
        target: 'http://127.0.0.1:8740',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
  },
})
