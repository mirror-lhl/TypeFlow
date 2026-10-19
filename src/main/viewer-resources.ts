import { app, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNELS } from './ipc-channels'

/**
 * PDF 查看器的运行期资源通道。
 *
 * pdf.js 解析 PDF 时会按需索取两类二进制数据：
 *  - **cMap**：把 CID 字体的字符码映射到字形，缺了它中文 PDF 会整页渲染失败
 *  - **标准字体**：PDF 未内嵌 Base-14 字体时的兜底字形
 *
 * 这两类数据在 pdf.js 里默认走 `fetch(cMapUrl + name)`。本项目的渲染层由
 * `file://` 加载，`fetch` 本地文件既受 CSP `connect-src 'self'` 限制、
 * 也不受 Chromium 的 file 访问策略欢迎，因此**不走网络**：改由主进程按名读取。
 *
 * 刻意只接受白名单目录下的单段文件名，而不是任意相对路径——
 * 资源名来自 PDF 内容解析结果，不该被当成路径使用。
 */

const ALLOWED_ROOTS = ['cmaps', 'standard_fonts'] as const

const MAX_RESOURCE_BYTES = 4 * 1024 * 1024

function resourceRoot(): string {
  // 打包后由 electron.vite.config.ts 的复制插件放进 out/renderer/pdfjs；
  // 开发期直接读依赖目录，省掉"跑 dev 前必须先构建一次资源"这一步
  return app.isPackaged
    ? join(__dirname, '../renderer/pdfjs')
    : join(app.getAppPath(), 'node_modules', 'pdfjs-dist')
}

export function registerViewerResourceHandlers(): void {
  ipcMain.handle(
    CHANNELS.viewerReadPdfResource,
    async (_event, relativePath: string): Promise<ArrayBuffer | null> => {
      if (typeof relativePath !== 'string') return null

      const root = ALLOWED_ROOTS.find((allowed) => relativePath.startsWith(`${allowed}/`))
      if (!root) return null

      const name = relativePath.slice(root.length + 1)
      if (name.length === 0 || /[\\/]|\.\./.test(name)) return null

      try {
        const buffer = await readFile(join(resourceRoot(), root, name))
        if (buffer.byteLength > MAX_RESOURCE_BYTES) return null
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer
      } catch {
        return null
      }
    }
  )

  /**
   * `useWasm: false` 时 pdf.js 改用纯 JS 解码器，取法是
   * `import(`${wasmUrl}openjpeg_nowasm_fallback.js`)`——动态 import 走不了上面的
   * 读取通道（它要的是一个能当模块加载的 URL），因此单独给出目录 URL。
   *
   * 目录里只有 `*_nowasm_fallback.js` 与其许可证，没有 `.wasm`：
   * 真要用 wasm 就得给 CSP 加 `wasm-unsafe-eval`，那与"不放宽安全基线"冲突。
   * 渲染层由 `file://` 加载时该 URL 落在 `script-src 'self'` 内；
   * 开发期页面来自 dev server，跨源取不到，此时解码器为 null（仅影响开发模式）。
   */
  ipcMain.handle(CHANNELS.viewerPdfWasmUrl, (): string => {
    const url = pathToFileURL(join(resourceRoot(), 'wasm')).href
    return url.endsWith('/') ? url : `${url}/`
  })
}
