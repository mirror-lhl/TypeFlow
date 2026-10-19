import { app, dialog } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { resolveActiveWindow } from './window-state'
import { messages } from '../shared/i18n'

/**
 * Mac App Store 沙箱授权（security-scoped bookmarks）。
 *
 * 商店版强制运行在 App Sandbox 下：除用户当次通过系统对话框选中的文件外，
 * 进程对文件系统没有任何默认权限。而 TypeFlow 的若干核心能力恰恰需要
 * "对话框之外"的访问：
 *  - 启动时重开最近文档（用户这次没有选它）
 *  - 图片写入文档同目录的 assets/（用户选中的是文档文件，不是目录）
 *  - 工作区目录树 / 搜索 / 监听（重启后仍需保留）
 *
 * 解法是苹果提供的安全作用域书签：对话框授权时把授权序列化为 bookmark
 * 持久化，下次启动用它恢复访问。本模块只在 MAS 构建生效
 * （`process.mas === true`），站外构建行为完全不变。
 */

interface BookmarkRecord {
  path: string
  bookmark: string
  directory: boolean
  addedAt: number
}

let records: BookmarkRecord[] | null = null
/** 路径 → 停止访问的回调；存在即代表该授权当前处于激活状态。 */
const activeStops = new Map<string, () => void>()
let writeChain: Promise<void> = Promise.resolve()

export function isMasBuild(): boolean {
  return process.mas === true
}

function storePath(): string {
  return join(app.getPath('userData'), 'typeflow-bookmarks.json')
}

async function load(): Promise<BookmarkRecord[]> {
  if (records) return records
  try {
    const raw = await readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as { bookmarks?: unknown }
    const list = Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
    records = list.filter(
      (item): item is BookmarkRecord =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as BookmarkRecord).path === 'string' &&
        typeof (item as BookmarkRecord).bookmark === 'string' &&
        typeof (item as BookmarkRecord).directory === 'boolean'
    )
  } catch {
    // 首次启动 / 文件损坏：无授权可用，不应阻断启动
    records = []
  }
  return records
}

function persist(): void {
  const snapshot = records
  if (!snapshot) return
  writeChain = writeChain
    .then(async () => {
      const target = storePath()
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.tmp`
      await writeFile(temporary, JSON.stringify({ bookmarks: snapshot }, null, 2), 'utf8')
      await rename(temporary, target)
    })
    .catch((error: unknown) => {
      console.warn('[typeflow] 书签写入失败:', error)
    })
}

function startAccess(record: BookmarkRecord): boolean {
  if (activeStops.has(record.path)) return true
  try {
    const stop = app.startAccessingSecurityScopedResource(record.bookmark) as () => void
    activeStops.set(record.path, stop)
    return true
  } catch (error) {
    // 书签失效（文件被移动、系统重置授权等）：放弃该条，不影响其它授权
    console.warn('[typeflow] 书签恢复失败:', record.path, error)
    return false
  }
}

/** 启动时恢复全部持久化授权；失效书签被剔除。 */
export async function restoreBookmarks(): Promise<void> {
  if (!isMasBuild()) return
  const list = await load()
  const kept = list.filter((record) => startAccess(record))
  if (kept.length !== list.length) {
    records = kept
    persist()
  }
}

/** 对话框授权后登记书签；非 MAS 构建或无书签数据时为无操作。 */
export async function rememberBookmark(
  targetPath: string,
  bookmark: string | null | undefined,
  directory: boolean
): Promise<void> {
  if (!isMasBuild() || !bookmark) return
  const list = await load()
  const record: BookmarkRecord = {
    path: resolve(targetPath),
    bookmark,
    directory,
    addedAt: Date.now()
  }
  records = [record, ...list.filter((item) => item.path !== record.path)]
  startAccess(record)
  persist()
}

/**
 * 路径是否已被某个激活授权覆盖。
 * 目录授权覆盖其全部子路径；文件授权只覆盖它自身。
 */
export function hasAccess(targetPath: string): boolean {
  if (!isMasBuild()) return true
  // 自检模式：无真实沙箱执行，合成事件也拿不到真实书签数据，
  // 若不放行，每次写操作都会弹无人点击的系统对话框导致自检挂起
  if (process.env.ELECTRON_SMOKE_TEST === '1') return true
  const target = resolve(targetPath)
  for (const record of records ?? []) {
    if (!activeStops.has(record.path)) continue
    if (record.directory) {
      if (target === record.path || target.startsWith(record.path + sep)) return true
    } else if (target === record.path) {
      return true
    }
  }
  return false
}

/** 读路径无授权时的统一报错：引导用户经系统对话框重新授权。 */
export function assertReadAccess(targetPath: string): void {
  if (hasAccess(targetPath)) return
  throw new Error(messages().error.sandboxAccessLost)
}

/**
 * 写路径无授权时，弹系统目录对话框请求授权（例如图片要写进文档旁 assets/）。
 * 用户取消或选错目录时返回 false，由调用方给出可读错误。
 */
export async function requestDirectoryAccess(directoryPath: string): Promise<boolean> {
  if (!isMasBuild()) return true
  if (hasAccess(directoryPath)) return true

  const window = resolveActiveWindow()
  const result = await dialog.showOpenDialog(window as Electron.BrowserWindow, {
    title: messages().dialog.grantFolderAccess,
    message: messages().dialog.grantFolderAccessMessage,
    defaultPath: resolve(directoryPath),
    properties: ['openDirectory'],
    securityScopedBookmarks: true
  })

  if (result.canceled || result.filePaths.length === 0) return false
  const chosen = result.filePaths[0]
  await rememberBookmark(chosen, result.bookmarks?.[0], true)
  return hasAccess(directoryPath)
}

/** 写操作前的统一把关：已有授权直接放行，否则尝试请求目录授权。 */
export async function ensureWriteAccess(targetPath: string): Promise<void> {
  if (hasAccess(targetPath)) return
  const granted = await requestDirectoryAccess(dirname(targetPath))
  if (!granted) throw new Error(messages().error.sandboxAccessLost)
}

/** 退出时释放全部安全作用域授权。 */
export function stopAllBookmarks(): void {
  for (const stop of activeStops.values()) {
    try {
      stop()
    } catch {
      // 释放失败无需处理：进程即将退出
    }
  }
  activeStops.clear()
}
