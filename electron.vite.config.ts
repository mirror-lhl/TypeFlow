import { defineConfig } from 'electron-vite'
import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * 构建配置。
 *
 * 关键点：三个 target 各自 emptyOutDir，避免"旧 hash bundle 残留导致
 * index.html 指向陈旧产物"这类极难排查的问题（自检时真实遇到过）。
 * 每个 outDir 互不重叠，因此并发清空不会互相影响。
 */

/**
 * 把 pdf.js 的运行期二进制资源复制进渲染产物。
 *
 * cMap 与标准字体不是 JS 模块，Vite 不会打包它们；而渲染层由 `file://` 加载，
 * `fetch` 本地文件既受 CSP `connect-src 'self'` 限制也不被 Chromium 的 file
 * 访问策略允许。因此复制成静态文件，由主进程按名读取（见 `main/viewer-resources.ts`）。
 *
 * 只挂在 renderer 上：它的 `emptyOutDir` 会清空 `out/renderer`，
 * 挂在 main 上先复制的副本会被随后清掉。开发期不构建 renderer 到磁盘，
 * 那时主进程直接读 `node_modules/pdfjs-dist`。
 */
function copyPdfResources(): Plugin {
  const directories = ['cmaps', 'standard_fonts']

  /**
   * `useWasm: false` 时 pdf.js 会 `import(`${wasmUrl}openjpeg_nowasm_fallback.js`)`
   * 取纯 JS 解码器（JPEG2000 / JBIG2）。这两个文件在包里但不在 wasm 目录之外的
   * 任何位置，因此必须一并复制，否则动态 import 404、解码器为 null。
   * `.wasm` 二进制刻意不复制：`WebAssembly.instantiate` 需要 CSP `wasm-unsafe-eval`，
   * 复制了也用不上，只会诱使后来者去放宽 CSP。许可证随代码一起分发。
   */
  const wasmFallbacks = [
    'openjpeg_nowasm_fallback.js',
    'jbig2_nowasm_fallback.js',
    'LICENSE_OPENJPEG',
    'LICENSE_JBIG2',
    'LICENSE_PDFJS_OPENJPEG',
    'LICENSE_PDFJS_JBIG2'
  ]

  return {
    name: 'typeflow:copy-pdf-resources',
    apply: 'build',
    writeBundle(): void {
      for (const directory of directories) {
        cpSync(
          resolve(__dirname, 'node_modules/pdfjs-dist', directory),
          resolve(__dirname, 'out/renderer/pdfjs', directory),
          { recursive: true }
        )
      }
      for (const file of wasmFallbacks) {
        cpSync(
          resolve(__dirname, 'node_modules/pdfjs-dist/wasm', file),
          resolve(__dirname, 'out/renderer/pdfjs/wasm', file)
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: '.',
    base: './',
    plugins: [copyPdfResources()],
    build: {
      outDir: 'out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    }
  }
})
