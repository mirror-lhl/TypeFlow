/**
 * TypeFlow — 共享类型契约
 *
 * 这里是主进程、preload、渲染进程三方唯一的事实来源。
 * 修改任何通道名或载荷结构，三个进程都会在 typecheck 阶段报错，
 * 这是 L0 骨架防回归的核心机制。
 */

/** 文档的换行风格，保存时按原文风格回写，避免整文件 diff 噪声。 */
export type LineEnding = 'lf' | 'crlf'

/** 用哪种编码读出来的，保存时默认沿用，避免中文文档二次损坏。 */
export type FileEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'gbk'

export interface LoadedDocument {
  /** 文档正文；换行是否归一化取决于 normalizeEol */
  content: string
  /** 磁盘上检测到的原始换行风格 */
  eol: LineEnding
  encoding: FileEncoding
  /** 文件字节数，用于状态栏展示与"大文件"策略判断 */
  byteLength: number
  /** 该编码是否由启发式猜测得出（GBK 回退），UI 需提示用户 */
  encodingGuessed: boolean
}

export interface OpenDocumentResult {
  /** 用户取消选择时为 null */
  canceled: boolean
  filePath: string | null
  /**
   * 仅可编辑文档有值。
   *
   * 选中 PDF / HTML / 图片时为 null：这些文件按二进制或原文交给只读查看器，
   * 不能走文本解码——把 PDF 字节按 UTF-8 解码既无意义也会白读一遍大文件。
   */
  document: LoadedDocument | null
}

export interface SaveAsResult {
  canceled: boolean
  filePath: string | null
}

export interface WriteDocumentRequest {
  filePath: string
  content: string
  eol: LineEnding
  encoding: FileEncoding
}

export interface DocumentWriteResult {
  byteLength: number
  /**
   * 实际落盘编码。GBK 只读不可写，当原文档是 GBK 且含非 ASCII 字符时，
   * 主进程会升级为 UTF-8 并在此告知渲染层，由 UI 提示用户。
   */
  encoding: FileEncoding
}

export interface RecentDocument {
  filePath: string
  fileName: string
  /** epoch ms */
  openedAt: number
}

export interface AppPreferences {
  recent: RecentDocument[]
  lastDirectory: string | null
  /** 界面语言；null 表示跟随系统 */
  locale: string | null
}

/* ------------------------------------------------------------------ *
 * 工作区（L2）
 * ------------------------------------------------------------------ */

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  /** 是否可作为文档打开（Markdown 或 .txt 纯文本） */
  isText: boolean
  /** 是否可作为只读查看对象打开（PDF / HTML / 图片） */
  isViewable: boolean
  /** 仅文件有值，字节数 */
  size?: number
  children?: FileTreeNode[]
}

export interface WorkspaceTree {
  root: FileTreeNode
  /** 是否因深度/数量上限被截断，UI 需提示用户 */
  truncated: boolean
}

export interface SearchMatch {
  /** 1-based 行号 */
  line: number
  /** 0-based 列号 */
  column: number
  /** 命中行片段（过长时已居中截断并加省略号），仅用于展示 */
  snippet: string
  /**
   * 命中行的**完整文本**（不含换行符）。
   *
   * 这是"跳转到该结果"时真正可依赖的信息：行号会因 markdown 规范化漂移，
   * 而这一行文本是确切的。行号退化为消歧用的提示。
   */
  lineText: string
}

export interface SearchFileResult {
  path: string
  /** 相对工作区的路径，用于展示 */
  relativePath: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFileResult[]
  totalMatches: number
  /** 命中数达到上限被截断 */
  truncated: boolean
}

/* ------------------------------------------------------------------ *
 * 导出与主题（L4）
 * ------------------------------------------------------------------ */

/** 导出请求：渲染层负责生成自包含 HTML，主进程只负责落盘。 */
export interface ExportRequest {
  html: string
  suggestedName: string
  /**
   * 直接写入该路径，跳过保存对话框。
   *
   * 这个能力不是为测试加的：批量导出、命令行导出、以及"导出到固定位置"
   * 的自动化流程都需要它。有对话框时它是可选项，不传就照常弹框。
   */
  targetPath?: string
}

export interface ExportPdfRequest extends ExportRequest {
  landscape?: boolean
  pageSize?: 'A4' | 'A3' | 'Letter' | 'Tabloid'
}

export interface ExportResult {
  canceled: boolean
  filePath: string | null
  byteLength?: number
}

/** 自定义主题。 */
export interface CustomTheme {
  /** CSS 文件绝对路径，null 表示未设置 */
  path: string | null
}

/** 自动更新状态。 */
export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'up-to-date'
    | 'downloading'
    | 'downloaded'
    | 'unavailable'
    | 'error'
  version?: string
  percent?: number
  message?: string
}

/** 图片等二进制资源的写入请求。 */
export interface AssetWriteRequest {
  /** 要写入的绝对路径（通常位于文档同目录的 assets/ 下） */
  filePath: string
  /** 原始字节（ArrayBuffer 经 structured clone 传输） */
  bytes: ArrayBuffer
}

export interface AssetWriteResult {
  filePath: string
  byteLength: number
}

/** 把任意路径解析为绝对路径并确认其可读（用于图片显示）。 */
export interface ResolvePathRequest {
  /** 相对或绝对路径 */
  target: string
  /** 相对路径的基准目录（当前文档所在目录） */
  baseDirectory: string | null
}

export interface WorkspaceChangeEvent {
  workspacePath: string
  eventType: 'rename' | 'change'
  fileName: string | null
}

/** 主进程 → 渲染进程的菜单命令。枚举即契约，新增命令必须同步 menu.ts 与 renderer。 */
export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:open-folder'
  | 'file:save'
  | 'file:save-as'
  | 'file:close-tab'
  | 'file:clear-recent'
  | 'edit:find'
  | 'edit:find-in-files'
  | 'edit:undo'
  | 'edit:redo'
  | 'view:zoom-reset'
  | 'view:toggle-theme'
  | 'view:toggle-mode'
  | 'view:toggle-layout'
  | 'view:toggle-preview'
  | 'file:export-html'
  | 'file:export-pdf'
  | 'view:theme-variant'
  | 'view:theme-import'
  | 'view:theme-clear'
  | 'view:set-locale'
  | 'help:check-for-updates'
  | 'help:reset-ui'
  | 'insert:table'
  | 'view:toggle-sidebar'
  | 'view:refresh-workspace'
  | 'app:about'

/** 平台标识。显式联合类型而非 NodeJS.Platform，保持共享契约与 lib 无关。 */
export type Platform = 'darwin' | 'win32' | 'linux' | string

/** preload 通过 contextBridge 暴露给渲染进程的全部能力。 */
export interface TypeFlowApi {
  readonly platform: Platform
  readonly versions: {
    electron: string
    chrome: string
    node: string
  }

  file: {
    read(filePath: string, normalizeEol?: boolean): Promise<LoadedDocument>
    write(request: WriteDocumentRequest): Promise<DocumentWriteResult>
    openDialog(): Promise<OpenDocumentResult>
    saveAsDialog(options: {
      defaultPath?: string
      suggestedName?: string
    }): Promise<SaveAsResult>
  }

  prefs: {
    get(): Promise<AppPreferences>
    addRecent(filePath: string): Promise<AppPreferences>
    clearRecent(): Promise<AppPreferences>
    /** 设置界面语言；null 表示跟随系统 */
    setLocale(locale: string | null): Promise<AppPreferences>
    /** 订阅偏好变化（主进程在任一写入点广播），返回退订函数 */
    onChanged(handler: (preferences: AppPreferences) => void): () => void
  }

  update: {
    getState(): Promise<UpdateState>
    /** 检查更新；未打包时返回 unavailable */
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    /** 退出并安装（由 electron-updater 接管重启） */
    install(): void
    /** 状态变化订阅 */
    onStateChanged(handler: (state: UpdateState) => void): () => void
  }

  export: {
    /** 导出为自包含 HTML 文件 */
    html(request: ExportRequest): Promise<ExportResult>
    /** 渲染为 PDF（主进程用隐藏窗口 + printToPDF） */
    pdf(request: ExportPdfRequest): Promise<ExportResult>
  }

  theme: {
    /** 弹出文件选择框读取自定义主题 CSS */
    chooseCss(): Promise<{ path: string; css: string } | null>
    /** 按路径重新读取主题 CSS（启动时恢复上次设置） */
    readCss(filePath: string): Promise<string | null>
  }

  assets: {
    /** 读取资源字节（导出自包含 HTML 时需要内联为 data URL） */
    read(filePath: string): Promise<ArrayBuffer | null>
    /**
     * 写入二进制资源（图片粘贴/拖入）。
     *
     * 与 `file.write` 分开的原因：那条通道只接受文本 + 编码，
     * 用它传二进制会经历一次无法保证无损的编码往返。
     */
    write(request: AssetWriteRequest): Promise<AssetWriteResult>
    /** 解析为绝对路径并确认存在，供图片显示使用 */
    resolve(request: ResolvePathRequest): Promise<string | null>
  }

  viewer: {
    /**
     * 读取 PDF 查看器的运行期资源（cMap / 标准字体）。
     *
     * 只接受 `cmaps/<name>.bcmap`、`standard_fonts/<name>` 这两类单段相对路径，
     * 越界或不存在时返回 null。渲染层由 `file://` 加载，`fetch` 本地文件行不通，
     * 因此 pdf.js 的二进制资源改由主进程按名读取。
     */
    readPdfResource(relativePath: string): Promise<ArrayBuffer | null>
    /**
     * pdf.js 纯 JS 解码器（JPEG2000 / JBIG2）所在目录的 `file://` URL，以 `/` 结尾。
     *
     * `useWasm: false` 时 pdf.js 用动态 import 取这些文件，走不了上面的读取通道。
     */
    pdfWasmUrl(): Promise<string>
  }

  workspace: {
    /** 弹出目录选择框；取消时返回 null */
    chooseDirectory(): Promise<string | null>
    readTree(workspacePath: string): Promise<WorkspaceTree>
    createFile(workspacePath: string, targetPath: string, content?: string): Promise<void>
    createDirectory(workspacePath: string, targetPath: string): Promise<void>
    rename(workspacePath: string, fromPath: string, toPath: string): Promise<void>
    remove(workspacePath: string, targetPath: string): Promise<void>
    search(
      workspacePath: string,
      query: string,
      caseSensitive?: boolean
    ): Promise<SearchResult>
    /** 开始监听目录变化；返回退订函数（内部为 IPC 监听器，需显式清理） */
    watch(workspacePath: string, onChange: (event: WorkspaceChangeEvent) => void): () => void
  }

  window: {
    setDocumentEdited(edited: boolean): void
    setRepresentedFilename(filePath: string | null): void
    /** 保存成功且用户此前选择"保存后关闭"时调用，主进程据此销毁窗口。 */
    notifyCloseAfterSave(): void
  }

  menu: {
    onCommand(handler: (command: MenuCommand) => void): () => void
    /** 菜单里点击"最近打开"的某一项时携带具体路径 */
    onOpenPath(handler: (filePath: string) => void): () => void
  }

  /** 仅自检模式使用：渲染层完成端到端校验后通知主进程退出。 */
  smoke: {
    readonly enabled: boolean
    /** 仅自检模式下由主进程注入的可写临时目录，用于验证真实落盘 */
    readonly tempDir: string
    /** init() 跑完即上报，主进程据此判断 preload 桥与渲染层是否真的就绪 */
    reportReady(): void
    report(details: {
      /** 逐条断言明细，供主进程打印到 stdout 便于 CI 与人工核查 */
      checks: { label: string; ok: boolean; detail: string }[]
      failures: number
    }): void
    /**
     * 读取当前应用菜单的标签快照。
     *
     * 菜单标签在 `Menu.buildFromTemplate` 时被固化成字符串：
     * 语言切换后若不重建菜单，界面其余部分是英文而菜单仍是中文。
     * 渲染层无法直接观察主进程的菜单，因此需要这个只读通道来断言。
     */
    menuLabels(): Promise<{ top: string[]; file: string[]; windowTitle: string }>
  }

  /** 商店截图模式：渲染层铺好演示文档后通知主进程抓图。 */
  screenshot: {
    readonly enabled: boolean
    /** 截图语言：'en' 强制英文界面与英文演示文档，默认 'zh'。 */
    readonly lang: 'en' | 'zh'
    done(): void
  }

  shell: {
    openExternal(url: string): Promise<void>
  }
}
