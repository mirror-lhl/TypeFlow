import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { basename } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type { MenuCommand, RecentDocument } from '../shared/ipc'
import { resolveActiveWindow } from './window-state'
import { getPreferences } from './preferences'
import { messages } from '../shared/i18n'

/**
 * 菜单是"命令总线"：所有用户意图先落到这里，再以 MenuCommand 广播给渲染层统一处理。
 * 这样后续增加面板或快捷键时只改一处，不会出现"菜单能点、快捷键不生效"的分叉。
 */

let recentDocuments: RecentDocument[] = []

function send(command: MenuCommand): void {
  resolveActiveWindow()?.webContents.send(CHANNELS.menuCommand, command)
}

/** 打开最近文件走独立通道（需要携带路径），与无参命令区分开。 */
function sendOpenPath(filePath: string): void {
  resolveActiveWindow()?.webContents.send(CHANNELS.menuOpenPath, filePath)
}

/**
 * "最近打开"子菜单。
 *
 * 显式接收字符串表而非依赖外层作用域的 `t`：这个函数在
 * `buildRecentSubmenu` 调用点之外也会被复用，隐式依赖会让
 * 语言切换后菜单不更新这类问题变得难以追踪。
 */
function buildRecentSubmenu(t: ReturnType<typeof messages>['menu']): MenuItemConstructorOptions[] {
  if (recentDocuments.length === 0) {
    return [{ label: t.recentEmpty, enabled: false }]
  }

  return [
    ...recentDocuments.map((entry) => ({
      label: basename(entry.filePath),
      toolTip: entry.filePath,
      click: () => sendOpenPath(entry.filePath)
    })),
    { type: 'separator' as const },
    { label: t.clearRecent, click: () => send('file:clear-recent') }
  ]
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'
  const t = messages().menu

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { label: t.about, click: () => send('app:about') },
            { type: 'separator' },
            { role: 'services', label: t.services },
            { type: 'separator' },
            { role: 'hide', label: t.hide },
            { role: 'hideOthers', label: t.hideOthers },
            { role: 'unhide', label: t.unhide },
            { type: 'separator' },
            { role: 'quit', label: t.quit }
          ]
        }
      ]
    : []

  const fileMenu: MenuItemConstructorOptions = {
    label: t.file,
    submenu: [
      { label: t.new, accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
      { label: t.open, accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
      {
        label: t.openFolder,
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => send('file:open-folder')
      },
      {
        label: t.recent,
        submenu: buildRecentSubmenu(t)
      },
      { type: 'separator' },
      { label: t.save, accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
      {
        label: t.saveAs,
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => send('file:save-as')
      },
      { type: 'separator' },
      {
        label: t.exportHtml,
        accelerator: 'CmdOrCtrl+Shift+E',
        click: () => send('file:export-html')
      },
      {
        label: t.exportPdf,
        accelerator: 'CmdOrCtrl+P',
        click: () => send('file:export-pdf')
      },
      { type: 'separator' },
      {
        label: t.closeTab,
        accelerator: 'CmdOrCtrl+W',
        click: () => send('file:close-tab')
      },
      isMac ? { role: 'close', label: t.closeWindow } : { role: 'quit', label: t.quit }
    ]
  }

  const editMenu: MenuItemConstructorOptions = {
    label: t.edit,
    submenu: [
      {
        label: t.undo,
        accelerator: 'CmdOrCtrl+Z',
        // 用自定义点击而非 role: 'undo'：内核持有自己的撤销栈，
        // 系统 role 只作用于原生输入框，对 ProseMirror 无效
        click: () => send('edit:undo')
      },
      { label: t.redo, accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('edit:redo') },
      { type: 'separator' },
      { role: 'cut', label: t.cut },
      { role: 'copy', label: t.copy },
      { role: 'paste', label: t.paste },
      { role: 'selectAll', label: t.selectAll },
      { type: 'separator' },
      { label: t.find, accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') },
      {
        label: t.insertTable,
        accelerator: 'CmdOrCtrl+Alt+T',
        click: () => send('insert:table')
      },
      {
        label: t.findInFiles,
        accelerator: 'CmdOrCtrl+Shift+F',
        click: () => send('edit:find-in-files')
      }
    ]
  }

  const viewMenu: MenuItemConstructorOptions = {
    label: t.view,
    submenu: [
      {
        label: t.toggleSidebar,
        accelerator: 'CmdOrCtrl+B',
        click: () => send('view:toggle-sidebar')
      },
      {
        label: t.refreshWorkspace,
        accelerator: 'CmdOrCtrl+R',
        click: () => send('view:refresh-workspace')
      },
      { type: 'separator' },
      {
        label: t.toggleMode,
        accelerator: 'CmdOrCtrl+Shift+M',
        click: () => send('view:toggle-mode')
      },
      {
        label: t.toggleLayout,
        accelerator: 'CmdOrCtrl+Shift+V',
        click: () => send('view:toggle-layout')
      },
      {
        label: t.toggleTheme,
        accelerator: 'CmdOrCtrl+Shift+L',
        click: () => send('view:toggle-theme')
      },
      {
        label: t.themeVariant,
        accelerator: 'CmdOrCtrl+Alt+L',
        click: () => send('view:theme-variant')
      },
      {
        label: t.themeImport,
        click: () => send('view:theme-import')
      },
      {
        label: t.themeClear,
        click: () => send('view:theme-clear')
      },
      { type: 'separator' as const },
      {
        label: t.language,
        click: () => send('view:set-locale')
      },
      { type: 'separator' },
      { role: 'resetZoom', label: t.resetZoom },
      { role: 'zoomIn', label: t.zoomIn },
      { role: 'zoomOut', label: t.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t.fullscreen },
      { role: 'toggleDevTools', label: t.devTools }
    ]
  }

  return Menu.buildFromTemplate([
    ...appMenu,
    fileMenu,
    editMenu,
    viewMenu,
    { label: t.window, role: 'windowMenu' },
    {
      label: t.help,
      role: 'help',
      submenu: [
        {
          label: t.markdownReference,
          click: () => void shell.openExternal('https://commonmark.org/help/')
        },
        {
          label: t.resetUi,
          click: () => send('help:reset-ui')
        },
        { label: t.openConfigDirectory, click: () => void shell.openPath(app.getPath('userData')) }
      ]
    }
  ])
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildMenu())

  // 启动即加载一次最近文件，避免首次打开菜单时子项为空
  void getPreferences().then((preferences) => {
    recentDocuments = preferences.recent
    Menu.setApplicationMenu(buildMenu())
  })
}

/**
 * 最近文件变化时重建菜单。
 *
 * 由 preferences 在任何写入后调用，因此"最近打开"始终反映真实状态，
 * 不需要在各处保存点手动刷新。
 */
/**
 * 更新最近文件列表并**重建整份应用菜单**。
 *
 * 名字只提到"最近文件"，但它实际会重新构建整个菜单——因为菜单是模板固化出来的，
 * 无法局部替换某一项。语言切换也依赖这个行为：调用它即等于"用当前语言重建菜单"。
 */
export function installRecentFilesMenu(recent: RecentDocument[]): void {
  recentDocuments = recent
  if (BrowserWindow.getAllWindows().length === 0) return
  Menu.setApplicationMenu(buildMenu())
}
