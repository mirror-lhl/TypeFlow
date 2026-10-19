import { app, BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type { AppPreferences, RecentDocument } from '../shared/ipc'

const MAX_RECENT = 12

const DEFAULTS: AppPreferences = {
  recent: [],
  lastDirectory: null,
  locale: null
}

/**
 * 偏好持久化：L0 用 JSON 文件即可，量级极小。
 * 写入走"串行队列 + 临时文件 rename"，避免连打快捷键时并发写坏文件。
 */
function settingsPath(): string {
  return join(app.getPath('userData'), 'typeflow-preferences.json')
}

let cache: AppPreferences | null = null
let writeChain: Promise<void> = Promise.resolve()

async function load(): Promise<AppPreferences> {
  if (cache) return cache
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppPreferences>
    cache = {
      recent: Array.isArray(parsed.recent) ? parsed.recent.filter(isRecentDocument) : [],
      lastDirectory: typeof parsed.lastDirectory === 'string' ? parsed.lastDirectory : null,
      locale: typeof parsed.locale === 'string' ? parsed.locale : null
    }
  } catch {
    // 首次启动、文件损坏、权限不足都退化到默认值：偏好丢失不应阻断启动
    cache = { ...DEFAULTS }
  }
  return cache
}

function isRecentDocument(value: unknown): value is RecentDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.filePath === 'string' && typeof candidate.fileName === 'string'
}

/**
 * 偏好变更订阅。
 *
 * 用订阅而非直接调用菜单模块，是为了避免 preferences ↔ menu 形成 require 环
 * （menu 需要读偏好来构建"最近打开"子菜单）。由主入口在装配阶段完成接线。
 */
type PreferencesListener = (preferences: AppPreferences) => void
const preferencesListeners = new Set<PreferencesListener>()

export function onPreferencesChanged(listener: PreferencesListener): () => void {
  preferencesListeners.add(listener)
  return () => {
    preferencesListeners.delete(listener)
  }
}

/**
 * 偏好变更后的统一广播。
 *
 * 集中在这里，是为了让"最近文件"菜单与渲染层永不过期——
 * 任何写入点都不必记得手动刷新，也就不会漏。
 */
function broadcastPreferences(): void {
  const snapshot = cache
  if (!snapshot) return

  const payload: AppPreferences = {
    recent: [...snapshot.recent],
    lastDirectory: snapshot.lastDirectory,
    locale: snapshot.locale
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.prefsChanged, payload)
  }

  for (const listener of preferencesListeners) listener(payload)
}

function persist(): void {
  const snapshot = cache
  if (!snapshot) return

  writeChain = writeChain
    .then(async () => {
      const target = settingsPath()
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.tmp`
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
      const { rename } = await import('node:fs/promises')
      await rename(temporary, target)
    })
    .catch((error: unknown) => {
      console.warn('[typeflow] 偏好写入失败:', error)
    })
}

export async function getPreferences(): Promise<AppPreferences> {
  const preferences = await load()
  return {
    recent: [...preferences.recent],
    lastDirectory: preferences.lastDirectory,
    locale: preferences.locale
  }
}

/** 设置界面语言；null 表示跟随系统。 */
export async function setLocale(locale: string | null): Promise<AppPreferences> {
  const preferences = await load()
  preferences.locale = locale
  persist()
  broadcastPreferences()
  return {
    recent: [...preferences.recent],
    lastDirectory: preferences.lastDirectory,
    locale
  }
}

export async function addRecentFile(filePath: string): Promise<AppPreferences> {
  const preferences = await load()
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  const entry: RecentDocument = { filePath, fileName, openedAt: Date.now() }

  // 同一文件的重复打开只更新时间戳并置顶，不产生重复条目
  preferences.recent = [entry, ...preferences.recent.filter((item) => item.filePath !== filePath)].slice(
    0,
    MAX_RECENT
  )
  persist()
  broadcastPreferences()
  return { recent: [...preferences.recent], lastDirectory: preferences.lastDirectory, locale: preferences.locale }
}

export async function clearRecentFiles(): Promise<AppPreferences> {
  const preferences = await load()
  preferences.recent = []
  persist()
  broadcastPreferences()
  return { recent: [], lastDirectory: preferences.lastDirectory, locale: preferences.locale }
}

export async function rememberDirectory(directory: string): Promise<AppPreferences> {
  const preferences = await load()
  preferences.lastDirectory = directory
  persist()
  broadcastPreferences()
  return { recent: [...preferences.recent], lastDirectory: directory, locale: preferences.locale }
}
