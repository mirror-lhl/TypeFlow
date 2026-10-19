import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type { ExportPdfRequest, ExportRequest, ExportResult } from '../shared/ipc'
import { resolveActiveWindow } from './window-state'
import { rememberDirectory } from './preferences'
import { rememberBookmark } from './mas-access'
import { messages } from '../shared/i18n'

/**
 * 导出能力（L4）。
 *
 * Electron 在这里相对 Tauri 有决定性优势：**内置 `webContents.printToPDF`**，
 * 不需要捆绑 headless Chromium，也不需要外部 wkhtmltopdf。
 *
 * 实现方式是"隐藏窗口渲染"而非"对当前窗口打印"：
 *  - 当前窗口带有编辑器 UI（工具栏、状态栏、侧边栏），打印它需要大量
 *    `@media print` 特例，而且用户看到的预览与实际输出容易不一致
 *  - 隐藏窗口只加载导出用的 HTML，输出与预览天然一致
 */

/** 导出窗口的等待上限：超时说明 HTML 或资源有问题，不能无限等下去。 */
const RENDER_TIMEOUT_MS = 20_000

/**
 * PDF 页面参数。
 *
 * 页边距用厘米而非"minimal"：中文正文需要相对宽裕的页边，
 * 否则段落紧贴页边在纸质阅读下很难受。
 */
const PDF_OPTIONS = {
  printBackground: true,
  margins: {
    top: 0.8,
    bottom: 0.8,
    left: 0.8,
    right: 0.8
  },
  pageSize: 'A4'
} as const

/**
 * 在隐藏窗口里渲染 HTML 并等待其完成加载。
 *
 * `backgroundThrottling: false` 必须显式关闭：隐藏窗口会被 Chromium
 * 降频，字体加载与布局可能迟迟不完成，表现为导出超时。
 */
async function renderHtmlToWindow(html: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true
    }
  })

  const loaded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`渲染导出内容超时（${RENDER_TIMEOUT_MS / 1000}s）`))
    }, RENDER_TIMEOUT_MS)

    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer)
      reject(new Error(`导出内容加载失败：${description}（${code}）`))
    })
  })

  // data URL 而非临时文件：无需处理清理，也不会在工作区留下残留文件
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await loaded

  // 给字体与布局留出一个稳定化的窗口期。
  // 中文字体加载是异步的，did-finish-load 时字形可能还没就位，
  // 直接打印会得到缺字或错位的 PDF。
  await new Promise((resolve) => setTimeout(resolve, 250))

  return window
}

/** 弹保存对话框；取消时返回 null。 */
async function askExportPath(
  suggestedName: string,
  formatName: string,
  extension: string
): Promise<string | null> {
  const window = resolveActiveWindow()
  const chosen = await dialog.showSaveDialog(window as Electron.BrowserWindow, {
    title: `导出 ${formatName}`,
    defaultPath: suggestedName,
    securityScopedBookmarks: true,
    filters: [{ name: formatName, extensions: [extension] }]
  })

  if (chosen.canceled || !chosen.filePath) return null
  await rememberBookmark(chosen.filePath, chosen.bookmark, false)
  return chosen.filePath
}

export function registerExportHandlers(): void {
  /* ---------------------------- HTML ---------------------------- */

  ipcMain.handle(
    CHANNELS.exportHtml,
    async (_event, request: ExportRequest): Promise<ExportResult> => {
      const filePath = request.targetPath ?? (await askExportPath(request.suggestedName, 'HTML', 'html'))
      if (!filePath) return { canceled: true, filePath: null }

      await writeFile(filePath, request.html, 'utf8')
      await rememberDirectory(dirname(filePath))
      return { canceled: false, filePath }
    }
  )

  /* ---------------------------- PDF ----------------------------- */

  ipcMain.handle(
    CHANNELS.exportPdf,
    async (_event, request: ExportPdfRequest): Promise<ExportResult> => {
      const filePath = request.targetPath ?? (await askExportPath(request.suggestedName, 'PDF', 'pdf'))
      if (!filePath) return { canceled: true, filePath: null }

      const renderWindow = await renderHtmlToWindow(request.html)
      try {
        const data = await renderWindow.webContents.printToPDF({
          ...PDF_OPTIONS,
          ...(request.landscape ? { landscape: true } : {}),
          ...(request.pageSize ? { pageSize: request.pageSize } : {})
        })
        await writeFile(filePath, data)
        await rememberDirectory(dirname(filePath))
        return { canceled: false, filePath, byteLength: data.byteLength }
      } finally {
        // 无论成功失败都要销毁隐藏窗口，否则会持续占用内存
        if (!renderWindow.isDestroyed()) renderWindow.destroy()
      }
    }
  )

  /* ------------------------- 自定义主题 CSS ------------------------- */

  ipcMain.handle(CHANNELS.themeChooseCss, async (): Promise<{ path: string; css: string } | null> => {
    const window = resolveActiveWindow()
    const chosen = await dialog.showOpenDialog(window as Electron.BrowserWindow, {
      title: messages().dialog.chooseThemeCss,
      properties: ['openFile'],
      securityScopedBookmarks: true,
      filters: [{ name: 'CSS', extensions: ['css'] }]
    })

    if (chosen.canceled || chosen.filePaths.length === 0) return null

    const filePath = chosen.filePaths[0]
    await rememberBookmark(filePath, chosen.bookmarks?.[0], false)
    const css = await readFile(filePath, 'utf8')
    return { path: filePath, css }
  })

  ipcMain.handle(CHANNELS.themeReadCss, async (_event, filePath: string): Promise<string | null> => {
    try {
      return await readFile(filePath, 'utf8')
    } catch {
      // 主题文件被移动或删除时返回 null，由渲染层回退到内置主题
      return null
    }
  })
}
