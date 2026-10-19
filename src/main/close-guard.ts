import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from './ipc-channels'
import { isDocumentDirty } from './window-state'
import { messages } from '../shared/i18n'

/**
 * 未保存内容守卫——L0 的数据安全红线。
 *
 * 行为：
 *  - 文档干净时直接放行，零打扰
 *  - 有未保存修改时弹原生三选一：保存 / 不保存 / 取消
 *  - 选"保存"不直接关窗，而是请求渲染层保存；渲染层保存成功后通过
 *    window:close-after-save 通知主进程销毁窗口（另存为取消或保存失败则不发）
 *
 * 用"渲染层上报 + 主进程持布尔量"而非同步 IPC 询问，是为了避免同步阻塞冻结窗口。
 */

interface GuardState {
  /** 用户已确认放弃修改，下一次 close 直接放行 */
  forceClose: boolean
  /** 已发起"保存后关闭"，等渲染层回执 */
  awaitingSave: boolean
}

const guards = new WeakMap<BrowserWindow, GuardState>()

function stateFor(window: BrowserWindow): GuardState {
  let state = guards.get(window)
  if (!state) {
    state = { forceClose: false, awaitingSave: false }
    guards.set(window, state)
  }
  return state
}

/** 渲染层保存成功后调用；只有确实在等关闭时才销毁窗口。 */
export function handleCloseAfterSave(event: Electron.IpcMainEvent): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  const state = stateFor(window)
  if (!state.awaitingSave) return

  state.awaitingSave = false
  state.forceClose = true
  window.destroy()
}

export function registerCloseGuardHandler(): void {
  ipcMain.on(CHANNELS.windowCloseAfterSave, handleCloseAfterSave)
}

export function installCloseGuard(window: BrowserWindow): void {
  const state = stateFor(window)

  window.on('close', (event) => {
    if (state.forceClose || !isDocumentDirty()) return

    event.preventDefault()

    const t = messages().dialog
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        buttons: [t.saveButton, t.discardButton, t.cancelButton],
        defaultId: 0,
        cancelId: 2,
        title: t.unsavedTitle,
        message: t.unsavedMessage,
        detail: t.unsavedDetail
      })
      .then(({ response }) => {
        if (response === 2) return

        if (response === 1) {
          state.forceClose = true
          window.destroy()
          return
        }

        state.awaitingSave = true
        window.webContents.send(CHANNELS.menuCommand, 'file:save')
      })
  })

  window.on('closed', () => {
    guards.delete(window)
  })
}
