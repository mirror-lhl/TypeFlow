import { BrowserWindow, ipcMain } from 'electron'
import { CHANNELS } from './ipc-channels'
import { dirname, basename } from 'node:path'
import { messages } from '../shared/i18n'

/**
 * 窗口级副状态（标题栏代理图标、编辑标记、当前文件）集中在此。
 *
 * 独立成模块而非塞进 index.ts，是为了让 file-io / menu 能够取到窗口
 * 而不反向 import 主入口，避免形成 require 环。
 */

let currentFilePath: string | null = null
let documentDirty = false

/** 兼容取窗：优先当前聚焦窗口，退化到第一个可用窗口。 */
export function resolveActiveWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const [first] = BrowserWindow.getAllWindows()
  return first && !first.isDestroyed() ? first : undefined
}

export function setCurrentFilePath(filePath: string | null): void {
  currentFilePath = filePath
  const window = resolveActiveWindow()
  if (!window) return

  if (process.platform === 'darwin') {
    window.setRepresentedFilename(filePath ?? '')
    window.setDocumentEdited(false)
  }

  // 未命名文档的标题必须走 i18n：硬编码会在英文界面留下中文窗口标题
  const name = filePath ? basename(filePath) : messages().app.untitled
  window.setTitle(`${name} — TypeFlow`)
}

export function getCurrentFilePath(): string | null {
  return currentFilePath
}

/** 关闭窗口前的守卫需要知道渲染层是否有未保存内容。 */
export function isDocumentDirty(): boolean {
  return documentDirty
}

/** 未命名文档的另存为默认目录：落在文档目录而非进程 cwd，减少用户跳转。 */
export function defaultSaveDirectory(): string {
  return currentFilePath ? dirname(currentFilePath) : ''
}

export function handleDocumentEdited(_event: Electron.IpcMainEvent, edited: boolean): void {
  documentDirty = edited
  const window = resolveActiveWindow()
  if (!window) return

  if (process.platform === 'darwin') {
    window.setDocumentEdited(edited)
  } else {
    // 非 macOS 平台没有原生编辑点，用窗口标题上的 ● 提示未保存
    const name = currentFilePath ? basename(currentFilePath) : messages().app.untitled
    window.setTitle(`${edited ? '● ' : ''}${name} — TypeFlow`)
  }
}

export function handleRepresentedFilename(
  _event: Electron.IpcMainEvent,
  filePath: string | null
): void {
  setCurrentFilePath(filePath)
}

export function registerWindowStateHandlers(): void {
  ipcMain.on(CHANNELS.windowDocumentEdited, handleDocumentEdited)
  ipcMain.on(CHANNELS.windowRepresentedFilename, handleRepresentedFilename)
  ipcMain.on(CHANNELS.windowDirtyChange, (_event, dirty: boolean) => {
    documentDirty = dirty
    handleDocumentEdited(_event, dirty)
  })
}
