import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type { UpdateState } from '../shared/ipc'

/**
 * 自动更新（L5）。
 *
 * 这是本项目**唯一的运行时第三方依赖**——其余所有第三方包都由 Vite 打进
 * renderer bundle，运行时不需要。因此 electron-builder 的依赖分析只需处理
 * electron-updater 这一棵树（连同它的 8 个传递依赖）。
 *
 * 设计要点：
 *
 * 1. **开发期完全禁用。** 未打包时 `app.isPackaged` 为 false，
 *    electron-updater 会去读不存在的 `app-update.yml` 并报错。
 *    所有更新逻辑都必须在打包后才生效。
 *
 * 2. **绝不打扰用户。** 检查到新版本不弹窗、不阻塞启动，只在状态栏提示；
 *    由用户决定何时下载与重启。编辑器最忌讳"正在写东西时被重启更新打断"。
 *
 * 3. **失败静默。** 更新服务器不可达（离线、内网、服务未部署）是最常见的情况，
 *    不能因此报错或影响正常使用。
 */

/** 更新状态变化时广播给渲染层。 */
let currentState: UpdateState = { status: 'idle' }

function broadcast(state: UpdateState): void {
  currentState = state
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateStateChanged, state)
  }
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(CHANNELS.updateGetState, () => currentState)

  ipcMain.handle(CHANNELS.updateCheck, async () => {
    return checkForUpdates()
  })

  ipcMain.handle(CHANNELS.updateDownload, async () => {
    return downloadUpdate()
  })

  ipcMain.handle(CHANNELS.updateInstall, () => {
    installUpdate()
  })
}

/**
 * 更新配置文件是否存在。
 *
 * electron-builder 只在**可发布的目标**（dmg / zip / nsis / AppImage…）里生成
 * `app-update.yml`。`dir` 目标（本地快速验证用）不会生成它。
 *
 * 若缺少该文件仍去调用 electron-updater，它会抛出原始的
 * `ENOENT: no such file or directory, open '.../app-update.yml'`——
 * 用户看到的是文件系统错误，完全无法理解发生了什么。
 * 因此先检查再决定，把这个情况归入"更新不可用"并给出可读原因。
 *
 * 这个问题**只在打包产物上才会出现**：开发态 `app.isPackaged` 为 false，
 * 根本不会走到这里。
 */
function updateConfigPath(): string {
  return join(process.resourcesPath, 'app-update.yml')
}

function hasUpdateConfig(): boolean {
  try {
    return existsSync(updateConfigPath())
  } catch {
    return false
  }
}

/**
 * 惰性加载 electron-updater。
 *
 * 用动态 import 而非顶层 import 有两个好处：
 *  - 不满足条件时不加载该模块，启动路径更短
 *  - 该模块在初始化时会读配置文件，跳过加载就避免了它抛错
 */
async function loadUpdater(): Promise<typeof import('electron-updater').autoUpdater | null> {
  // App Store 版不允许自带更新器：更新统一由商店分发
  if (process.mas === true) return null
  if (!app.isPackaged) return null
  if (!hasUpdateConfig()) return null

  try {
    const module = await import('electron-updater')
    // 自动下载交给用户决定：只在用户点"下载"后才开始
    module.autoUpdater.autoDownload = false
    module.autoUpdater.autoInstallOnAppQuit = true
    return module.autoUpdater
  } catch {
    return null
  }
}

/** 更新不可用时的可读原因，用于区分"开发态"与"该构建未含更新配置"。 */
function unavailableReason(): string {
  if (process.mas === true) return 'App Store 版由 App Store 统一更新'
  if (!app.isPackaged) return '开发模式不支持自动更新'
  if (!hasUpdateConfig()) return '该构建未包含更新配置（需使用 dmg / zip 等可发布目标打包）'
  return '自动更新模块不可用'
}

async function checkForUpdates(): Promise<UpdateState> {
  const updater = await loadUpdater()
  if (!updater) {
    broadcast({ status: 'unavailable', message: unavailableReason() })
    return currentState
  }

  broadcast({ status: 'checking' })

  try {
    const result = await updater.checkForUpdates()
    if (!result || !result.updateInfo) {
      broadcast({ status: 'up-to-date', version: app.getVersion() })
      return currentState
    }

    const latest = result.updateInfo.version
    if (latest === app.getVersion()) {
      broadcast({ status: 'up-to-date', version: app.getVersion() })
      return currentState
    }

    broadcast({ status: 'available', version: latest })
    return currentState
  } catch (error) {
    // 离线、服务器未部署、证书问题都会走到这里——静默处理，不打扰用户
    broadcast({
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
    return currentState
  }
}

async function downloadUpdate(): Promise<UpdateState> {
  const updater = await loadUpdater()
  if (!updater) return currentState

  broadcast({ status: 'downloading', percent: 0 })

  try {
    updater.on('download-progress', (progress: { percent: number }) => {
      broadcast({ status: 'downloading', percent: Math.round(progress.percent) })
    })

    await updater.downloadUpdate()
    broadcast({ status: 'downloaded' })
  } catch (error) {
    broadcast({
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }

  return currentState
}

function installUpdate(): void {
  if (!app.isPackaged) return
  void import('electron-updater')
    .then((module) => {
      // 交给 electron-updater 处理退出与重启
      module.autoUpdater.quitAndInstall()
    })
    .catch(() => undefined)
}

/**
 * 启动后延迟自动检查。
 *
 * 延迟而非立即执行：启动瞬间用户最关注"窗口是否出现"，
 * 此时发起网络请求、读配置文件只会拖慢首屏，且更新结果也没人看。
 */
export function scheduleStartupUpdateCheck(delayMs = 15_000): void {
  if (process.mas === true || !app.isPackaged || !hasUpdateConfig()) return
  const timer = setTimeout(() => {
    void checkForUpdates()
  }, delayMs)
  // 不阻止进程退出
  timer.unref?.()
}
