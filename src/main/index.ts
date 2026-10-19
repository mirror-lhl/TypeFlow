import { Menu, app, BrowserWindow, ipcMain, screen, shell, type BrowserWindow as BW } from 'electron'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CHANNELS } from './ipc-channels'
import { installApplicationMenu, installRecentFilesMenu } from './menu'
import { registerFileHandlers } from './file-io'
import { registerWindowStateHandlers } from './window-state'
import { installCloseGuard, registerCloseGuardHandler } from './close-guard'
import { registerWorkspaceHandlers, stopWorkspaceWatching } from './workspace-ipc'
import { registerAssetHandlers } from './asset-io'
import { registerViewerResourceHandlers } from './viewer-resources'
import { registerExportHandlers } from './export-ipc'
import { restoreBookmarks, stopAllBookmarks } from './mas-access'
import { registerUpdateHandlers } from './auto-update'
import {
  addRecentFile,
  clearRecentFiles,
  getPreferences,
  onPreferencesChanged,
  rememberDirectory,
  setLocale as persistLocale
} from './preferences'
import { normalizeLocale, setLocale as applyLocale } from '../shared/i18n'

/**
 * L0 硬性安全基线：
 *  1. 渲染进程始终沙箱化，nodeIntegration 恒为 false
 *  2. 导航与新窗口一律拒绝，只允许 https 外链交给系统浏览器
 *  3. preload 只经 contextBridge 暴露白名单能力，不泄露 ipcRenderer 本体
 *
 * 首屏只加载渲染进程；编辑内核在 L1 以独立模块接入，届时替换 renderer 层即可，
 * 主进程与 preload 的契约保持不变。
 */
const isDev = !app.isPackaged

/**
 * 自检模式：由 scripts/smoke-launch.mjs 注入。
 * 渲染层完成端到端断言后回报结果，主进程据此定退出码。
 * 生产环境完全不受影响（无该环境变量时所有分支都不进入）。
 */
const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === '1'

/**
 * 商店截图模式：由 scripts/capture-screenshots.mjs 注入。
 * 渲染层铺好演示文档后回报，主进程按商店尺寸抓图并退出。
 */
const isScreenshot = process.env.ELECTRON_SCREENSHOT === '1'

/**
 * 自检使用隔离的用户数据目录。
 *
 * 必须在 `app.whenReady()` **之前**执行——`userData` 路径决定了
 * localStorage、偏好 JSON、缓存的位置，一旦应用开始读写就改不动了。
 *
 * 为什么必须隔离：自检会切换主题、排版、语言、布局并写入偏好，
 * 如果与正常使用共享目录，跑一次自检就会**污染用户真实配置**。
 * 更隐蔽的是这会形成"自检结果依赖上次自检状态"的循环依赖——
 * 上一轮把主题设成衬线阅读，下一轮就以衬线阅读为初值。
 */
if (isSmokeTest || isScreenshot) {
  const smokeDataDir = mkdtempSync(join(tmpdir(), 'typeflow-userdata-'))
  app.setPath('userData', smokeDataDir)
  app.setPath('sessionData', join(smokeDataDir, 'session'))
}

let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'TypeFlow',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    window.show()
    // 冒烟测试据此确认窗口真正创建成功
    console.log('[typeflow] main window ready')
  })

  window.on('closed', () => {
    mainWindow = null
  })

  // 数据安全：未保存内容在关窗前弹原生确认
  installCloseGuard(window)

  // 标题由 window-state 统一管理，禁止渲染层用 <title> 覆盖
  window.on('page-title-updated', (event) => event.preventDefault())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = window
  return window
}

function registerIpc(): void {
  registerFileHandlers()
  registerWindowStateHandlers()
  registerCloseGuardHandler()
  registerWorkspaceHandlers()
  registerAssetHandlers()
  registerViewerResourceHandlers()
  registerExportHandlers()
  registerUpdateHandlers()

  ipcMain.handle(CHANNELS.prefsGet, () => getPreferences())
  ipcMain.handle(CHANNELS.prefsAddRecent, (_event, filePath: string) => addRecentFile(filePath))
  ipcMain.handle(CHANNELS.prefsClearRecent, () => clearRecentFiles())
  ipcMain.handle(CHANNELS.prefsSetLocale, async (_event, locale: string | null) => {
    const preferences = await persistLocale(locale)
    // 立即生效：语言变化后所有新建的对话框与菜单都用新语言
    applyLocale(normalizeLocale(locale ?? app.getLocale()))
    installApplicationMenu()
    onPreferencesChanged((next) => installRecentFilesMenu(next.recent))
    return preferences
  })
  ipcMain.handle(CHANNELS.prefsRememberDirectory, (_event, directory: string) =>
    rememberDirectory(directory)
  )

  ipcMain.handle(CHANNELS.shellOpenExternal, async (_event, url: string) => {
    if (url.startsWith('https://')) await shell.openExternal(url)
  })

  // 自检回报通道：仅自检模式注册，生产环境不暴露任何退出入口
  if (isSmokeTest) {
    // 判据来自渲染层的显式回执，而非解析 stdout——
    // 渲染进程的 console 输出并不保证映射到父进程 stdout，用它当判据会导致误报
    ipcMain.handle(CHANNELS.smokeMenuLabels, () => {
      const menu = Menu.getApplicationMenu()
      const top = menu?.items.map((item) => item.label) ?? []
      // 第一个子菜单对应"文件"，中英文差异最明显
      const file = menu?.items[0]?.submenu?.items.map((item) => item.label) ?? []
      // 窗口标题由主进程生成（未命名文档取 messages().app.untitled），一并暴露
      const windowTitle = BrowserWindow.getAllWindows()[0]?.getTitle() ?? ''
      return { top, file, windowTitle }
    })

    ipcMain.on(CHANNELS.smokeRendererReady, () => {
      console.log('[typeflow] renderer ready')
    })

    ipcMain.on(
      CHANNELS.smokeTestDone,
      async (_event, details: { checks?: { label: string; ok: boolean; detail: string }[]; failures: number }) => {
        // 把渲染层的断言明细转写到主进程 stdout：渲染进程的 console 不可见于终端
        for (const check of details?.checks ?? []) {
          const mark = check.ok ? '✓' : '✗'
          const detail = check.detail ? ` — ${check.detail}` : ''
          console.log(`[typeflow:smoke] ${mark} ${check.label}${detail}`)
        }

        const failures = details?.failures ?? 1
        console.log(`[typeflow:smoke] 断言 ${details?.checks?.length ?? 0} 项，失败 ${failures} 项`)
        if (failures === 0) console.log('[typeflow] smoke test passed')

        const directory = process.env.ELECTRON_SMOKE_TMPDIR
        if (directory) {
          const { rm } = await import('node:fs/promises')
          await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        }
        app.exit(failures === 0 ? 0 : 1)
      }
    )

    // 渲染层若崩溃导致永远不会回报，兜底退出，避免自检永久挂起
    setTimeout(() => {
      console.error('[typeflow] smoke test timed out')
      app.exit(1)
    }, 30_000).unref()
  }

  if (isScreenshot) {
    ipcMain.on(CHANNELS.screenshotReady, () => {
      void captureScreenshots()
    })
    setTimeout(() => {
      console.error('[typeflow] screenshot timed out')
      app.exit(1)
    }, 60_000).unref()
  }
}

/**
 * 商店截图：等状态栏提示消失后按 Mac App Store 尺寸抓图。
 *
 * 输出两档：窗口物理像素原图（Retina 下为 2880×1800）与 1440×900 缩放图，
 * 覆盖 App Store Connect 接受的 Mac 截图尺寸。
 */
async function captureScreenshots(): Promise<void> {
  const window = mainWindow
  const directory = process.env.ELECTRON_SCREENSHOT_DIR
  if (!window || window.isDestroyed() || !directory) {
    app.exit(1)
    return
  }

  // 状态栏欢迎提示 2600ms 后消失；代码高亮与公式渲染也需要稳定期
  await new Promise((resolve) => setTimeout(resolve, 3200))

  // 商店尺寸必须完整放下内容区：主屏工作区不够时把窗口移到放得下的显示器，
  // 否则 macOS 会把窗口钳制到工作区高度，抓图比例偏离商店要求
  const TITLE_BAR = 28
  const display =
    screen
      .getAllDisplays()
      .find(
        (candidate) =>
          candidate.scaleFactor === 2 &&
          candidate.workArea.width >= 1440 &&
          candidate.workArea.height >= 900 + TITLE_BAR
      ) ??
    screen
      .getAllDisplays()
      .find(
        (candidate) =>
          candidate.workArea.width >= 1440 && candidate.workArea.height >= 900 + TITLE_BAR
      )
  if (display) {
    window.setPosition(display.workArea.x + 16, display.workArea.y + 16)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  // 用内容区尺寸而非窗口尺寸：标题栏高度会让抓图比例偏离商店要求
  window.setContentSize(1440, 900)
  await new Promise((resolve) => setTimeout(resolve, 600))

  const image = await window.webContents.capturePage()
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })

  const size = image.getSize()
  // 英文截图加 -en 后缀，与中文截图共存于同一目录
  const suffix = process.env.ELECTRON_SCREENSHOT_LANG === 'en' ? '-en' : ''
  await writeFile(join(directory, `mac-${size.width}x${size.height}${suffix}.png`), image.toPNG())
  if (size.width !== 1440) {
    const resized = image.resize({ width: 1440, height: 900 })
    await writeFile(join(directory, `mac-1440x900${suffix}.png`), resized.toPNG())
  }

  console.log(`[typeflow] screenshots saved to ${directory}`)
  app.exit(0)
}

/** 供后续级别（文件树、会话恢复）复用的窗口访问器。 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function focusMainWindow(target: BW | null = mainWindow): void {
  if (!target || target.isDestroyed()) return
  if (target.isMinimized()) target.restore()
  target.focus()
}

app.whenReady().then(() => {
  app.setName('TypeFlow')
  // 先用系统语言兜底，偏好读取完成后会覆盖
  applyLocale(normalizeLocale(app.getLocale()))

  // 自检模式下把可写临时目录注入渲染层，用于验证真实落盘
  if (isSmokeTest) {
    // 让 preload 能读到"这是不是商店版构建"：process.mas 只在主进程可用
    process.env.ELECTRON_MAS_BUILD = process.mas === true ? '1' : '0'
    process.env.ELECTRON_SMOKE_TMPDIR = mkdtempSync(join(tmpdir(), 'typeflow-smoke-'))
    console.log(`[typeflow] smoke temp dir: ${process.env.ELECTRON_SMOKE_TMPDIR}`)
  }

  registerIpc()

  // 商店版：恢复持久化的沙箱授权（最近文档、工作区、图片目录）
  void restoreBookmarks()

  // 语言必须在建菜单之前确定：菜单标签在创建时就固化了文案，
  // 之后再切换语言只能靠重建菜单
  void getPreferences().then((preferences) => {
    applyLocale(normalizeLocale(preferences.locale ?? app.getLocale()))
    installApplicationMenu()
    installRecentFilesMenu(preferences.recent)
  })

  onPreferencesChanged((preferences) => {
    applyLocale(normalizeLocale(preferences.locale ?? app.getLocale()))
    /**
     * 菜单标签在 `Menu.buildFromTemplate` 时就被固化成字符串，
     * 因此语言变更后必须重建整份菜单，不能只改拼音字段。
     *
     * `installRecentFilesMenu` 名字像"只更新最近文件子菜单"，实际内部会调用
     * `Menu.setApplicationMenu(buildMenu())` 重建整份菜单——正是这里需要的行为。
     * （我曾以为它只刷新子菜单，额外加了一次 `installApplicationMenu()`，
     * 结果同一次变更里把菜单构建了两遍。）
     */
    installRecentFilesMenu(preferences.recent)
  })

  installApplicationMenu()
  focusMainWindow(createMainWindow())
  // 延迟检查更新：不拖慢首屏，也不打断用户
  /**
   * 不再安排启动时的更新检查。
   *
   * 免费/开源分发未做代码签名，而 macOS 的自动更新要求签名，
   * 因此这条路径在任何情况下都会失败。保留调用只会让后台白跑一次网络请求。
   * IPC 与状态机本身保留（菜单入口已移除），将来签名后可重新启用。
   */

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      focusMainWindow(createMainWindow())
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  stopWorkspaceWatching()
  stopAllBookmarks()
  ipcMain.removeAllListeners()
})
