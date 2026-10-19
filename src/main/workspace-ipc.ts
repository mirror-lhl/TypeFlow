import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from './ipc-channels'
import type { SearchResult, WorkspaceChangeEvent, WorkspaceTree } from '../shared/ipc'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  readWorkspaceTree,
  renameWorkspaceEntry,
  searchWorkspace,
  startWatching,
  stopWatching
} from './workspace'
import { getPreferences, rememberDirectory } from './preferences'
import { hasAccess, isMasBuild, rememberBookmark } from './mas-access'
import { resolveActiveWindow } from './window-state'
import { messages } from '../shared/i18n'

/**
 * 工作区 IPC。
 *
 * 所有文件操作都在主进程做路径校验（`assertInsideWorkspace`），
 * 渲染层即使被注入也无法借这些通道读写工作区之外的位置——
 * 这是把文件系统能力交给渲染层时不可省略的一道边界。
 */

/** 当前被监听的工作区，避免重复监听与泄漏 FSWatcher。 */
let watchedWorkspace: string | null = null

function broadcastWorkspaceChange(event: WorkspaceChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.workspaceChanged, event)
  }
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(CHANNELS.workspaceChooseDirectory, async (): Promise<string | null> => {
    const window = resolveActiveWindow()
    const preferences = await getPreferences()

    const result = await dialog.showOpenDialog(window as Electron.BrowserWindow, {
      title: messages().dialog.chooseWorkspace,
      defaultPath: preferences.lastDirectory ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: true
    })

    if (result.canceled || result.filePaths.length === 0) return null
    const directory = result.filePaths[0]
    await rememberBookmark(directory, result.bookmarks?.[0], true)
    await rememberDirectory(directory)
    return directory
  })

  ipcMain.handle(
    CHANNELS.workspaceReadTree,
    async (_event, workspacePath: string): Promise<WorkspaceTree> => {
      // 沙箱下重启后工作区访问靠恢复的目录书签；失效时给出可读报错而非空树
      if (isMasBuild() && !hasAccess(workspacePath)) {
        throw new Error(messages().error.sandboxAccessLost)
      }
      return readWorkspaceTree(workspacePath)
    }
  )

  ipcMain.handle(
    CHANNELS.workspaceCreateFile,
    async (_event, workspacePath: string, targetPath: string, content?: string) => {
      await createWorkspaceFile(workspacePath, targetPath, content ?? '')
    }
  )

  ipcMain.handle(
    CHANNELS.workspaceCreateDirectory,
    async (_event, workspacePath: string, targetPath: string) => {
      await createWorkspaceDirectory(workspacePath, targetPath)
    }
  )

  ipcMain.handle(
    CHANNELS.workspaceRename,
    async (_event, workspacePath: string, fromPath: string, toPath: string) => {
      await renameWorkspaceEntry(workspacePath, fromPath, toPath)
    }
  )

  ipcMain.handle(
    CHANNELS.workspaceRemove,
    async (_event, workspacePath: string, targetPath: string) => {
      await deleteWorkspaceEntry(workspacePath, targetPath)
    }
  )

  ipcMain.handle(
    CHANNELS.workspaceSearch,
    async (
      _event,
      workspacePath: string,
      query: string,
      caseSensitive?: boolean
    ): Promise<SearchResult> => {
      return searchWorkspace(workspacePath, query, caseSensitive ?? false)
    }
  )

  ipcMain.handle(CHANNELS.workspaceWatch, (_event, workspacePath: string) => {
    if (watchedWorkspace === workspacePath) return
    if (watchedWorkspace) stopWatching(watchedWorkspace)

    watchedWorkspace = workspacePath
    startWatching(workspacePath, broadcastWorkspaceChange)
  })

  ipcMain.handle(CHANNELS.workspaceUnwatch, () => {
    if (!watchedWorkspace) return
    stopWatching(watchedWorkspace)
    watchedWorkspace = null
  })
}

export function stopWorkspaceWatching(): void {
  if (!watchedWorkspace) return
  stopWatching(watchedWorkspace)
  watchedWorkspace = null
}
