import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS } from '../main/ipc-channels'
import type {
  AppPreferences,
  AssetWriteRequest,
  AssetWriteResult,
  ExportPdfRequest,
  ExportRequest,
  ExportResult,
  UpdateState,
  LoadedDocument,
  MenuCommand,
  OpenDocumentResult,
  ResolvePathRequest,
  SaveAsResult,
  SearchResult,
  TypeFlowApi,
  WorkspaceChangeEvent,
  WorkspaceTree,
  WriteDocumentRequest
} from '../shared/ipc'

/**
 * 沙箱 preload：渲染层唯一的对外通道。
 *
 * 约束（L0 安全基线，后续级别不得放宽）：
 *  - 不把 ipcRenderer 本体交给渲染层，只暴露具名方法
 *  - 调用参数不做透传式转发，逐个显式列出，防止通道被滥用为任意 IPC
 *  - 事件订阅返回退订函数，避免热重载累积监听器
 */
/**
 * 事件订阅的统一封装。
 *
 * 三个订阅点（菜单命令、菜单打开路径、偏好变化）都需要"返回退订函数"
 * 这一相同语义。集中成一个辅助函数，避免各处手写 removeListener 时漏掉，
 * 也避免热重载时累积监听器。
 */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: TypeFlowApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  },

  file: {
    read: (filePath: string, normalizeEol?: boolean): Promise<LoadedDocument> =>
      ipcRenderer.invoke(CHANNELS.fileRead, filePath, normalizeEol ?? false),

    write: (request: WriteDocumentRequest) => ipcRenderer.invoke(CHANNELS.fileWrite, request),

    openDialog: (): Promise<OpenDocumentResult> => ipcRenderer.invoke(CHANNELS.fileOpenDialog),

    saveAsDialog: (options: {
      defaultPath?: string
      suggestedName?: string
    }): Promise<SaveAsResult> => ipcRenderer.invoke(CHANNELS.fileSaveAsDialog, options)
  },

  prefs: {
    get: (): Promise<AppPreferences> => ipcRenderer.invoke(CHANNELS.prefsGet),
    addRecent: (filePath: string): Promise<AppPreferences> =>
      ipcRenderer.invoke(CHANNELS.prefsAddRecent, filePath),
    clearRecent: (): Promise<AppPreferences> => ipcRenderer.invoke(CHANNELS.prefsClearRecent),
    setLocale: (locale: string | null): Promise<AppPreferences> =>
      ipcRenderer.invoke(CHANNELS.prefsSetLocale, locale),
    onChanged: (handler: (preferences: AppPreferences) => void): (() => void) =>
      subscribe<AppPreferences>(CHANNELS.prefsChanged, handler)
  },

  update: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateGetState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateCheck),
    download: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateDownload),
    install: (): void => {
      ipcRenderer.invoke(CHANNELS.updateInstall)
    },
    onStateChanged: (handler: (state: UpdateState) => void): (() => void) =>
      subscribe<UpdateState>(CHANNELS.updateStateChanged, handler)
  },

  export: {
    html: (request: ExportRequest): Promise<ExportResult> =>
      ipcRenderer.invoke(CHANNELS.exportHtml, request),

    pdf: (request: ExportPdfRequest): Promise<ExportResult> =>
      ipcRenderer.invoke(CHANNELS.exportPdf, request)
  },

  theme: {
    chooseCss: (): Promise<{ path: string; css: string } | null> =>
      ipcRenderer.invoke(CHANNELS.themeChooseCss),

    readCss: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.themeReadCss, filePath)
  },

  assets: {
    read: (filePath: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke(CHANNELS.assetsRead, filePath),

    write: (request: AssetWriteRequest): Promise<AssetWriteResult> =>
      ipcRenderer.invoke(CHANNELS.assetsWrite, request),

    resolve: (request: ResolvePathRequest): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.assetsResolve, request)
  },

  viewer: {
    readPdfResource: (relativePath: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke(CHANNELS.viewerReadPdfResource, relativePath),
    pdfWasmUrl: (): Promise<string> => ipcRenderer.invoke(CHANNELS.viewerPdfWasmUrl)
  },

  workspace: {
    chooseDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.workspaceChooseDirectory),

    readTree: (workspacePath: string): Promise<WorkspaceTree> =>
      ipcRenderer.invoke(CHANNELS.workspaceReadTree, workspacePath),

    createFile: (workspacePath: string, targetPath: string, content?: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.workspaceCreateFile, workspacePath, targetPath, content ?? ''),

    createDirectory: (workspacePath: string, targetPath: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.workspaceCreateDirectory, workspacePath, targetPath),

    rename: (workspacePath: string, fromPath: string, toPath: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.workspaceRename, workspacePath, fromPath, toPath),

    remove: (workspacePath: string, targetPath: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.workspaceRemove, workspacePath, targetPath),

    search: (
      workspacePath: string,
      query: string,
      caseSensitive?: boolean
    ): Promise<SearchResult> =>
      ipcRenderer.invoke(CHANNELS.workspaceSearch, workspacePath, query, caseSensitive ?? false),

    watch: (
      workspacePath: string,
      onChange: (event: WorkspaceChangeEvent) => void
    ): (() => void) => {
      void ipcRenderer.invoke(CHANNELS.workspaceWatch, workspacePath)
      return subscribe<WorkspaceChangeEvent>(CHANNELS.workspaceChanged, (event) => {
        // 只转发当前工作区的事件，避免多工作区时串台
        if (event.workspacePath === workspacePath) onChange(event)
      })
    }
  },

  window: {
    setDocumentEdited: (edited: boolean): void => {
      ipcRenderer.send(CHANNELS.windowDocumentEdited, edited)
    },
    setRepresentedFilename: (filePath: string | null): void => {
      ipcRenderer.send(CHANNELS.windowRepresentedFilename, filePath)
    },
    notifyCloseAfterSave: (): void => {
      ipcRenderer.send(CHANNELS.windowCloseAfterSave)
    }
  },

  menu: {
    onCommand: (handler: (command: MenuCommand) => void): (() => void) =>
      subscribe<MenuCommand>(CHANNELS.menuCommand, handler),

    onOpenPath: (handler: (filePath: string) => void): (() => void) =>
      subscribe<string>(CHANNELS.menuOpenPath, handler)
  },

  smoke: {
    // 环境变量经主进程注入渲染层进程，preload 可直接读取
    enabled: process.env.ELECTRON_SMOKE_TEST === '1',
    masBuild: process.env.ELECTRON_MAS_BUILD === '1',
    tempDir: process.env.ELECTRON_SMOKE_TMPDIR ?? '',
    reportReady: (): void => {
      ipcRenderer.send(CHANNELS.smokeRendererReady)
    },
    report: (details: {
      checks: { label: string; ok: boolean; detail: string }[]
      failures: number
    }): void => {
      ipcRenderer.send(CHANNELS.smokeTestDone, details)
    },
    menuLabels: (): Promise<{ top: string[]; file: string[]; windowTitle: string }> =>
      ipcRenderer.invoke(CHANNELS.smokeMenuLabels)
  },

  screenshot: {
    enabled: process.env.ELECTRON_SCREENSHOT === '1',
    // 截图语言：英文商店页需要英文界面+英文演示文档的截图
    lang: process.env.ELECTRON_SCREENSHOT_LANG === 'en' ? 'en' : 'zh',
    done: (): void => {
      ipcRenderer.send(CHANNELS.screenshotReady)
    }
  },

  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.shellOpenExternal, url)
  }
}

contextBridge.exposeInMainWorld('typeflow', api)
