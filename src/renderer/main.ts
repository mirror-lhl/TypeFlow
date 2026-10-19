// 三方样式经 TS 模块导入而非 CSS @import：Vite 对裸包说明符的解析
// 在 @import 里并不总是生效，走模块导入可以用它的解析器并自动处理字体资源
import 'katex/dist/katex.min.css'
import './styles.css'
import type {
  FileEncoding,
  FileTreeNode,
  LineEnding,
  MenuCommand,
  SearchResult,
  WorkspaceTree
} from '../shared/ipc'
import {
  cursorToStart,
  getLastAutoInsertDiagnostics,
  inlineCommands,
  type EditorApi
} from './editor'
import { documentToMarkdown, markdownToDocument } from './editor/markdown'
import { tableCommands, tableContext } from './editor/table-plugins'
import { codeHighlightCacheSize } from './editor/code-highlight'
import { createImageResolver, insertImageFiles, isImageFile } from './editor/image'
import { buildExportHtml, documentToHtml, inlineImages } from './export/document-html'
import {
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  messages,
  normalizeLocale,
  getLocale,
  setLocale,
  type Locale
} from '../shared/i18n'
import { TextSelection } from 'prosemirror-state'
import {
  activeBlockKind,
  activeHeadingLevel,
  isMarkActive,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleOrderedList
} from './editor/behavior'
import { SessionStore, baseName, type Session } from './workspace/session-store'
import {
  isDocumentPath,
  isOpenablePath,
  isPlainTextPath,
  viewerKindOf
} from '../shared/document-types'
import { createViewer, type ViewerView } from './workspace/viewer'
import { directoryOf } from './file-url'
import { createTabBar } from './workspace/tab-bar'
import { createFileTreeView } from './workspace/file-tree'
import { createOutlineView, buildOutline, activeOutlineIndex, type OutlineItem } from './workspace/outline'
import { createSearchPanel } from './workspace/search-panel'
import { findTextMatches, revealRangeInTextarea, selectRange } from './workspace/text-search'
import { getLastScrollDiagnostics, scrollPositionIntoView } from './editor/search-highlight'

/**
 * 渲染层。
 *
 * 职责边界：文档生命周期（打开/保存/编码）、外层布局、标签、工作区面板、
 * 查找、命令派发、状态栏。编辑内核在 `editor/`，多标签状态在 `workspace/session-store`。
 *
 * 唯一权威内容仍是每个会话自己的 markdown 字符串；内核按需挂载。
 */

const api = window.typeflow

/* ------------------------------------------------------------------ *
 * DOM 引用
 * ------------------------------------------------------------------ */

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`缺少必需的 DOM 节点: #${id}`)
  return element as T
}

const dom = {
  root: document.documentElement,
  workbench: requireElement<HTMLElement>('workbench'),
  sidebar: requireElement<HTMLElement>('sidebar'),
  sidebarResizer: requireElement<HTMLElement>('sidebar-resizer'),
  workspacePath: requireElement<HTMLElement>('workspace-path'),
  fileTreeHost: requireElement<HTMLElement>('file-tree'),
  outlineHost: requireElement<HTMLElement>('outline'),
  searchHost: requireElement<HTMLElement>('search-panel'),
  tabBarHost: requireElement<HTMLElement>('tab-bar'),
  editorArea: requireElement<HTMLElement>('editor-area'),
  wysiwygHost: requireElement<HTMLElement>('wysiwyg'),
  rawEditor: requireElement<HTMLTextAreaElement>('raw-editor'),
  preview: requireElement<HTMLElement>('preview'),
  viewerHost: requireElement<HTMLElement>('viewer'),
  formatGroup: requireElement<HTMLElement>('format-group'),
  statusMessage: requireElement<HTMLElement>('status-message'),
  statusStats: requireElement<HTMLElement>('status-stats'),
  statusTabs: requireElement<HTMLElement>('status-tabs'),
  statusEol: requireElement<HTMLElement>('status-eol'),
  statusEncoding: requireElement<HTMLElement>('status-encoding'),
  statusPlatform: requireElement<HTMLElement>('status-platform'),
  finder: requireElement<HTMLElement>('finder'),
  finderInput: requireElement<HTMLInputElement>('finder-input'),
  finderCount: requireElement<HTMLElement>('finder-count')
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

type ViewLayout = 'split' | 'source' | 'preview'
type EditMode = 'wysiwyg' | 'raw'

const LAYOUT_CYCLE: ViewLayout[] = ['split', 'source', 'preview']

const ENCODING_LABEL: Record<FileEncoding, string> = {
  utf8: 'UTF-8',
  'utf8-bom': 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  gbk: 'GBK'
}

const LINE_ENDING_LABEL: Record<LineEnding, string> = { lf: 'LF', crlf: 'CRLF' }

/** 排版主题变体：影响字号、行距、标题风格，与明暗是正交的两件事。 */
type ThemeVariant = 'default' | 'serif' | 'compact'

const THEME_VARIANTS: ThemeVariant[] = ['default', 'serif', 'compact']

/** 排版主题按钮文案走 i18n：硬编码中文会让英文界面残留中文按钮。 */
function themeVariantLabel(variant: ThemeVariant): string {
  const labels = messages().themeVariant
  if (variant === 'serif') return labels.serif
  if (variant === 'compact') return labels.compact
  return labels.default
}

const PREFERENCE_KEYS = {
  theme: 'typeflow.theme',
  themeVariant: 'typeflow.theme-variant',
  locale: 'typeflow.locale',
  customThemePath: 'typeflow.custom-theme-path',
  layout: 'typeflow.layout',
  mode: 'typeflow.mode',
  sidebar: 'typeflow.sidebar',
  sidebarWidth: 'typeflow.sidebar-width',
  sidePanel: 'typeflow.side-panel'
} as const

const state = {
  layout: 'split' as ViewLayout,
  mode: 'wysiwyg' as EditMode,
  /**
   * 用户为 Markdown 文档选择的模式（持久化）。
   *
   * 与 `mode` 分开：纯文本文档被强制钉在源码模式，
   * 但这是**文档属性**而非用户偏好——切回 Markdown 文档时要恢复用户原本的选择。
   */
  preferredMode: 'wysiwyg' as EditMode,
  theme: 'light' as 'light' | 'dark',
  themeVariant: 'default' as ThemeVariant,
  /** 自定义主题 CSS 文件路径，null 表示未设置 */
  customThemePath: null as string | null,
  sidebarVisible: true,
  sidePanel: 'files' as 'files' | 'outline' | 'search',
  workspacePath: null as string | null,
  workspaceTree: null as WorkspaceTree | null,
  outline: [] as OutlineItem[],
  /** 只读查看会话的补充信息（页数 / 像素尺寸），显示在状态栏 */
  viewerDetail: null as string | null
}

/**
 * 当前文档所在目录——图片相对路径的解析基准。
 *
 * 必须随活动标签同步更新，否则会出现"A 文件的图片在 B 文件里显示"的串图问题。
 */
function activeDocumentDirectory(): string | null {
  const filePath = store?.active?.filePath ?? null
  return filePath === null ? null : directoryOf(filePath)
}

let imageResolver: ReturnType<typeof createImageResolver>

let store: SessionStore
let tabBar: ReturnType<typeof createTabBar>
let fileTree: ReturnType<typeof createFileTreeView>
let outlineView: ReturnType<typeof createOutlineView>
let searchPanel: ReturnType<typeof createSearchPanel>
let viewer: ViewerView
let unwatchWorkspace: (() => void) | null = null

/* ------------------------------------------------------------------ *
 * 昂贵刷新的合并调度
 *
 * 逐键重算统计、大纲与预览是**大文档下的真实瓶颈**：一次按键就要
 * 全文扫描三遍（字数统计、标题遍历、markdown 重新渲染）。
 * 一万行的文档上，这会让输入出现肉眼可见的延迟。
 *
 * 这些信息都不需要逐键精度——用户看不出统计数字晚 120ms 更新。
 * 因此把它们合并到一次延迟执行里，连续输入只在停顿后计算一次。
 * ------------------------------------------------------------------ */

const EXPENSIVE_REFRESH_DELAY_MS = 120

/** 已排入的合并刷新定时器。 */
let pendingExpensiveRefresh: number | null = null

/**
 * 合并刷新次数计数。
 *
 * 暴露它不是为了统计好看，而是让自检能够**断言合并确实生效**：
 * 连续 N 次输入后，昂贵刷新次数必须远小于 N。
 * 没有这个可观测量，性能回归只能靠人工手感发现。
 */
let expensiveRefreshCount = 0

function scheduleExpensiveRefresh(): void {
  if (pendingExpensiveRefresh !== null) return

  pendingExpensiveRefresh = window.setTimeout(() => {
    pendingExpensiveRefresh = null
    runExpensiveRefresh()
  }, EXPENSIVE_REFRESH_DELAY_MS)
}

/** 立即执行昂贵刷新（装载文档、切标签时需要即时结果）。 */
function flushExpensiveRefresh(): void {
  if (pendingExpensiveRefresh !== null) {
    window.clearTimeout(pendingExpensiveRefresh)
    pendingExpensiveRefresh = null
  }
  runExpensiveRefresh()
}

function runExpensiveRefresh(): void {
  expensiveRefreshCount += 1
  updateStats()
  refreshOutline()
  // 查看会话下预览面板整个被 CSS 隐藏，渲染它只是白烧一次全文解析
  if (viewerSession() === null && state.layout !== 'source') renderPreview()
}

function editor(): EditorApi | null {
  return store.activeEditor
}

/** 活动会话是只读查看对象时返回它，否则 null。 */
function viewerSession(): Session | null {
  const session = store?.active ?? null
  return session?.kind === 'viewer' ? session : null
}

/**
 * 在"编辑表面"与"只读查看表面"之间切换。
 *
 * 查看会话没有源码/分屏/预览这组概念，因此 `data-view` 临时取 `viewer`；
 * 离开时必须按用户原本的布局偏好还原——否则看一眼 PDF 就把分屏设置弄丢了。
 */
let viewerMounted = false
/** 查看面板当前渲染的是哪个会话，用于避免切回标签时重复栅格化 */
let viewerRenderedId: string | null = null

function applySurface(): void {
  if (viewerSession() !== null) {
    viewerMounted = true
    // 查找条锚在编辑区内部，不关掉就会浮在 PDF 上；而查看会话没有可查找的内核
    if (!dom.finder.hidden) closeFinder()
    dom.viewerHost.hidden = false
    dom.editorArea.dataset.view = 'viewer'
    return
  }

  if (viewerMounted) {
    viewerMounted = false
    viewerRenderedId = null
    // 立刻释放：一份 PDF 可能是几十个栅格化页面，切走之后没理由继续占着显存
    viewer?.clear()
    state.viewerDetail = null
  }
  dom.viewerHost.hidden = true
  dom.editorArea.dataset.view = state.layout
}

/**
 * 查看会话下禁掉"没有作用对象"的按钮。
 *
 * 只弹提示不禁用是最差的反馈：按钮看起来能用，点下去才知道不行。
 * 格式按钮组由 `updateFormatButtons` 负责（它按内核是否存在判断）。
 */
function updateViewerChrome(): void {
  const readOnly = viewerSession() !== null
  for (const action of ['toggle-mode', 'toggle-preview', 'save', 'export-html', 'export-pdf']) {
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`)) {
      button.disabled = readOnly
    }
  }
}

/* ------------------------------------------------------------------ *
 * 状态栏
 * ------------------------------------------------------------------ */

let messageTimer: number | undefined

function setMessage(text: string, tone: 'info' | 'warn' | 'error' = 'info', autoClearMs = 0): void {
  dom.statusMessage.textContent = text
  dom.statusMessage.dataset.tone = tone

  if (messageTimer !== undefined) window.clearTimeout(messageTimer)
  if (autoClearMs > 0) {
    messageTimer = window.setTimeout(() => {
      dom.statusMessage.textContent = messages().status.ready
      dom.statusMessage.dataset.tone = 'info'
    }, autoClearMs)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']*':\s*/, '')
  }
  return String(error)
}

function currentMarkdown(): string {
  const session = store.active
  // 只读查看会话没有权威文本。这里必须显式返回空串：
  // 源码文本框在查看会话下仍留着上一个文档的内容，读它就是串文档
  if (!session || session.kind === 'viewer') return ''
  return state.mode === 'raw' ? dom.rawEditor.value : (editor()?.getMarkdown() ?? session.markdown)
}

/**
 * 把当前语言的文案应用到所有带 `data-i18n*` 标注的静态元素。
 *
 * 用标注而非逐个 `getElementById` 赋值：静态文案集中在 HTML 里，
 * 增删元素时不需要同步改 JS，也就不会出现"新加的按钮忘了翻译"。
 *
 * 支持三种标注：
 *  - `data-i18n`            文本内容
 *  - `data-i18n-title`      title 提示
 *  - `data-i18n-placeholder` placeholder
 */
function applyTranslations(): void {
  const table = messages()

  function lookup(path: string): string | null {
    const parts = path.split('.')
    let cursor: unknown = table
    for (const part of parts) {
      if (typeof cursor !== 'object' || cursor === null) return null
      cursor = (cursor as Record<string, unknown>)[part]
    }
    return typeof cursor === 'string' ? cursor : null
  }

  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = lookup(element.dataset.i18n ?? '')
    if (text !== null) element.textContent = text
  }

  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const text = lookup(element.dataset.i18nTitle ?? '')
    if (text !== null) element.title = text
  }

  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    const text = lookup(element.dataset.i18nPlaceholder ?? '')
    if (text !== null && element instanceof HTMLInputElement) element.placeholder = text
  }

  // 动态按钮的文案（内容随状态变化，不能用静态标注）
  updateModeButton()
  updatePreviewToggleButton()
  const variantButton = document.querySelector<HTMLButtonElement>('[data-action="theme-variant"]')
  if (variantButton) variantButton.textContent = themeVariantLabel(state.themeVariant)

  // 文件树空状态由模块自绘、不在 data-i18n 标注体系里，语言变化后需重绘
  fileTree?.refreshLocaleText()

  dom.statusTabs.textContent = formatTabCount(store.list().length)
}

/**
 * 标签数量文案。
 *
 * 英文需要区分单复数：`1 tabs` 是明显的手工拼接痕迹。
 * 中文没有复数变化，两个键同值即可。
 */
function formatTabCount(count: number): string {
  const table = messages().status
  return `${count} ${count === 1 ? table.tab : table.tabs}`
}

async function changeLocale(locale: Locale | null): Promise<void> {
  try {
    const preferences = await api.prefs.setLocale(locale)
    const applied = normalizeLocale(preferences.locale ?? api.platform)
    setLocale(applied)
    /**
     * 持久化到 localStorage，与启动时写入保持一致。
     *
     * 不写会让"界面设置"的快照停留在启动时的语言；
     * 重置界面设置（清 localStorage）与调试时看到的都是过期值。
     */
    window.localStorage.setItem(PREFERENCE_KEYS.locale, applied)
    applyTranslations()

    /**
     * 由模块自绘的文案不在 `data-i18n` 标注体系里，必须显式刷新。
     *
     * 这一组调用是同一类缺陷的集中修复：模块在初始化时取一次 `messages()`，
     * 之后语言变了也不更新，表现为"切英文后某些角落仍是中文"。
     */
    outlineView.refreshLocaleText()
    searchPanel.refreshLocaleText()
    fileTree.refreshLocaleText()

    // 未命名标签的标题同样取自 messages()，需按新语言重建
    store.retitleUntitled()

    refreshAll()

    /**
     * 强推一次窗口标题。
     *
     * 未命名文档的窗口标题由**主进程**用 `messages()` 生成，
     * 只在文件路径变化时才会重设；语言切换不会触发路径变化，
     * 因此这里主动再发一次，让它用新语言重算标题。
     */
    api.window.setRepresentedFilename(store.active?.filePath ?? null)
    setMessage(`${LOCALE_LABELS[applied]}`, 'info', 2200)
  } catch (error) {
    // 诊断用：把异常细节暴露到状态栏，便于定位刷新链中断的位置
    setMessage(`Locale: ${describeError(error)}`, 'error')
    lastLocaleError = describeError(error)
  }
}

/** 最近一次语言切换的异常（诊断用）。 */
let lastLocaleError: string | null = null

/**
 * 循环切换语言（菜单项只有一个入口，避免菜单过长）。
 *
 * 必须用**内存中的当前语言** `getLocale()`，不能用 localStorage 里的快照。
 * `localStorage[locale]` 只在启动时写入一次，切换语言不会更新它：
 * 用它计算"下一个语言"，每次都会得到同一个结果，
 * 于是菜单项**只有第一次点击有效**，后续点击毫无反应。
 */
async function cycleLocale(): Promise<void> {
  const index = SUPPORTED_LOCALES.indexOf(getLocale())
  const next = SUPPORTED_LOCALES[(index + 1) % SUPPORTED_LOCALES.length]
  await changeLocale(next)
}

/** 定位标记的渲染时序，用于区分"从未渲染"与"渲染后被销毁"。 */
let lastLocatorTiming: Record<string, unknown> | null = null

/** 最近一次"跳转到搜索结果"的中间量，供自检定位问题。 */
let lastLocateDiagnostics: Record<string, unknown> | null = null

/**
 * 重置界面设置。
 *
 * 清空 localStorage 里的界面偏好（主题、排版、语言、布局、侧栏尺寸）并重载，
 * 使编辑器回到初始外观。
 *
 * 为什么需要这个功能：界面状态是"粘性"的——用户误设了难以察觉的选项
 * （例如把排版主题切到衬线后忘了）、或某个设置组合导致显示异常时，
 * 没有一条明确的退路。让用户去手动删配置文件是不可接受的。
 *
 * 有意**不清除**最近文件与工作区目录（preferences JSON）：
 * 那些是用户的工作内容痕迹，不属于"界面设置"。
 */
async function resetInterfaceSettings(): Promise<void> {
  const confirmed = window.confirm(
    `${messages().menu.resetUi}\n\n将恢复默认主题、排版、语言与布局，并重新载入界面。\n最近打开记录与文件不受影响。`
  )
  if (!confirmed) return

  for (const key of Object.values(PREFERENCE_KEYS)) {
    window.localStorage.removeItem(key)
  }

  setMessage(messages().status.uiReset, 'info', 1500)

  // 重载而非就地重建：部分状态（内联的自定义主题样式、内联 SVG 尺寸等）
  // 分散在各模块里，就地重置容易漏掉；重载是最可靠且逻辑最短的做法
  window.setTimeout(() => window.location.reload(), 300)
}

/**
 * 检查更新。
 *
 * 三个分支的文案不同，因为用户需要知道的是"我该做什么"：
 * 有新版→提示可下载；已最新→明确告知；不可用→说明只有打包版支持。
 */
async function checkForUpdates(): Promise<void> {
  const label = messages().status.updateStatus

  try {
    const state = await api.update.check()
    switch (state.status) {
      case 'available':
        setMessage(`${label}: ${state.version}`, 'info', 5000)
        break
      case 'up-to-date':
        setMessage(`${label}: ${state.version}`, 'info', 3000)
        break
      case 'unavailable':
        setMessage(`${label}: ${state.message ?? ''}`, 'warn', 4000)
        break
      case 'error':
        setMessage(`${label}: ${state.message ?? ''}`, 'error', 5000)
        break
      default:
        setMessage(`${label}: ${state.status}`, 'info', 3000)
    }
  } catch (error) {
    setMessage(`${label}: ${describeError(error)}`, 'error')
  }
}

/**
 * 当前高亮项在屏幕上的纵坐标。
 *
 * 比滚动位置更直接：它回答的是用户的实际问题——"我看的那一项动了吗"。
 */
function currentHitTop(): number {
  const hit = dom.wysiwygHost.querySelector('.search-hit--current')
  return hit ? hit.getBoundingClientRect().top : 0
}

/** 取编辑区的滚动容器元素，供几何断言使用。 */
function findScrollContainerElement(): HTMLElement | null {
  const view = editor()?.view
  if (!view) return null

  let cursor: HTMLElement | null = view.dom.parentElement
  while (cursor) {
    const overflowY = getComputedStyle(cursor).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight + 1) {
      return cursor
    }
    cursor = cursor.parentElement
  }
  return null
}

/**
 * 按行文本找出它在 markdown 里是第几行（0-based）。
 *
 * 行号在规范化后会漂移，而行文本是确切的；因此以文本为准，
 * 行号仅用于**在多次出现时消歧**（选最接近提示行号的那一处）。
 * 找不到时退回提示行号，保证行为与旧实现一致。
 */
function findLineIndexByText(content: string, lineText: string, hintLine: number): number {
  const target = lineText.trim()
  const fallback = Math.max(0, hintLine - 1)
  if (target.length === 0) return fallback

  const lines = content.split('\n')
  const candidates: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === target) candidates.push(index)
  }

  if (candidates.length === 0) return fallback

  return candidates.reduce((best, index) =>
    Math.abs(index - fallback) < Math.abs(best - fallback) ? index : best
  )
}

/**
 * 读取编辑区滚动容器的当前滚动位置。
 *
 * 用"向上找可滚动祖先"而不是写死 `.wysiwyg-host`：
 * 断言应当验证"内容滚动了"，而不是"某个特定元素滚动了"。
 */
function findScrollOffset(): number {
  const view = editor()?.view
  if (!view) return 0

  let cursor: HTMLElement | null = view.dom.parentElement
  while (cursor) {
    const overflowY = getComputedStyle(cursor).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && cursor.scrollHeight > cursor.clientHeight + 1) {
      return cursor.scrollTop
    }
    cursor = cursor.parentElement
  }
  return 0
}

/**
 * 模拟在块首按下退格。
 *
 * 走**真实的命令链**（与键映射完全相同的入口）而不是直接调用某个命令，
 * 这样才能验证"命令顺序 + 兜底"的整体行为。
 */
function backspaceAtStart(instance: EditorApi): void {
  const keyEvent = {
    key: 'Backspace',
    preventDefault: () => undefined
  } as unknown as KeyboardEvent

  instance.view.someProp('handleKeyDown', (handler) =>
    handler(instance.view, keyEvent as never)
  )
}

/** 供自检读取合并刷新次数。 */
function getExpensiveRefreshCount(): number {
  return expensiveRefreshCount
}

function updateStats(): void {
  if (viewerSession() !== null) {
    const detail = state.viewerDetail
    dom.statusStats.textContent =
      detail === null
        ? messages().status.viewerReadOnly
        : `${detail} · ${messages().status.viewerReadOnly}`
    return
  }

  const text = currentMarkdown()
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g
  const cjk = (text.match(cjkPattern) ?? []).length
  const words = (text.replace(cjkPattern, ' ').match(/[A-Za-z0-9_'’-]+/g) ?? []).length
  const t = messages().status
  dom.statusStats.textContent = `${text.length} ${t.stats} · ${cjk + words} ${t.statsWords} · ${lines} ${t.statsLines}`
}

function updateEncodingChips(): void {
  const session = store.active
  // 只读查看对象没有"编码 / 换行"这回事：PDF 与图片是二进制，
  // 显示 UTF-8 会让人以为可以编辑后原样保存
  if (!session || session.kind === 'viewer') {
    dom.statusEol.textContent = '—'
    dom.statusEncoding.textContent = '—'
    return
  }
  dom.statusEol.textContent = LINE_ENDING_LABEL[session.eol]
  dom.statusEncoding.textContent = ENCODING_LABEL[session.encoding]
}

/* ------------------------------------------------------------------ *
 * 标题栏代理（macOS）
 * ------------------------------------------------------------------ */

let lastRepresentedPath: string | null | undefined

function syncWindowDocumentState(): void {
  const session = store.active
  const dirty = session ? store.isDirty(session) : false
  api.window.setDocumentEdited(dirty)

  const filePath = session?.filePath ?? null
  // 仅在变化时发送：避免每次按键都打一次 IPC
  if (filePath !== lastRepresentedPath) {
    lastRepresentedPath = filePath
    api.window.setRepresentedFilename(filePath)
  }
}

/* ------------------------------------------------------------------ *
 * 视图刷新
 * ------------------------------------------------------------------ */

function updateFormatButtons(): void {
  const current = editor()
  if (!current || state.mode === 'raw') {
    dom.formatGroup.dataset.disabled = 'true'
    dom.formatGroup.querySelectorAll('button').forEach((button) => {
      button.classList.remove('is-active')
      button.setAttribute('disabled', '')
    })
    return
  }

  dom.formatGroup.dataset.disabled = 'false'

  /**
   * 先**统一清除** disabled，再按需重新设置。
   *
   * 不能依赖"上一次是谁设置的 disabled"：源码模式会禁用整组按钮，
   * 而回到所见即所得时只有带 `data-format` 的按钮会被清除——
   * 「插入表格」既没有 `data-format`、又被下面的表格循环跳过（只处理非 insert），
   * 于是**永久保持灰色**。用户表现：切一次源码再切回来，就再也插不了表格。
   *
   * 先清空再设置，让每个分支只负责自己的规则，不存在需要别人收尾的状态。
   */
  dom.formatGroup.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.removeAttribute('disabled')
  })

  const editorState = current.state
  const headingLevel = activeHeadingLevel(editorState)
  const blockKind = activeBlockKind(editorState)
  const inTable = tableContext(editorState).inTable

  /**
   * 表格的行列操作按钮只在表格内出现（样式表按该属性隐藏）。
   *
   * 原先只是把它们禁用，但它们仍占着工具栏宽度、也持续分散注意力。
   * "插入表格"始终可见——它是进入表格的唯一入口，因此永不因表格上下文被禁用。
   */
  dom.formatGroup.dataset.inTable = String(inTable)
  for (const button of dom.formatGroup.querySelectorAll<HTMLButtonElement>('[data-table]')) {
    if (button.dataset.table !== 'insert') button.disabled = !inTable
  }

  for (const button of dom.formatGroup.querySelectorAll<HTMLButtonElement>('button')) {
    const format = button.dataset.format
    if (!format) continue

    let active: boolean
    if (format.startsWith('heading:')) {
      active = headingLevel === Number(format.slice('heading:'.length))
    } else if (format === 'bullet-list' || format === 'ordered-list') {
      active = blockKind === 'list'
    } else if (format === 'blockquote') {
      active = blockKind === 'blockquote'
    } else {
      active = isMarkActive(editorState, format)
    }

    button.classList.toggle('is-active', active)
  }
}

function renderTabs(): void {
  tabBar.render(
    store.list().map((session) => ({
      id: session.id,
      title: session.title,
      dirty: store.isDirty(session),
      untitled: session.filePath === null
    })),
    store.active?.id ?? null
  )
  dom.statusTabs.textContent = formatTabCount(store.list().length)
}

function refreshOutline(): void {
  state.outline = buildOutline(currentMarkdown())
  outlineView.render(state.outline, currentOutlineIndex())
}

function currentOutlineIndex(): number | null {
  const current = editor()
  if (!current || state.outline.length === 0) return null
  return activeOutlineIndex(state.outline, current.state.selection.from)
}

/**
 * 单一刷新入口。
 *
 * 拆成两段：
 *  - 立即部分（标签栏、编码指示、工具栏高亮、文件树选中）都是 O(标签数) 或 O(1)，
 *    必须即时更新，否则脏标记与按钮状态会显得迟钝
 *  - 昂贵部分（统计、大纲、预览）走合并调度，见上方说明
 *
 * `immediateExpensive` 用于装载文档、切标签这类"用户正在等结果"的场景。
 */
function refreshAll(options: { immediateExpensive?: boolean } = {}): void {
  // 首次保存、另存为、重命名、新建和切标签都通过会话订阅更新图片目录。
  imageResolver.setBaseDirectory(activeDocumentDirectory())
  renderTabs()
  syncWindowDocumentState()
  updateEncodingChips()
  updateFormatButtons()
  updateViewerChrome()
  applySurface()

  const session = store.active
  fileTree.setActiveFile(session?.filePath ?? null)

  if (options.immediateExpensive) flushExpensiveRefresh()
  else scheduleExpensiveRefresh()
}

/* ------------------------------------------------------------------ *
 * 侧边栏
 * ------------------------------------------------------------------ */

function setSidebarVisible(visible: boolean): void {
  state.sidebarVisible = visible
  dom.workbench.dataset.sidebar = visible ? 'visible' : 'hidden'
  window.localStorage.setItem(PREFERENCE_KEYS.sidebar, visible ? '1' : '0')
}

function setSidePanel(panel: 'files' | 'outline' | 'search'): void {
  state.sidePanel = panel
  window.localStorage.setItem(PREFERENCE_KEYS.sidePanel, panel)

  for (const button of dom.sidebar.querySelectorAll<HTMLButtonElement>('.sidebar__tab')) {
    button.classList.toggle('is-active', button.dataset.panel === panel)
  }
  for (const section of dom.sidebar.querySelectorAll<HTMLElement>('.sidebar__panel')) {
    section.hidden = section.dataset.panel !== panel
  }

  if (panel === 'search') searchPanel.focus()
  if (panel === 'outline') {
    refreshOutline()
  }
}

function bindSidebarResizer(): void {
  const stored = Number(window.localStorage.getItem(PREFERENCE_KEYS.sidebarWidth))
  if (Number.isFinite(stored) && stored >= 160 && stored <= 640) {
    dom.workbench.style.setProperty('--sidebar-width', `${stored}px`)
  }

  let dragging = false

  dom.sidebarResizer.addEventListener('mousedown', (event) => {
    dragging = true
    event.preventDefault()
    document.body.classList.add('is-resizing')
  })

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    const workbenchLeft = dom.workbench.getBoundingClientRect().left
    const width = Math.max(160, Math.min(event.clientX - workbenchLeft, 640))
    dom.workbench.style.setProperty('--sidebar-width', `${width}px`)
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove('is-resizing')

    const width = dom.workbench.style.getPropertyValue('--sidebar-width')
    const parsed = Number.parseFloat(width)
    if (Number.isFinite(parsed)) {
      window.localStorage.setItem(PREFERENCE_KEYS.sidebarWidth, String(Math.round(parsed)))
    }
  })
}

/* ------------------------------------------------------------------ *
 * 工作区
 * ------------------------------------------------------------------ */

async function openWorkspace(): Promise<void> {
  try {
    const directory = await api.workspace.chooseDirectory()
    if (!directory) return
    await setWorkspace(directory)
    setMessage(`${messages().status.workspaceIs}${directory}`, 'info', 3200)
  } catch (error) {
    setMessage(`${messages().error.openFolderFailed}：${describeError(error)}`, 'error')
  }
}

async function setWorkspace(directory: string): Promise<void> {
  state.workspacePath = directory
  dom.workspacePath.textContent = directory
  dom.workspacePath.title = directory
  // 路径栏只在有路径可显示时才出现：空工作区时它与文件树空状态重复
  dom.workspacePath.hidden = false

  // 切换工作区：先退订旧的，避免事件串台与监听器泄漏
  unwatchWorkspace?.()
  unwatchWorkspace = api.workspace.watch(directory, () => {
    void refreshWorkspaceTree()
  })

  await refreshWorkspaceTree()
  searchPanel.setWorkspaceReady(true)
  setSidePanel('files')
}

async function refreshWorkspaceTree(): Promise<void> {
  if (!state.workspacePath) return
  try {
    state.workspaceTree = await api.workspace.readTree(state.workspacePath)
    fileTree.render(state.workspaceTree)
    if (state.workspaceTree.truncated) {
      setMessage(messages().status.workspaceTooLarge, 'warn', 4000)
    }
  } catch (error) {
    setMessage(`${messages().error.readTreeFailed}：${describeError(error)}`, 'error')
  }
}

function isInsideWorkspace(targetPath: string): boolean {
  if (!state.workspacePath) return false
  return targetPath.startsWith(state.workspacePath)
}

function openWorkspaceFile(filePath: string): void {
  if (!isOpenablePath(filePath)) {
    setMessage(`${baseName(filePath)} ${messages().error.unsupportedDocument}`, 'warn', 3000)
    return
  }
  void openDocumentByPath(filePath)
}

async function handleCreateFile(parentDirectory: string, name: string): Promise<void> {
  if (!state.workspacePath) throw new Error('未打开工作区')
  const targetPath = `${parentDirectory}/${name}`
  await api.workspace.createFile(state.workspacePath, targetPath, '')
  await refreshWorkspaceTree()
  await openDocumentByPath(targetPath)
}

async function handleCreateDirectory(parentDirectory: string, name: string): Promise<void> {
  if (!state.workspacePath) throw new Error('未打开工作区')
  await api.workspace.createDirectory(state.workspacePath, `${parentDirectory}/${name}`)
  await refreshWorkspaceTree()
}

async function handleRename(targetPath: string, name: string): Promise<void> {
  if (!state.workspacePath) throw new Error('未打开工作区')

  const separatorIndex = targetPath.lastIndexOf('/')
  const parentDirectory = separatorIndex > 0 ? targetPath.slice(0, separatorIndex) : state.workspacePath
  const previousName = targetPath.slice(separatorIndex + 1)

  // 用户只改主名时保留原扩展名：否则 .md 会在重命名中悄悄消失
  const previousExtension = previousName.includes('.') ? previousName.slice(previousName.lastIndexOf('.')) : ''
  const hasExtension = name.includes('.')
  const finalName = hasExtension || previousExtension.length === 0 ? name : `${name}${previousExtension}`

  const toPath = `${parentDirectory}/${finalName}`

  await api.workspace.rename(state.workspacePath, targetPath, toPath)
  // 同步已打开会话的路径，否则保存会写回旧文件名
  store.updatePathPrefix(targetPath, toPath)
  // 改扩展名会改变文档类型（.md ↔ .txt），编辑表面要跟着切
  syncModeWithActiveDocument(store.active?.markdown ?? '')
  // 查看会话渲染的是旧路径的内容，改名后必须重画
  const renamedViewer = viewerSession()
  if (renamedViewer !== null) {
    viewerRenderedId = null
    void showViewerSession(renamedViewer)
  }
  await refreshWorkspaceTree()
  lastRepresentedPath = undefined
  refreshAll()
  setMessage(`${messages().status.renamed} ${finalName}`, 'info', 2600)
}

async function handleDelete(targetPath: string): Promise<void> {
  if (!state.workspacePath) throw new Error('未打开工作区')

  const name = baseName(targetPath)
  const affected = store.list().filter((session) => session.filePath?.startsWith(targetPath))
  const warning =
    affected.length > 0
      ? `\n\n有 ${affected.length} 个已打开的标签引用了它（内容会保留为未保存状态）。`
      : ''

  // 破坏性操作走原生确认框；自定义非阻塞确认框留待 L5 的 UI 打磨
  if (!window.confirm(`确定删除「${name}」？此操作不可撤销。${warning}`)) return

  await api.workspace.remove(state.workspacePath, targetPath)
  store.updatePathPrefix(targetPath, null)
  await refreshWorkspaceTree()
  refreshAll()
  setMessage(`${messages().status.deleted} ${name}`, 'warn', 3000)
}

/* ------------------------------------------------------------------ *
 * 模式与布局
 * ------------------------------------------------------------------ */

function setLayout(layout: ViewLayout): void {
  state.layout = layout
  window.localStorage.setItem(PREFERENCE_KEYS.layout, layout)
  applySurface()
  if (layout !== 'source' && viewerSession() === null) renderPreview()
  updatePreviewToggleButton()
}

/**
 * 显示区开关：按钮长在内容区右上角，语义跟着所在区域走。
 *
 * 分屏时按钮在显示区里，点它收起（→ 仅编辑区）；仅编辑区时按钮落在编辑区里，
 * 点它恢复分屏；仅预览时按钮在显示区里，点它把编辑区叫回来（→ 分屏）。
 * 三种布局下按钮都落在同一个屏幕角落，位置不跳。
 * 三态循环（分屏 → 仅编辑 → 仅预览）仍只由菜单"切换布局"（⇧⌘V）提供。
 */
function togglePreviewPane(): void {
  setLayout(state.layout === 'split' ? 'source' : 'split')
}

/** 图标画当前布局、title 说明将要执行的动作，两者都随状态与语言变化。 */
function updatePreviewToggleButton(): void {
  const stateByLayout: Record<ViewLayout, { icon: string; title: string }> = {
    split: { icon: 'visible', title: messages().toolbar.hidePreview },
    source: { icon: 'hidden', title: messages().toolbar.showPreview },
    preview: { icon: 'reading', title: messages().toolbar.restoreSplit }
  }
  const { icon, title } = stateByLayout[state.layout]
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="toggle-preview"]'
  )) {
    button.dataset.preview = icon
    button.title = title
  }
}

/* ------------------------------------------------------------------ *
 * 编辑区 / 显示区滚动联动
 * ------------------------------------------------------------------ */

/** 编辑区的滚动容器：所见即所得是宿主元素，源码模式是 textarea。 */
function editorScroller(): HTMLElement {
  return state.mode === 'wysiwyg' ? dom.wysiwygHost : dom.rawEditor
}

/**
 * 最近一次由联动写入的滚动位置。
 *
 * 用来吃掉"自己写进去的 scrollTop 引发的 scroll 事件"：
 * 不吃掉就会形成 编辑区→显示区→编辑区 的回环。
 * 比起基于时间戳的锁，这个判据没有"锁定期内用户滚动被忽略"的死角。
 */
let programmedScroll: { element: HTMLElement; top: number } | null = null

function isOwnScroll(target: HTMLElement): boolean {
  if (programmedScroll === null) return false
  if (target !== programmedScroll.element) return false
  // 浏览器会把 scrollTop 钳制到可滚范围，钳制后的差值可能超过取整误差
  if (Math.abs(target.scrollTop - programmedScroll.top) < 2) {
    programmedScroll = null
    return true
  }
  programmedScroll = null
  return false
}

/**
 * 按比例把一侧的滚动位置映射到另一侧。
 *
 * 选比例映射而非"按块对齐"：预览由 markdown 逐行构建（空行也是 `<br>`），
 * 与内核的块结构并不一一对应，块级对齐在多数文档上都会错排。
 * 比例映射保证两端的首尾严格对齐，代价是中部按高度比例近似。
 */
function syncScroll(source: 'editor' | 'preview'): void {
  if (state.layout !== 'split' || viewerSession() !== null) return
  const from = source === 'editor' ? editorScroller() : dom.preview
  const to = source === 'editor' ? dom.preview : editorScroller()
  const fromMax = from.scrollHeight - from.clientHeight
  const toMax = to.scrollHeight - to.clientHeight
  if (fromMax <= 0 || toMax <= 0) return
  const top = (from.scrollTop / fromMax) * toMax
  programmedScroll = { element: to, top }
  to.scrollTop = top
}

function bindScrollSync(): void {
  // scroll 事件不冒泡，但捕获阶段能收到任意后代的滚动；
  // 这样内核重挂（切标签）或切模式换了滚动容器时都不必重新绑定
  dom.editorArea.addEventListener(
    'scroll',
    (event) => {
      const target = event.target
      if (target === dom.preview) {
        if (!isOwnScroll(dom.preview)) syncScroll('preview')
      } else if (target === editorScroller()) {
        if (!isOwnScroll(editorScroller())) syncScroll('editor')
      }
    },
    true
  )
}

function setMode(mode: EditMode): void {
  if (viewerSession() !== null) {
    setMessage(messages().status.viewerReadOnly, 'warn', 4000)
    return
  }
  if (mode === 'wysiwyg' && isPlainTextPath(store.active?.filePath ?? null)) {
    setMessage(messages().status.plainTextSourceOnly, 'warn', 4000)
    return
  }

  state.preferredMode = mode
  window.localStorage.setItem(PREFERENCE_KEYS.mode, mode)
  if (mode === state.mode) return

  showMode(mode, currentMarkdown())
  refreshAll()
}

/** 模式按钮文案随状态变化，不能用静态 data-i18n 标注。 */
function updateModeButton(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-action="toggle-mode"]')
  if (button) {
    button.textContent = state.mode === 'wysiwyg' ? messages().toolbar.source : messages().toolbar.wysiwyg
  }
}

/** 当前文档允许的模式：纯文本只能源码，Markdown 用用户偏好。 */
function modeForActiveDocument(): EditMode {
  return isPlainTextPath(store.active?.filePath ?? null) ? 'raw' : state.preferredMode
}

/**
 * 把文本装进源码文本框。
 *
 * 给 `value` 赋值会把光标甩到文本末尾（浏览器行为），随后 `focus()`
 * 又滚动到光标处——表现为"打开文件后光标停在最下面"。因此每次装载
 * 都必须显式决定光标位置：
 *  - `caretAtStart`：换文档/新建文档，光标与滚动都回文首
 *  - 否则：内容变了也尽量保持原光标与滚动位置（保存回写、重命名）；
 *    内容完全相同时什么都不做，避免打断正在输入的手
 */
function loadRawText(content: string, caretAtStart = false): void {
  const textarea = dom.rawEditor
  if (textarea.value === content) {
    if (caretAtStart) {
      textarea.setSelectionRange(0, 0)
      textarea.scrollTop = 0
    }
    return
  }

  const selectionStart = textarea.selectionStart
  const selectionEnd = textarea.selectionEnd
  const scrollTop = textarea.scrollTop

  textarea.value = content

  if (caretAtStart) {
    textarea.setSelectionRange(0, 0)
    textarea.scrollTop = 0
  } else {
    textarea.setSelectionRange(
      Math.min(selectionStart, content.length),
      Math.min(selectionEnd, content.length)
    )
    textarea.scrollTop = scrollTop
  }
}

/**
 * 切换编辑表面（不写偏好）。
 *
 * `content` 是新表面要显示的文本，必须由调用方给出：换文档时旧表面里
 * 还留着上一个文档的内容，此时读 `currentMarkdown()` 只会把上一个文档
 * 搬进当前文档——源码模式下切标签曾因此串文档。
 * `caretAtStart` 表示这次装载是"换了一份文档"，光标应回文首。
 */
function showMode(mode: EditMode, content: string, caretAtStart = false): void {
  if (mode === 'raw') {
    loadRawText(content, caretAtStart)
    dom.rawEditor.hidden = false
    dom.wysiwygHost.hidden = true
    dom.rawEditor.focus()
  } else {
    /**
     * 内容未变时**不要**重设文档。
     *
     * `setMarkdown` 会整篇替换文档，光标因此被重置到文档开头——
     * 用户表现为"切到源码再切回来，光标位置丢了，表格按钮也变灰了"
     * （表格上下文随光标一起丢失）。
     *
     * 只有源码模式下真的改过内容时才需要同步回内核。
     */
    const instance = editor()
    if (instance && instance.getMarkdown() !== content) instance.setMarkdown(content)

    dom.rawEditor.value = ''
    dom.rawEditor.hidden = true
    dom.wysiwygHost.hidden = false
    instance?.focus()
  }

  state.mode = mode
  dom.editorArea.dataset.mode = mode
  updateModeButton()
}

/**
 * 让编辑表面与当前文档类型一致，`content` 为该会话的权威文本。
 *
 * 打开、切换标签、另存为、重命名都要过这一关：
 * 纯文本文档一旦被留在所见即所得里，下次保存就会用 Markdown
 * 序列化结果覆盖用户文件（`*` → `\*`、单换行被合并）。
 */
function syncModeWithActiveDocument(content: string, caretAtStart = false): void {
  // 查看会话没有文本可装，也不该按扩展名推断模式（.pdf 既非 Markdown 也非纯文本）
  if (viewerSession() !== null) return
  const target = modeForActiveDocument()
  if (target !== state.mode) {
    showMode(target, content, caretAtStart)
    refreshAll()
  } else if (target === 'raw') {
    loadRawText(content, caretAtStart)
  }
}

function setTheme(theme: 'light' | 'dark'): void {
  state.theme = theme
  dom.root.dataset.theme = theme
  window.localStorage.setItem(PREFERENCE_KEYS.theme, theme)
}

function setThemeVariant(variant: ThemeVariant): void {
  state.themeVariant = variant
  dom.root.dataset.variant = variant
  window.localStorage.setItem(PREFERENCE_KEYS.themeVariant, variant)

  const button = document.querySelector<HTMLButtonElement>('[data-action="theme-variant"]')
  if (button) button.textContent = themeVariantLabel(variant)
}

function cycleThemeVariant(): void {
  const next = THEME_VARIANTS[(THEME_VARIANTS.indexOf(state.themeVariant) + 1) % THEME_VARIANTS.length]
  setThemeVariant(next)
  setMessage(`${messages().status.themeVariantIs}${themeVariantLabel(next)}`, 'info', 2200)
}

/**
 * 注入自定义主题 CSS。
 *
 * 用一个固定的 `<style>` 元素而非逐条改样式属性：用户提供的 CSS 是任意的，
 * 只有让浏览器整体解析才能支持选择器、媒体查询等完整能力。
 * 位置放在所有内置样式之后，因此自定义规则天然具有更高优先级。
 */
function injectCustomTheme(css: string | null): void {
  const existing = document.getElementById('custom-theme')
  if (!css) {
    existing?.remove()
    return
  }

  const style = (existing as HTMLStyleElement | null) ?? document.createElement('style')
  style.id = 'custom-theme'
  style.textContent = css
  if (!existing) document.body.appendChild(style)
}

/** 在"导入主题"按钮上标出当前是否在用自定义主题。 */
function markCustomThemeActive(active: boolean): void {
  const button = document.querySelector<HTMLButtonElement>('[data-action="theme-import"]')
  if (!button) return
  if (active) button.dataset.customTheme = 'true'
  else delete button.dataset.customTheme
}

async function importCustomTheme(): Promise<void> {
  try {
    const chosen = await api.theme.chooseCss()
    if (!chosen) return

    state.customThemePath = chosen.path
    window.localStorage.setItem(PREFERENCE_KEYS.customThemePath, chosen.path)
    injectCustomTheme(chosen.css)
    markCustomThemeActive(true)
    setMessage(`${messages().status.customThemeApplied}${baseName(chosen.path)}`, 'info', 3000)
  } catch (error) {
    setMessage(`${messages().error.importThemeFailed}：${describeError(error)}`, 'error')
  }
}

function clearCustomTheme(): void {
  state.customThemePath = null
  window.localStorage.removeItem(PREFERENCE_KEYS.customThemePath)
  injectCustomTheme(null)
  markCustomThemeActive(false)
  setMessage(messages().status.customThemeCleared, 'info', 2400)
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/**
 * 生成自包含的导出 HTML。
 *
 * 三个阶段：文档 → HTML → 内联图片。图片必须内联，因为导出结果
 * 会经 `data:` URL 加载进隐藏窗口打印，该来源下任何本地路径资源都会被拦。
 */
async function buildExportDocument(): Promise<{ html: string; missing: string[] }> {
  const current = editor()
  if (!current) throw new Error('当前没有可导出的文档')

  const bodyHtml = documentToHtml(current.state.doc)
  const inlined = await inlineImages(bodyHtml, activeDocumentDirectory(), api.assets)

  return {
    html: buildExportHtml({
      title: store.active?.title ?? messages().app.untitled,
      bodyHtml: inlined.html
    }),
    missing: inlined.missing
  }
}

function suggestedExportName(extension: string): string {
  const title = store.active?.title ?? messages().app.untitled
  // 去掉原扩展名再换新的，避免出现 `note.md.pdf`
  const stem = title.replace(/\.(md|markdown|mdown|mkd|mdx|txt)$/i, '')
  return `${stem}.${extension}`
}

async function exportHtml(targetPath?: string): Promise<void> {
  try {
    const document_ = await buildExportDocument()
    const result = await api.export.html({
      html: document_.html,
      suggestedName: suggestedExportName('html'),
      ...(targetPath ? { targetPath } : {})
    })
    if (result.canceled) return

    reportExportResult('HTML', result.filePath, document_.missing)
  } catch (error) {
    setMessage(`${messages().error.exportHtmlFailed}：${describeError(error)}`, 'error')
  }
}

async function exportPdf(targetPath?: string): Promise<void> {
  const current = editor()
  if (!current) return

  setMessage(messages().status.generatingPdf, 'info')

  try {
    const document_ = await buildExportDocument()
    const result = await api.export.pdf({
      html: document_.html,
      suggestedName: suggestedExportName('pdf'),
      ...(targetPath ? { targetPath } : {})
    })
    if (result.canceled) {
      setMessage(messages().status.canceled, 'info', 2000)
      return
    }

    reportExportResult('PDF', result.filePath, document_.missing, result.byteLength)
  } catch (error) {
    setMessage(`${messages().error.exportPdfFailed}：${describeError(error)}`, 'error')
  }
}

function reportExportResult(
  format: string,
  filePath: string | null,
  missing: string[],
  byteLength?: number
): void {
  const size = byteLength ? `（${(byteLength / 1024).toFixed(0)} KB）` : ''
  const base = `已导出 ${format}${size}：${filePath ? baseName(filePath) : ''}`

  if (missing.length > 0) {
    setMessage(`${base}　${missing.length} ${messages().status.exportMissingImages}`, 'warn', 6000)
  } else {
    setMessage(base, 'info', 3600)
  }
}

/* ------------------------------------------------------------------ *
 * 预览（源码模式下的 markdown 对照渲染）
 * ------------------------------------------------------------------ */

/**
 * 预览渲染器。
 *
 * 手写的逐行渲染器，而不是复用编辑器内核：预览是只读视图，
 * 不需要 ProseMirror 的文档模型，逐行足以覆盖导出前要看的语法。
 *
 * 表格需要**向前看一行**（分隔行）才能与普通含竖线的段落区分，
 * 因此循环用下标而非 for-of，表格分支会消费多行。
 */
function renderPreview(): void {
  const source = currentMarkdown()
  const fragment = document.createDocumentFragment()
  const lines = source.length === 0 ? [''] : source.split('\n')

  let fence: { language: string; lines: string[] } | null = null
  let list: HTMLElement | null = null

  const flushList = (): void => {
    if (list) {
      fragment.appendChild(list)
      list = null
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]

    const fenceMatch = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(rawLine)

    if (fenceMatch) {
      flushList()
      if (fence) {
        fragment.appendChild(buildCodeBlock(fence.language, fence.lines.join('\n')))
        fence = null
      } else {
        fence = { language: fenceMatch[2] ?? '', lines: [] }
      }
      continue
    }

    if (fence) {
      fence.lines.push(rawLine)
      continue
    }

    /**
     * 表格识别条件：当前行含竖线，且**下一行是分隔行**。
     *
     * 只看"含竖线"不够——普通段落里也会出现 `a | b`。
     * 分隔行（`| --- | :--: |`）是表格唯一可靠的标志。
     */
    if (rawLine.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushList()

      const header = parseTableRow(rawLine)
      const alignments = parseTableRow(lines[index + 1]).map(tableAlignment)

      index += 2

      const rows: string[][] = []
      while (index < lines.length) {
        const rowLine = lines[index]
        // 空行或新的块级语法（标题/围栏/引用）即表格结束
        if (rowLine.trim().length === 0) break
        if (!rowLine.includes('|')) break
        if (/^\s*(```|~~~)/.test(rowLine)) break

        rows.push(parseTableRow(rowLine))
        index += 1
      }

      // for 循环还会再 index += 1，这里回退一次以正确定位到表格之后的行
      index -= 1

      fragment.appendChild(buildPreviewTable(header, alignments, rows))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (heading) {
      flushList()
      const level = Math.min(heading[1].length, 6)
      const element = document.createElement(`h${level}`)
      element.className = `md-heading md-heading--${level}`
      appendInline(element, heading[2])
      fragment.appendChild(element)
      continue
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(rawLine)) {
      flushList()
      fragment.appendChild(document.createElement('hr'))
      continue
    }

    const quote = /^>\s?(.*)$/.exec(rawLine)
    if (quote) {
      flushList()
      const element = document.createElement('blockquote')
      element.className = 'md-quote'
      appendInline(element, quote[1])
      fragment.appendChild(element)
      continue
    }

    const bullet = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(rawLine)
    if (bullet) {
      if (!list) {
        list = document.createElement('div')
        list.className = 'md-list'
      }
      const item = document.createElement('div')
      item.className = 'md-list-item'
      const marker = document.createElement('span')
      marker.className = 'md-list-marker'
      marker.textContent = /^\d/.test(bullet[2]) ? bullet[2] : '•'
      item.appendChild(marker)
      // 行内内容必须包进单个容器：`.md-list-item` 是 flex（标记 + 内容两栏），
      // 若把行内节点直接挂到 item 上，每个文本段/粗体/代码都会各自成为一个
      // flex 项并排铺开——含行内标记的列表项会被拆成好几列
      const content = document.createElement('span')
      content.className = 'md-list-content'
      appendInline(content, bullet[3])
      item.appendChild(content)
      list.appendChild(item)
      continue
    }

    flushList()

    if (rawLine.trim().length === 0) {
      fragment.appendChild(document.createElement('br'))
      continue
    }

    const paragraph = document.createElement('div')
    paragraph.className = 'md-paragraph'
    appendInline(paragraph, rawLine)
    fragment.appendChild(paragraph)
  }

  flushList()
  if (fence) fragment.appendChild(buildCodeBlock(fence.language, fence.lines.join('\n')))

  dom.preview.replaceChildren(fragment)
}

/**
 * 按未转义的竖线切分表格行。
 *
 * 单元格里的 `\\|` 表示字面竖线，不能当作列分隔符——
 * 否则一个含竖线的代码片段会把整行切错列。
 * 首尾竖线可省略（GFM 允许 `a | b` 这种写法）。
 */
function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]

    if (character === '\\' && trimmed[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }

    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += character
  }

  cells.push(current.trim())
  return cells
}

/** 分隔行：每个单元格都是 `---` / `:---` / `:---:` / `---:` 之一。 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false
  const cells = parseTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell))
}

/** 由分隔行的冒号位置得出对齐方式；无冒号时返回 null（不写 style）。 */
function tableAlignment(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/**
 * 构造预览表格。
 *
 * 列数以表头为准：数据行的多余单元格被丢弃，不足的补空单元格——
 * 与 GFM 的截断/补齐语义一致，也避免表格出现参差不齐的列。
 */
function buildPreviewTable(
  header: string[],
  alignments: (string | null)[],
  rows: string[][]
): HTMLElement {
  const columnCount = Math.max(header.length, 1)

  const table = document.createElement('table')
  table.className = 'md-table'

  const applyAlignment = (cell: HTMLTableCellElement, column: number): void => {
    const alignment = alignments[column]
    if (alignment) cell.style.textAlign = alignment
  }

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (let column = 0; column < columnCount; column += 1) {
    const th = document.createElement('th')
    applyAlignment(th, column)
    appendInline(th, header[column] ?? '')
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  if (rows.length > 0) {
    const tbody = document.createElement('tbody')
    for (const row of rows) {
      const tr = document.createElement('tr')
      for (let column = 0; column < columnCount; column += 1) {
        const td = document.createElement('td')
        applyAlignment(td, column)
        appendInline(td, row[column] ?? '')
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
  }

  return table
}

/**
 * 预览里的图片路径解析。
 *
 * 与编辑态用同一套解析器，因此「缺失」的判定标准一致——
 * 两处显示不同状态会让用户无法判断到底哪边是准的。
 */
async function resolvePreviewImage(image: HTMLImageElement, source: string): Promise<void> {
  try {
    const absolute = await api.assets.resolve({ target: source, baseDirectory: activeDocumentDirectory() })
    if (!absolute) {
      const placeholder = document.createElement('span')
      placeholder.className = 'md-image-missing'
      placeholder.textContent = `${messages().error.imageMissing}：${source}`
      image.replaceWith(placeholder)
      return
    }
    const normalized = absolute.replace(/\\/g, '/')
    const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
    image.src = `file://${prefixed.split('/').map(encodeURIComponent).join('/')}`
  } catch {
    image.remove()
  }
}

function buildCodeBlock(language: string, code: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'md-code-block'
  if (language) {
    const label = document.createElement('div')
    label.className = 'md-code-lang'
    label.textContent = language
    wrapper.appendChild(label)
  }
  const pre = document.createElement('pre')
  pre.textContent = code
  wrapper.appendChild(pre)
  return wrapper
}

/**
 * 反斜杠转义必须先屏蔽、再跑行内规则。
 *
 * `\*\*` 在 markdown 里是字面星号；但行内正则只认星号本身：不屏蔽的话，
 * 两对转义星号会被配成一段"粗体"，反斜杠还会原样漏进显示——
 * 预览与编辑区就此分家（用户报告的"预览把 /his-server/api/** 显示错了"正是它）。
 * 做法是先把被转义的字符换成私用区占位符，行内规则扫完后再还原进文本。
 */
const ESCAPE_OPEN = '\uE000'
const ESCAPE_CLOSE = '\uE001'

function appendInline(parent: HTMLElement, text: string): void {
  const escapedCharacters: string[] = []
  const shielded = text.replace(/\\([!-/:-@\[-`{-~\]])/g, (_all, character: string) => {
    escapedCharacters.push(character)
    return `${ESCAPE_OPEN}${escapedCharacters.length - 1}${ESCAPE_CLOSE}`
  })
  const unshield = (value: string): string =>
    value.replace(
      new RegExp(`${ESCAPE_OPEN}(\\d+)${ESCAPE_CLOSE}`, 'g'),
      (_all, index: string) => escapedCharacters[Number(index)] ?? ''
    )

  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(shielded)) !== null) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(unshield(shielded.slice(cursor, match.index))))
    }

    const token = match[0]

    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = unshield(token.slice(1, -1))
      parent.appendChild(code)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong')
      strong.textContent = unshield(token.slice(2, -2))
      parent.appendChild(strong)
    } else if (token.startsWith('~~')) {
      const strike = document.createElement('s')
      strike.textContent = unshield(token.slice(2, -2))
      parent.appendChild(strike)
    } else if (token.startsWith('*')) {
      const em = document.createElement('em')
      em.textContent = unshield(token.slice(1, -1))
      parent.appendChild(em)
    } else if (token.startsWith('![')) {
      const imageMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)
      if (imageMatch) {
        const image = document.createElement('img')
        image.className = 'md-image'
        image.alt = unshield(imageMatch[1])
        image.dataset.source = unshield(imageMatch[2])
        image.src = ''
        // 预览是只读视图，路径解析异步完成后再填 src，避免阻塞渲染
        void resolvePreviewImage(image, imageMatch[2])
        parent.appendChild(image)
      } else {
        parent.appendChild(document.createTextNode(unshield(token)))
      }
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (linkMatch) {
        const anchor = document.createElement('a')
        anchor.textContent = unshield(linkMatch[1])
        anchor.className = 'md-link'
        anchor.dataset.href = unshield(linkMatch[2])
        anchor.setAttribute('role', 'link')
        anchor.tabIndex = 0
        parent.appendChild(anchor)
      } else {
        parent.appendChild(document.createTextNode(unshield(token)))
      }
    }

    cursor = match.index + token.length
  }

  if (cursor < shielded.length) {
    parent.appendChild(document.createTextNode(unshield(shielded.slice(cursor))))
  }
}

/* ------------------------------------------------------------------ *
 * 文档生命周期
 * ------------------------------------------------------------------ */

async function openDocument(): Promise<void> {
  try {
    const result = await api.file.openDialog()
    if (result.canceled || !result.filePath) return
    if (result.document) {
      store.createFromDocument(result.filePath, result.document)
      afterSessionActivated(result.filePath)
      return
    }
    // 主进程只对可编辑文档做文本解码，PDF / HTML / 图片交回这里按只读对象打开
    await openViewerByPath(result.filePath)
  } catch (error) {
    setMessage(`${messages().error.openFailed}：${describeError(error)}`, 'error')
  }
}

async function openDocumentByPath(filePath: string): Promise<void> {
  const kind = viewerKindOf(filePath)
  if (kind !== null) {
    await openViewerByPath(filePath)
    return
  }
  try {
    const document_ = await api.file.read(filePath, false)
    store.createFromDocument(filePath, document_)
    afterSessionActivated(filePath)
  } catch (error) {
    setMessage(`${messages().error.openFailed}：${describeError(error)}`, 'error')
  }
}

/**
 * 以只读查看会话打开 PDF / HTML / 图片。
 *
 * HTML 先试读一次再建会话：读不出来就别留一个空标签，
 * 那会让人误以为文件本身是空的。
 */
async function openViewerByPath(filePath: string): Promise<void> {
  const kind = viewerKindOf(filePath)
  if (kind === null) {
    setMessage(`${baseName(filePath)} ${messages().error.unsupportedDocument}`, 'warn', 4000)
    return
  }

  let html: string | undefined
  if (kind === 'html') {
    try {
      html = (await api.file.read(filePath, false)).content
    } catch (error) {
      setMessage(`${messages().error.openFailed}：${describeError(error)}`, 'error')
      return
    }
  }

  const session = store.createViewer(filePath, kind)
  viewerRenderedId = null
  afterSessionActivated(filePath)
  await showViewerSession(session, html)
}

/**
 * 渲染查看会话。
 *
 * 顺序有讲究：`applySurface()` 必须先把查看面板显示出来再渲染——
 * 隐藏元素的 `clientWidth` 是 0，PDF 会据此算出错误的缩放比。
 */
async function showViewerSession(session: Session, html?: string): Promise<void> {
  const filePath = session.filePath
  const kind = session.viewerKind
  if (filePath === null || kind === null) return

  state.viewerDetail = messages().status.viewerLoading
  refreshAll()

  const superseded = (): boolean => store.active?.id !== session.id
  try {
    // 切回查看标签时 html 参数是空的，就地补读一次
    const source =
      kind === 'html' ? html ?? (await api.file.read(filePath, false)).content : undefined
    if (superseded()) return
    const outcome = await viewer.show({ filePath, kind, html: source })
    if (superseded()) return
    viewerRenderedId = session.id
    state.viewerDetail = outcome.detail
    if (outcome.error !== null) setMessage(outcome.error, 'error')
    else if (outcome.notice !== null) setMessage(outcome.notice, 'warn', 6000)
  } catch (error) {
    if (superseded()) return
    state.viewerDetail = null
    setMessage(`${messages().error.viewerFailed}：${describeError(error)}`, 'error')
  }
  // 用户正在等这个文件显示出来，统计与状态栏不能走合并调度
  refreshAll({ immediateExpensive: true })
}

function afterSessionActivated(filePath: string | null): void {
  // 未命名文档不提供无意义的工作区展开
  if (filePath && state.workspacePath && isInsideWorkspace(filePath)) {
    fileTree.revealPath(filePath)
  }

  const viewing = viewerSession()
  if (viewing !== null) {
    // 只读对象没有文本、没有光标，也没有"该用哪种编辑模式"这回事
    lastRepresentedPath = undefined
    // 切回已经渲染过的查看标签时不必重画：PDF 重画意味着重新栅格化
    if (viewerRenderedId === viewing.id) refreshAll({ immediateExpensive: true })
    else void showViewerSession(viewing)
    return
  }

  // 换文档：表面内容取新会话的权威文本，光标回文首
  syncModeWithActiveDocument(store.active?.markdown ?? '', true)
  lastRepresentedPath = undefined

  // 换了文档，之前的"跳转到这里"标记已无意义
  editor()?.setLocator(null)

  // 切标签时用户正在等着看新文档，不能延迟
  refreshAll({ immediateExpensive: true })
  if (state.mode === 'wysiwyg') editor()?.focus()
  else dom.rawEditor.focus()
}

function createNewDocument(): void {
  store.createUntitled()
  syncModeWithActiveDocument('', true)
  lastRepresentedPath = undefined
  refreshAll()
  if (state.mode === 'wysiwyg') editor()?.focus()
  else dom.rawEditor.focus()
  setMessage(messages().status.newDocument, 'info', 2000)
}

/**
 * 保存指定会话。
 *
 * 注意：保存的对象未必是"当前活动会话"——关闭标签、退出时的保存流程
 * 都会针对特定会话，因此这里显式接收 session 而不是隐式使用活动会话。
 */
async function saveSession(session: Session, forceDialog = false): Promise<boolean> {
  // 最后一道防线：查看会话没有权威文本，走到写盘就是把用户文件清空
  if (session.kind === 'viewer') return false

  const isActive = store.active?.id === session.id

  let target = forceDialog ? null : session.filePath
  if (!target) {
    const chosen = await api.file.saveAsDialog({
      suggestedName: session.filePath ? baseName(session.filePath) : `${session.title}.md`
    })
    if (chosen.canceled || !chosen.filePath) return false
    target = chosen.filePath
  }

  const markdown = isActive ? currentMarkdown() : session.markdown

  const result = await api.file.write({
    filePath: target,
    content: markdown,
    eol: session.eol,
    encoding: session.encoding
  })

  store.markSaved(session.id, markdown, result.encoding)
  store.updateFilePath(session.id, target)
  // 另存为 .txt 会让该会话变成纯文本文档：立刻切到源码模式，
  // 否则下一次保存就会用 Markdown 序列化结果覆盖用户文件
  if (isActive) syncModeWithActiveDocument(markdown)

  if (result.encoding !== session.encoding) {
    setMessage(
      `原编码 ${ENCODING_LABEL[session.encoding]} 无法安全回写，已按 ${ENCODING_LABEL[result.encoding]} 保存`,
      'warn'
    )
  } else {
    setMessage(`${messages().status.saved} ${baseName(target)}`, 'info', 2200)
  }

  lastRepresentedPath = undefined
  refreshAll()
  return true
}

async function handleCloseTab(sessionId: string): Promise<void> {
  const session = store.list().find((item) => item.id === sessionId)
  if (!session) return

  if (store.isDirty(session)) {
    const shouldSave = window.confirm(`「${session.title}」${messages().dialog.closeTabUnsaved}`)
    if (shouldSave) {
      const saved = await saveSession(session)
      if (!saved) return
    }
  }

  const nextActiveId = store.close(sessionId)
  if (nextActiveId === null) {
    // 关掉最后一个标签后保留一个空白文档，避免出现"没有任何编辑区"的空状态
    createNewDocument()
    return
  }

  afterSessionActivated(store.active?.filePath ?? null)
}

/* ------------------------------------------------------------------ *
 * 查找（文档内）
 * ------------------------------------------------------------------ */

const finder = { query: '', matches: [] as { from: number; to: number }[], index: -1 }

function openFinder(): void {
  dom.finder.hidden = false
  dom.finderInput.focus()
  dom.finderInput.select()
  if (dom.finderInput.value.length > 0) runFind(dom.finderInput.value)
}

function closeFinder(): void {
  dom.finder.hidden = true
  finder.query = ''
  finder.matches = []
  finder.index = -1
  dom.finderCount.textContent = '0/0'

  // 高亮必须随查找框关闭一起清掉，否则会在文档上留下无来源的标记
  editor()?.clearSearchHighlights()

  // 查看会话下没有可聚焦的编辑表面：聚焦隐藏的 textarea 会把后续键盘输入
  // 送进上一个文档，那是"看不见却在改"的最坏形态
  if (viewerSession() !== null) return
  if (state.mode === 'wysiwyg') editor()?.focus()
  else dom.rawEditor.focus()
}

function runFind(query: string): void {
  finder.query = query

  // 查询被清空时移除所有高亮，避免残留标记
  if (query.length === 0) {
    finder.matches = []
    finder.index = -1
    dom.finderCount.textContent = '0/0'
    editor()?.clearSearchHighlights()
    return
  }

  const current = editor()
  if (!current || state.mode === 'raw') {
    // 源码模式直接在文本里定位
    finder.matches = []
    const haystack = currentMarkdown().toLowerCase()
    const needle = query.toLowerCase()
    if (needle.length > 0) {
      let at = haystack.indexOf(needle)
      while (at !== -1 && finder.matches.length < 5000) {
        finder.matches.push({ from: at, to: at + needle.length })
        at = haystack.indexOf(needle, at + needle.length)
      }
    }
  } else {
    const result = findTextMatches(current.state.doc, query)
    finder.matches = result.matches
  }

  finder.index = finder.matches.length > 0 ? 0 : -1
  updateFinderCount()
  focusCurrentMatch()
}

function updateFinderCount(): void {
  const total = finder.matches.length
  dom.finderCount.textContent = `${total === 0 ? 0 : finder.index + 1}/${total}`
}

/**
 * 在当前匹配处显示高亮并滚动到位。
 *
 * 两个约束同时成立，因此实现方式与"跳到某处"完全不同：
 *
 * 1. **绝不移动焦点。** 本函数在查找框每次 input 时都会调用；
 *    一旦把焦点交给编辑区，用户输入第二个字符时就失去了输入目标。
 *
 * 2. **不能用选区来显示。** ProseMirror 的 `selectionToDOM` 有守卫
 *    `view.hasFocus()`，查找框持有焦点时它拒绝把选区写入 DOM，
 *    结果是既无高亮也不滚动（详见 editor/search-highlight.ts）。
 *
 * 因此改用装饰器高亮 + `coordsAtPos` 手动滚动：
 * 两者都与焦点无关，才能同时满足上面两条。
 */
function focusCurrentMatch(): void {
  if (finder.index < 0) return
  const match = finder.matches[finder.index]

  if (state.mode === 'raw') {
    revealRangeInTextarea(dom.rawEditor, match)
    return
  }

  const current = editor()
  if (!current) return

  // 全部匹配都高亮、当前项单独强调：用户能一眼看到分布，而不只是一个位置
  current.setSearchHighlights(finder.matches, finder.index)
  scrollPositionIntoView(current.view, match.from)
}

function stepMatch(delta: number): void {
  const total = finder.matches.length
  if (total === 0) return
  finder.index = (finder.index + delta + total) % total
  updateFinderCount()
  focusCurrentMatch()
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

function bindRawEditor(): void {
  dom.rawEditor.addEventListener('input', () => {
    // 回灌内核，保证切回所见即所得时不丢内容
    editor()?.setMarkdown(dom.rawEditor.value)
    store.commitActive(dom.rawEditor.value)
    refreshAll()
    if (!dom.finder.hidden && finder.query.length > 0) runFind(dom.finderInput.value)
  })

  dom.rawEditor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      const { selectionStart, selectionEnd, value } = dom.rawEditor
      dom.rawEditor.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
      dom.rawEditor.selectionStart = dom.rawEditor.selectionEnd = selectionStart + 2
      editor()?.setMarkdown(dom.rawEditor.value)
      store.commitActive(dom.rawEditor.value)
      refreshAll()
    }
  })
}

function bindToolbar(): void {
  const actions: Record<string, () => void> = {
    new: () => void handleCommand('file:new'),
    open: () => void handleCommand('file:open'),
    'open-folder': () => void handleCommand('file:open-folder'),
    save: () => void handleCommand('file:save'),
    'save-as': () => void handleCommand('file:save-as'),
    'toggle-sidebar': () => void handleCommand('view:toggle-sidebar'),
    'toggle-theme': () => void handleCommand('view:toggle-theme'),
    'theme-variant': () => void handleCommand('view:theme-variant'),
    'theme-import': () => void handleCommand('view:theme-import'),
    'export-html': () => void handleCommand('file:export-html'),
    'export-pdf': () => void handleCommand('file:export-pdf'),
    'toggle-preview': () => void handleCommand('view:toggle-preview'),
    'toggle-mode': () => void handleCommand('view:toggle-mode')
  }

  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action
      if (action && actions[action]) actions[action]()
    })
  })

  dom.sidebar.querySelectorAll<HTMLButtonElement>('.sidebar__tab').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.dataset.panel
      if (panel === 'files' || panel === 'outline' || panel === 'search') setSidePanel(panel)
    })
  })
}

function bindFormatBar(): void {
  dom.formatGroup.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button')
    if (!button) return

    // 表格按钮走另一组命令：它们的作用域是光标所在单元格
    const tableAction = button.dataset.table
    if (tableAction) {
      if (state.mode === 'raw') return
      applyTableAction(tableAction)
      updateFormatButtons()
      return
    }

    const format = button.dataset.format
    if (!format || state.mode === 'raw') return

    applyFormat(format)
    editor()?.focus()
    updateFormatButtons()
  })
}

/** 表格工具栏动作。插入以外的动作只在光标位于表格内时生效。 */
function applyTableAction(action: string): void {
  const current = editor()
  if (!current) return

  switch (action) {
    case 'insert':
      current.execute(tableCommands.insert)
      break
    case 'add-row-after':
      current.execute(tableCommands.addRowAfter)
      break
    case 'add-column-after':
      current.execute(tableCommands.addColumnAfter)
      break
    case 'delete-row':
      current.execute(tableCommands.deleteRow)
      break
    case 'delete-column':
      current.execute(tableCommands.deleteColumn)
      break
    case 'delete-table':
      current.execute(tableCommands.deleteTable)
      break
    default:
      break
  }

  current.focus()
}

function applyFormat(format: string): void {
  const current = editor()
  if (!current) return

  if (format.startsWith('heading:')) {
    current.execute(toggleHeading(Number(format.slice('heading:'.length))))
    return
  }

  switch (format) {
    case 'bold':
      current.execute(inlineCommands.bold)
      break
    case 'italic':
      current.execute(inlineCommands.italic)
      break
    case 'code':
      current.execute(inlineCommands.code)
      break
    case 'strikethrough':
      current.execute(inlineCommands.strikethrough)
      break
    case 'bullet-list':
      current.execute(toggleBulletList)
      break
    case 'ordered-list':
      current.execute(toggleOrderedList)
      break
    case 'blockquote':
      current.execute(toggleBlockquote)
      break
    default:
      break
  }
}

function bindFinder(): void {
  dom.finderInput.addEventListener('input', () => runFind(dom.finderInput.value))

  dom.finderInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      stepMatch(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeFinder()
    }
  })

  requireElement('finder-prev').addEventListener('click', () => stepMatch(-1))
  requireElement('finder-next').addEventListener('click', () => stepMatch(1))
  requireElement('finder-close').addEventListener('click', closeFinder)
}

function bindPreview(): void {
  dom.preview.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.md-link')
    const href = target?.dataset.href
    if (href && href.startsWith('https://')) void api.shell.openExternal(href)
  })
}

/**
 * 图片粘贴与拖入。
 *
 * 粘贴事件绑在内核的 DOM 上而非 document：这样"在编辑器里粘贴"与
 * "在文件树里粘贴"能区分开，不会误接管与文档无关的操作。
 */
function bindImageInput(): void {
  const host = dom.wysiwygHost

  host.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    const images = files.filter(isImageFile)
    if (images.length === 0) return

    // 必须阻止默认行为：否则浏览器会尝试以其它形式插入剪贴板内容
    event.preventDefault()
    void handleImageFiles(images)
  })

  host.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })

  host.addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    const images = files.filter(isImageFile)
    if (images.length === 0) return

    event.preventDefault()
    event.stopPropagation()
    void handleImageFiles(images)
  })
}

async function handleImageFiles(files: readonly File[]): Promise<void> {
  const current = editor()
  if (!current) return

  const session = store.active
  const filePath = session?.filePath
  if (!session || !filePath) {
    setMessage(messages().error.imageNeedsSavedDocument, 'warn', 5000)
    return
  }
  const isCurrentDocument = (): boolean =>
    store.active?.id === session.id && session.filePath === filePath && editor() === current

  try {
    const result = await insertImageFiles(current.view, files, imageResolver, isCurrentDocument)
    if (!isCurrentDocument()) return
    if (result.inserted > 0) {
      store.commitActive(current.getMarkdown())
      refreshAll()
      setMessage(`${messages().status.imageInserted} ${result.inserted} ${messages().status.imageInsertedSuffix}`, 'info', 3000)
    }
    if (result.failures.length > 0) {
      setMessage(`${messages().status.imagePartialFailure}：${result.failures.join('; ')}`, 'error', 6000)
    }
  } catch (error) {
    setMessage(`${messages().error.insertImageFailed}：${describeError(error)}`, 'error')
  }
}

/** 拖拽文本文件（Markdown / .txt）到窗口即打开——桌面编辑器的基本预期。 */
function bindDragAndDrop(): void {
  document.addEventListener('dragover', (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })

  document.addEventListener('drop', (event) => {
    event.preventDefault()
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => !isImageFile(file))
    for (const file of files) {
      // Electron 的 File 对象带 path（新版为 webUtils.getPathForFile）
      const filePath = (file as File & { path?: string }).path
      // 走 openWorkspaceFile 而不是直接读：它按扩展名分流到编辑器或只读查看器。
      // 图片仍被上面的 filter 排除——拖图片进编辑区的语义是"插入到光标处"，
      // 与"打开一个图片文件"是两件事，混在一起会同时破坏两种预期
      if (filePath) openWorkspaceFile(filePath)
    }
  })
}

/* ------------------------------------------------------------------ *
 * 命令总线
 * ------------------------------------------------------------------ */

/**
 * 查看会话下"没有作用对象"的命令。
 *
 * 集中判定而不是在每个 case 里各自防御：漏掉一个的后果可能是
 * "对着 PDF 按保存，把空内容写回磁盘"，这种事不该靠人记着。
 */
const VIEWER_BLOCKED_COMMANDS: ReadonlySet<MenuCommand> = new Set<MenuCommand>([
  'file:save',
  'file:save-as',
  'file:export-html',
  'file:export-pdf',
  'edit:find',
  'edit:undo',
  'edit:redo',
  'insert:table',
  'view:toggle-mode',
  'view:toggle-layout',
  'view:toggle-preview'
])

async function handleCommand(command: MenuCommand): Promise<void> {
  const session = store.active

  if (session?.kind === 'viewer' && VIEWER_BLOCKED_COMMANDS.has(command)) {
    setMessage(messages().status.viewerReadOnly, 'warn', 4000)
    return
  }

  switch (command) {
    case 'file:new':
      createNewDocument()
      break

    case 'file:open':
      await openDocument()
      break

    case 'file:open-folder':
      await openWorkspace()
      break

    case 'file:save': {
      if (!session) break
      const saved = await saveSession(session)
      if (saved) api.window.notifyCloseAfterSave()
      break
    }

    case 'file:save-as':
      if (session) await saveSession(session, true)
      break

    case 'file:close-tab':
      if (session) await handleCloseTab(session.id)
      break

    case 'file:clear-recent': {
      await api.prefs.clearRecent()
      setMessage(messages().status.customThemeCleared, 'info', 2600)
      break
    }

    case 'file:export-html':
      await exportHtml()
      break

    case 'file:export-pdf':
      await exportPdf()
      break

    case 'help:reset-ui':
      await resetInterfaceSettings()
      break

    case 'help:check-for-updates':
      await checkForUpdates()
      break

    case 'view:set-locale':
      await cycleLocale()
      break

    case 'view:theme-variant':
      cycleThemeVariant()
      break

    case 'view:theme-import':
      await importCustomTheme()
      break

    case 'view:theme-clear':
      clearCustomTheme()
      break

    case 'insert:table':
      // 与工具栏同一入口，保证两种触发路径行为一致
      applyTableAction('insert')
      refreshAll()
      break

    case 'edit:find':
      openFinder()
      break

    case 'edit:find-in-files':
      setSidebarVisible(true)
      setSidePanel('search')
      searchPanel.focus()
      break

    case 'edit:undo':
      if (state.mode === 'wysiwyg') editor()?.undo()
      else {
        dom.rawEditor.focus()
        document.execCommand('undo')
        store.commitActive(dom.rawEditor.value)
      }
      refreshAll()
      break

    case 'edit:redo':
      if (state.mode === 'wysiwyg') editor()?.redo()
      else {
        dom.rawEditor.focus()
        document.execCommand('redo')
        store.commitActive(dom.rawEditor.value)
      }
      refreshAll()
      break

    case 'view:toggle-theme':
      setTheme(state.theme === 'light' ? 'dark' : 'light')
      break

    case 'view:toggle-mode':
      setMode(state.mode === 'wysiwyg' ? 'raw' : 'wysiwyg')
      break

    case 'view:toggle-layout':
      setLayout(LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(state.layout) + 1) % LAYOUT_CYCLE.length])
      break

    case 'view:toggle-preview':
      togglePreviewPane()
      break

    case 'view:toggle-sidebar':
      setSidebarVisible(!state.sidebarVisible)
      break

    case 'view:refresh-workspace':
      await refreshWorkspaceTree()
      setMessage(messages().status.refreshed, 'info', 2000)
      break

    case 'view:zoom-reset':
      break

    case 'app:about':
      setMessage(
        `TypeFlow L2 · Electron ${api.versions.electron} · Chromium ${api.versions.chrome} · ProseMirror 内核`,
        'info',
        6000
      )
      break

    default:
      break
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function restorePreferences(): void {
  const storedTheme = window.localStorage.getItem(PREFERENCE_KEYS.theme)
  setTheme(storedTheme === 'dark' ? 'dark' : 'light')

  const storedLayout = window.localStorage.getItem(PREFERENCE_KEYS.layout)
  setLayout(
    storedLayout === 'source' || storedLayout === 'preview' || storedLayout === 'split'
      ? storedLayout
      : 'split'
  )

  const storedVariant = window.localStorage.getItem(PREFERENCE_KEYS.themeVariant)
  setThemeVariant(
    storedVariant === 'serif' || storedVariant === 'compact' || storedVariant === 'default'
      ? storedVariant
      : 'default'
  )

  // 恢复上次的自定义主题；文件已被移动时静默回退到内置主题
  const storedThemePath = window.localStorage.getItem(PREFERENCE_KEYS.customThemePath)
  if (storedThemePath) {
    state.customThemePath = storedThemePath
    void api.theme.readCss(storedThemePath).then((css) => {
      if (css) {
        injectCustomTheme(css)
        markCustomThemeActive(true)
      }
      else {
        state.customThemePath = null
        window.localStorage.removeItem(PREFERENCE_KEYS.customThemePath)
      }
    })
  }

  setSidebarVisible(window.localStorage.getItem(PREFERENCE_KEYS.sidebar) !== '0')

  const storedPanel = window.localStorage.getItem(PREFERENCE_KEYS.sidePanel)
  setSidePanel(
    storedPanel === 'outline' || storedPanel === 'search' || storedPanel === 'files'
      ? storedPanel
      : 'files'
  )
}

/** 打开指定行：搜索面板点击结果时使用。 */
/**
 * 跳转到工作区搜索的某条结果。
 *
 * ## 为什么以"行文本"为权威，而不是行号
 *
 * 行号来自对**文件**的搜索，而编辑器里的位置要经过
 * markdown → 文档 → markdown 的规范化，行数会漂移。
 * 实测：在文档中段插入一行，后面的行号就整体偏移 2——
 * 此时"用文件行号去编辑器里取同一行"会取到**别的行**，
 * 而且不会有任何报错，表现为"高亮跑到别的地方去了"。
 *
 * 因此以 `lineText`（搜索时那一行的确切文本）作为定位依据，
 * 行号只用于**消歧**：同一段文本出现多次时，选与行号比例最接近的一处。
 */
async function openAtLocation(filePath: string, line: number, lineText?: string): Promise<void> {
  await openDocumentByPath(filePath)

  const current = editor()
  if (!current || state.mode === 'raw') {
    /**
     * 源码模式同样以行文本为权威。
     *
     * 直觉上"源码模式里行号就是文件行号"，但 `rawEditor.value` 取的是
     * **编辑器规范化后的 markdown**，行数同样会漂移——
     * 实测文档中段插入一行就偏移 2 行，按行号定位会落到别的行上。
     */
    const content = currentMarkdown()
    const lineIndex = findLineIndexByText(content, lineText ?? '', line)

    const offsets = content.split('\n')
    let offset = 0
    for (let index = 0; index < Math.min(lineIndex, offsets.length); index += 1) {
      offset += offsets[index].length + 1
    }

    dom.rawEditor.focus()
    dom.rawEditor.setSelectionRange(offset, offset)
    return
  }

  const lines = currentMarkdown().split('\n')

  /**
   * 优先用搜索返回的整行文本；没有时退回"按行号取行"。
   *
   * 行文本可能带 markdown 标记（`#`、列表符号、围栏），
   * 而文档里存的是纯文本内容，因此剥掉行首标记再找。
   */
  const byLineNumber = lines[Math.max(0, Math.min(line - 1, lines.length - 1))] ?? ''
  const source = lineText && lineText.trim().length > 0 ? lineText : byLineNumber
  const phrase = source.replace(/^[#>\-*\d.\s]+/, '').trim().slice(0, 80)
  if (phrase.length === 0) return

  const result = findTextMatches(current.state.doc, phrase, 200)

  /**
   * 同一短语出现多次时用行号消歧：把行号换算成"文档中的相对位置"，
   * 选最接近的那一处。行号在这里只是提示，不精确也没关系。
   */
  if (result.matches.length > 1) {
    const ratio = (line - 1) / Math.max(1, lines.length - 1)
    const estimated = current.state.doc.content.size * ratio
    result.matches.sort(
      (a, b) => Math.abs(a.from - estimated) - Math.abs(b.from - estimated)
    )
  }

  /**
   * 定位诊断。
   *
   * 渲染层的 console 不会出现在宿主终端，定位类问题必须把关键中间量
   * 结构化暴露出来才能排查（编辑器行数 vs 文件行数的差异是这里的关键）。
   */
  const firstMatch = result.matches[0]

  /**
   * 两条通道同时用，各自负责不同的职责：
   *
   * - **装饰器**（`setLocator`）负责"让用户看见"：不依赖焦点、
   *   不会被 NodeView 重建 DOM 吞掉，因此可靠。
   * - **选区**（`selectRange`）负责"让用户接着打字"：
   *   光标落在匹配处，用户可以直接编辑，或按方向键继续浏览。
   *
   * 原先只用选区，于是两点都不可靠：选区会被吞掉（看不见），
   * `tr.scrollIntoView()` 同样依赖 DOM 选区，所以也不会滚动。
   */
  if (firstMatch) {
    current.setLocator(firstMatch)
    const renderedImmediately = dom.wysiwygHost.querySelector('.search-locator') !== null

    selectRange(current, firstMatch)
    // 显式滚动：不依赖 `tr.scrollIntoView()`（那条路径同样依赖 DOM 选区）
    scrollPositionIntoView(current.view, firstMatch.from)

    /**
     * 下一帧再滚一次。
     *
     * `selectRange` 里的 `view.focus()` 会把选区写进 DOM，而**浏览器随后会
     * 自行把该选区滚入视口**——它采用"最小滚动"，于是目标停在视口下沿
     * （实测：视口 77–723，标记落在 693）。这个副作用发生在我们滚动之后，
     * 因此必须在下一帧重做一次才能稳定压过它。
     */
    const target = firstMatch.from
    window.requestAnimationFrame(() => {
      const instance = editor()
      if (instance) scrollPositionIntoView(instance.view, target)
    })

    lastLocatorTiming = { renderedImmediately, renderedAfterSelect: dom.wysiwygHost.querySelector('.search-locator') !== null }
  } else {
    current.setLocator(null)
  }

  lastLocateDiagnostics = {
    requestedLine: line,
    editorLineCount: lines.length,
    sourceLine: source,
    phrase,
    hitCount: result.matches.length,
    matchFrom: firstMatch?.from ?? -1,
    matchTo: firstMatch?.to ?? -1,
    locatorRendered: dom.wysiwygHost.querySelector('.search-locator') !== null,
    timing: lastLocatorTiming
  }
}

async function init(): Promise<void> {
  dom.statusPlatform.textContent = api.platform
  dom.statusPlatform.title = `Electron ${api.versions.electron} / Chromium ${api.versions.chrome}`

  // 解析器必须先于 store 创建：store.mount 会立刻用它构造内核
  imageResolver = createImageResolver(activeDocumentDirectory)
  store = new SessionStore(dom.wysiwygHost, { imageResolver })
  // 查看器要先于第一次 refreshAll：applySurface 在离开查看表面时会调用 clear()
  viewer = createViewer(dom.viewerHost)

  tabBar = createTabBar(dom.tabBarHost, {
    onActivate: (id) => {
      store.activate(id)
      afterSessionActivated(store.active?.filePath ?? null)
    },
    onClose: (id) => void handleCloseTab(id)
  })

  fileTree = createFileTreeView(dom.fileTreeHost, {
    onOpenFile: openWorkspaceFile,
    onCreateFile: handleCreateFile,
    onCreateDirectory: handleCreateDirectory,
    onRename: handleRename,
    onDelete: handleDelete,
    onError: (message) => setMessage(message, 'error')
  })

  outlineView = createOutlineView(dom.outlineHost, (item) => {
    const current = editor()
    if (!current) return
    cursorToOutlinePosition(current, item.position)
    current.focus()
  })

  searchPanel = createSearchPanel(dom.searchHost, {
    onSearch: (query, caseSensitive): Promise<SearchResult> => {
      if (!state.workspacePath) return Promise.resolve({ files: [], totalMatches: 0, truncated: false })
      return api.workspace.search(state.workspacePath, query, caseSensitive)
    },
    onOpenMatch: (filePath, match) => void openAtLocation(filePath, match.line, match.lineText),
    onError: (message) => setMessage(message, 'error')
  })

  store.subscribe(() => refreshAll())

  bindToolbar()
  bindFormatBar()
  bindFinder()
  bindRawEditor()
  bindPreview()
  bindScrollSync()
  bindImageInput()
  bindDragAndDrop()
  bindSidebarResizer()

  api.menu.onCommand((command) => {
    void handleCommand(command)
  })

  api.menu.onOpenPath((filePath) => {
    void openDocumentByPath(filePath)
  })

  // 更新状态变化只做状态栏提示，绝不弹窗打断写作
  api.update.onStateChanged((state) => {
    if (state.status === 'downloaded') {
      setMessage(`${messages().status.updateStatus}: ${state.version ?? ''}`, 'info', 6000)
    }
  })

  api.prefs.onChanged(() => {
    /* 最近文件菜单由主进程维护；渲染层暂无订阅需求 */
  })

  // 语言要在首次渲染前确定，否则会先闪一下默认语言
  const preferences = await api.prefs.get().catch(() => null)
  // 截图模式强制指定语言：英文商店页需要全套英文界面，
  // 文档名/侧栏空状态/状态栏都是启动期渲染的动态串，事后切换补不上
  const locale: Locale =
    api.screenshot.enabled && api.screenshot.lang === 'en'
      ? 'en-US'
      : normalizeLocale(preferences?.locale ?? navigator.language)
  setLocale(locale)
  window.localStorage.setItem(PREFERENCE_KEYS.locale, locale)
  applyTranslations()

  restorePreferences()
  // 模式偏好要在首个文档创建前生效，且只影响 Markdown 文档（纯文本恒为源码）
  state.preferredMode = window.localStorage.getItem(PREFERENCE_KEYS.mode) === 'raw' ? 'raw' : 'wysiwyg'
  if (state.preferredMode !== state.mode) showMode(state.preferredMode, '')

  createNewDocument()
  searchPanel.setWorkspaceReady(false)

  setMessage(`${messages().app.name} ${api.versions.electron}`, 'info', 2600)
  console.log('[typeflow] renderer ready')
  if (api.smoke.enabled) api.smoke.reportReady()

  if (api.smoke.enabled) {
    try {
      await runSmokeTest()
    } catch (error) {
      console.error('[typeflow:smoke] ✗ 自检抛出异常', error)
      const detail =
        error instanceof Error
          ? `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}`
          : String(error)
      api.smoke.report({ checks: [{ label: '自检执行', ok: false, detail }], failures: 1 })
    }
  }

  // 商店截图模式：铺演示文档展示排版能力，等渲染稳定后通知主进程抓图
  if (api.screenshot.enabled) {
    editor()?.setMarkdown(api.screenshot.lang === 'en' ? SCREENSHOT_DEMO_EN : SCREENSHOT_DEMO)
    setTimeout(() => {
      // 抓图前强制干净状态：查找条关闭、选区归到文首（避免节点选中高亮入镜）
      dom.finder.hidden = true
      ;(document.activeElement as HTMLElement | null)?.blur()
      document.getSelection()?.removeAllRanges()
      const current = editor()
      if (current) {
        const { state, view } = current
        view.dispatch(state.tr.setSelection(TextSelection.atStart(state.doc)).scrollIntoView())
      }
      window.scrollTo(0, 0)
      api.screenshot.done()
    }, 1200)
  }
}

/**
 * 商店截图演示文档。
 *
 * 覆盖主要排版能力：标题 / 强调 / 引用 / 列表 / 代码高亮 / 表格 / 行内与块级公式，
 * 一屏之内让审阅者与用户看清这是什么产品。
 */
const SCREENSHOT_DEMO =
  '# 写作生产力笔记\n\n' +
  'TypeFlow 是一款面向严肃写作的 **Markdown 编辑器**：*所见即所得*，' +
  '支持 `行内代码`、多编码与流畅的中文排版。\n\n' +
  '> 写作即思考。写下来，才算想清楚。\n\n' +
  '## 能力一览\n\n' +
  '- 公式、代码高亮、表格实时渲染\n' +
  '- 本地保存，支持 UTF-8 / GBK / UTF-16\n' +
  '- 一键导出 PDF 与 HTML\n\n' +
  /*
   * 表格排在代码块之前。
   *
   * 1440×900 的首屏高度有限：把表格放在代码块之后会落到折线以下，
   * 商店截图里就看不到表格——而表格正是要展示的能力之一。
   * 表头用对齐标记（`:---` / `:---:`）顺带展示对齐支持。
   */
  '## 表格\n\n' +
  '| 能力 | 状态 |\n' +
  '| :--- | :---: |\n' +
  '| 公式渲染 | 支持 |\n' +
  '| 表格编辑 | 支持 |\n' +
  '| 代码高亮 | 支持 |\n\n' +
  '## 代码与公式\n\n' +
  '```ts\n' +
  'function flow(text: string): string {\n' +
  "  return text.trim().split(/\\n+/).join('\\n')\n" +
  '}\n' +
  '```\n\n' +
  '$$\n' +
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}\n' +
  '$$\n'

/** 英文商店页截图的演示文档，内容与中文版对齐。 */
const SCREENSHOT_DEMO_EN =
  '# Writing Productivity Notes\n\n' +
  'TypeFlow is a **Markdown editor** for serious writing: *what you see is what you get*, ' +
  'with `inline code`, rich encoding support and smooth typography.\n\n' +
  '> Writing is thinking. It is not finished until it is written down.\n\n' +
  '## Highlights\n\n' +
  '- Math, code highlighting and tables rendered live\n' +
  '- Saved locally, with UTF-8 / GBK / UTF-16 support\n' +
  '- One-click export to PDF and HTML\n\n' +
  '## Tables\n\n' +
  '| Feature | Status |\n' +
  '| :--- | :---: |\n' +
  '| Math rendering | Supported |\n' +
  '| Table editing | Supported |\n' +
  '| Code highlighting | Supported |\n\n' +
  '## Code & Math\n\n' +
  '```ts\n' +
  'function flow(text: string): string {\n' +
  "  return text.trim().split(/\\n+/).join('\\n')\n" +
  '}\n' +
  '```\n\n' +
  '$$\n' +
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}\n' +
  '$$\n'

/** 把光标放到指定文档位置（大纲跳转）。 */
function cursorToOutlinePosition(current: EditorApi, position: number): void {
  const { state: editorState } = current
  const clamped = Math.max(1, Math.min(position, editorState.doc.content.size))
  current.view.dispatch(
    editorState.tr.setSelection(TextSelection.near(editorState.doc.resolve(clamped))).scrollIntoView()
  )
}

/* ------------------------------------------------------------------ *
 * 端到端自检
 * ------------------------------------------------------------------ */

async function runSmokeTest(): Promise<void> {
  const results: { label: string; ok: boolean; detail: string }[] = []

  function check(label: string, condition: boolean, detail = ''): void {
    results.push({ label, ok: condition, detail })
    console.log(`[typeflow:smoke] ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  }

  /* ---------- L0/L1 回归 ---------- */
  check('preload 沙箱桥可用', typeof api.platform === 'string', api.platform)

  /**
   * 规范化基准。
   *
   * 内核不保留文档末尾的空行（打开→保存不补换行，属于既定契约），
   * 因此断言必须拿"输入经内核规范化后的结果"作期望值，
   * 而不是原始字面量——否则会得到一批看似失败的假失败。
   */
  const normalize = (markdown: string): string => documentToMarkdown(markdownToDocument(markdown))

  /**
   * 等待一次渲染帧。
   *
   * 代码块染色被有意推迟到 ProseMirror 完成 DOM 同步之后（见 code-block.ts），
   * 因此任何"设置内容后立刻查 DOM"的断言都必须先等一帧，
   * 否则读到的是上一轮内容——这类时序问题很容易被误判成功能缺陷。
   */
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

  /**
   * 轮询等待条件成立。
   *
   * 图片路径解析要经主进程往返（fs.stat），耗时不确定，
   * 固定等一帧会写出脆弱断言。这里轮询到成立为止，设上限避免卡死自检。
   */
  const waitFor = async (predicate: () => boolean, maxFrames = 120): Promise<boolean> => {
    for (let frame = 0; frame < maxFrames; frame += 1) {
      if (predicate()) return true
      await nextFrame()
    }
    return predicate()
  }

  const regressionInput = '# 回归\n\n正文 **粗体** 与 `代码`\n\n- 甲\n- 乙\n'
  const regressionExpected = normalize(regressionInput)
  store.createUntitled()
  editor()?.setMarkdown(regressionInput)
  store.commitActive(regressionExpected)
  check(
    'L1 内核往返仍成立',
    editor()?.getMarkdown() === regressionExpected,
    `${editor()?.getMarkdown().length ?? 0} 字符（期望 ${regressionExpected.length}）`
  )

  // 输入规则：必须逐字符走输入管线，且每一步都要落进文档
  // （未命中规则时由兜底插入，与真实键入一致）
  // autoInsert 保证字符落进文档（与真实键入一致），
  // applyDefaultInput 只报告"这一步是否被输入规则处理"——两者职责不同，不可混用
  const probe = editor()!
  probe.setMarkdown('')
  cursorToStart(probe)
  probe.autoInsert('#')
  const ruleFired = probe.applyDefaultInput(' ').ok
  const probeMarkdown = probe.getMarkdown()
  check(
    'L1 输入规则仍生效',
    ruleFired && probeMarkdown.startsWith('# '),
    `${JSON.stringify(probeMarkdown)} ${JSON.stringify(getLastAutoInsertDiagnostics())}`
  )

  /* ---------- L3：数学公式 ---------- */
  {
    const mathCases: [string, string][] = [
      ['行内公式', '质能方程 $E = mc^2$ 是著名的。'],
      ['行内公式含下划线', '求和 $\sum_{i=1}^{n} a_i$ 的结果。'],
      ['块级公式', '$$\n\\int_0^1 x^2 dx\n$$'],
      ['公式与列表共存', '- 第一项 $a+b$\n- 第二项'],
      ['金额不误判为公式', '价格是 $5 和 $10 元。']
    ]

    const mathFailures: string[] = []
    for (const [label, markdown] of mathCases) {
      const result = documentToMarkdown(markdownToDocument(markdown))
      if (result !== markdown) mathFailures.push(`${label}: ${JSON.stringify(result)}`)
    }
    check(
      '公式 markdown 逐字往返',
      mathFailures.length === 0,
      `${mathCases.length - mathFailures.length}/${mathCases.length}${
        mathFailures.length ? ` 失败 ${JSON.stringify(mathFailures)}` : ''
      }`
    )

    // 公式必须形成 atom 节点，而不是被当成普通文本
    const parsedInline = markdownToDocument('质能方程 $E = mc^2$ 是著名的。')
    let inlineMathCount = 0
    parsedInline.descendants((node) => {
      if (node.type.name === 'math_inline') inlineMathCount += 1
      return true
    })
    check('行内公式解析为节点', inlineMathCount === 1, `${inlineMathCount} 个 math_inline`)

    const parsedBlock = markdownToDocument('$$\nE = mc^2\n$$')
    let blockMathCount = 0
    parsedBlock.descendants((node) => {
      if (node.type.name === 'math_block') blockMathCount += 1
      return true
    })
    check('块级公式解析为节点', blockMathCount === 1, `${blockMathCount} 个 math_block`)

    // 代码块里的 $$ 是代码，不能被当成公式
    const codeFence = markdownToDocument('```\n$$\n不是公式\n$$\n```')
    let codeBlockMath = 0
    codeFence.descendants((node) => {
      if (node.type.name === 'math_block') codeBlockMath += 1
      return true
    })
    check('代码块内的 $$ 不解析为公式', codeBlockMath === 0, `${codeBlockMath} 个 math_block`)

    // KaTeX 在真实 DOM 中渲染成功（考验 CSP：无 unsafe-eval 也能工作）
    const probeEditor = editor()!
    probeEditor.setMarkdown('$E = mc^2$')
    const katexElement = dom.wysiwygHost.querySelector('.katex')
    const katexHtml = dom.wysiwygHost.querySelector('.katex-html')
    check(
      'KaTeX 在沙箱内渲染成功',
      katexElement !== null && katexHtml !== null,
      katexElement ? '找到 .katex 输出' : '未找到渲染结果'
    )
    check(
      '公式渲染不含错误标记',
      dom.wysiwygHost.querySelector('.math-error') === null,
      dom.wysiwygHost.querySelector('.math-error')?.textContent ?? '无错误'
    )

    /**
     * 非法 LaTeX 的行为契约。
     *
     * 断言的是**稳定性而非具体渲染细节**，因为：
     *  - `\frac{1` 并不非法——KaTeX 自动补全缺失括号
     *  - `throwOnError: false` 下 KaTeX 不抛异常，错误的表现形式
     *    （红色文本 / 具体 class）随版本与 strict 配置变化，
     *    把测试绑到某个 class 上会变成脆弱的实现耦合
     *
     * 真正必须成立的是：不崩溃、公式节点仍在、编辑器仍可继续输入。
     */
    probeEditor.setMarkdown('$\\notarealkatexcommand{x}$')
    const mathNodeStillThere = dom.wysiwygHost.querySelector('.math-node') !== null
    check(
      '非法 LaTeX 不崩溃且公式节点保留',
      mathNodeStillThere,
      mathNodeStillThere ? '公式节点在位' : '公式节点丢失'
    )

    probeEditor.autoInsert('后')
    check(
      '非法 LaTeX 后仍可编辑',
      probeEditor.getMarkdown().includes('后'),
      `${probeEditor.getMarkdown().length} 字符`
    )
    probeEditor.setMarkdown('')
  }

  /* ---------- L3：代码块与语法高亮 ---------- */
  {
    const codeEditor = editor()!

    // 语言必须随围栏往返，否则保存后高亮信息丢失
    const codeCases: [string, string][] = [
      ['带语言围栏', '```ts\nconst a: number = 1\n```'],
      ['无语言围栏', '```\nplain code\n```'],
      ['语言别名保留原文', '```js\nalert(1)\n```']
    ]
    const codeFailures: string[] = []
    for (const [label, markdown] of codeCases) {
      const result = documentToMarkdown(markdownToDocument(markdown))
      if (result !== markdown) codeFailures.push(`${label}: ${JSON.stringify(result)}`)
    }
    check(
      '代码块围栏与语言逐字往返',
      codeFailures.length === 0,
      `${codeCases.length - codeFailures.length}/${codeCases.length}${
        codeFailures.length ? ` 失败 ${JSON.stringify(codeFailures)}` : ''
      }`
    )

    // 真实渲染：NodeView 应产出带语言下拉与高亮 span 的 DOM。
    // 需要等一帧：染色被有意推迟到 DOM 同步之后（见 code-block.ts 的说明），
    // 这是"颜色晚一帧出现"与"颜色被内核同步覆盖"之间的取舍。
    codeEditor.setMarkdown('```ts\nconst answer: number = 42\n```')
    await nextFrame()
    const codeDom = dom.wysiwygHost.querySelector('.code-block')
    const languageSelect = dom.wysiwygHost.querySelector<HTMLSelectElement>('.code-block__language')
    check(
      '代码块渲染为自定义 NodeView',
      codeDom !== null && languageSelect !== null,
      codeDom ? '已挂载 .code-block' : '未挂载'
    )
    check(
      '语言下拉反映当前语言',
      languageSelect?.value === 'ts' || languageSelect?.value === 'typescript',
      `value=${languageSelect?.value ?? '无'}`
    )

    // 高亮的关键证据：产物里出现 hljs-* 的着色 span
    const highlightedSpans = dom.wysiwygHost.querySelectorAll('.code-block__code [class^="hljs-"]')
    check('语法高亮产出着色节点', highlightedSpans.length > 0, `${highlightedSpans.length} 个高亮 span`)

    // 未注册语言必须退化为纯文本而不是报错
    codeEditor.setMarkdown('```unknownlang\nsome text\n```')
    await nextFrame()
    check(
      '未注册语言不报错且内容保留',
      dom.wysiwygHost.querySelector('.code-block__code')?.textContent?.includes('some text') === true,
      dom.wysiwygHost.querySelector('.code-block__code')?.textContent ?? '未找到内容'
    )

    // 内容必须仍然是单一可编辑模型，而不是被高亮拆散
    codeEditor.setMarkdown('```ts\nconst a = 1\n```')
    await nextFrame()
    const beforeEdit = codeEditor.getMarkdown()
    codeEditor.insertText(' ')
    check(
      '高亮不破坏文档模型',
      beforeEdit === '```ts\nconst a = 1\n```' && codeEditor.getMarkdown().includes('const a'),
      JSON.stringify(codeEditor.getMarkdown())
    )

    /**
     * 语法高亮必须有缓存。
     *
     * 高亮是纯计算，每次文档变化都全量重算会在多代码块的大文档上拖慢输入。
     * 断言"重设相同内容后缓存不再增长"，即验证按内容复用的逻辑生效。
     */
    {
      const cacheEditor = editor()!
      cacheEditor.setMarkdown('```ts\nconst cached: number = 1\n```')
      await nextFrame()
      const afterFirst = codeHighlightCacheSize()

      cacheEditor.setMarkdown('```ts\nconst cached: number = 1\n```')
      await nextFrame()
      const afterSecond = codeHighlightCacheSize()

      check(
        '相同代码不重复计算高亮（按内容缓存）',
        afterFirst > 0 && afterSecond === afterFirst,
        `首次 ${afterFirst} 条 → 重设后 ${afterSecond} 条`
      )
    }

    /* --- 模式切换不得丢失光标与表格上下文 --- */
    /**
     * 覆盖用户报告："添加一个表格后，切换源码和所见即所得，表格按钮变成灰色的了"。
     *
     * 根因是切换模式时**无条件**重设文档：`setMarkdown` 整篇替换文档，
     * 光标被重置到开头，表格上下文（光标是否在表格内）随之丢失。
     * 内容没变时不该重设文档。
     */
    {
      const modeEditor = editor()!
      modeEditor.setMarkdown('段落\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')
      await nextFrame()

      // 把光标放进表格，模拟用户刚操作完表格的状态
      let tableCellPos: number | null = null
      modeEditor.state.doc.descendants((node, pos) => {
        if (tableCellPos === null && node.type.name === 'table_cell') tableCellPos = pos + 1
        return true
      })

      check('表格中可定位到单元格', tableCellPos !== null, `pos=${tableCellPos}`)

      if (tableCellPos !== null) {
        const target = tableCellPos
        modeEditor.view.dispatch(
          modeEditor.state.tr.setSelection(TextSelection.near(modeEditor.state.doc.resolve(target)))
        )
        modeEditor.view.focus()
        updateFormatButtons()
        check(
          '光标在表格内时行列按钮可用',
          dom.formatGroup.dataset.inTable === 'true',
          `data-in-table=${dom.formatGroup.dataset.inTable}`
        )

        // 切到源码再切回来（内容未改动）
        setMode('raw')
        await nextFrame()
        setMode('wysiwyg')
        await nextFrame()
        updateFormatButtons()

        const inTableAfter = tableContext(modeEditor.state).inTable
        check(
          '切换模式后表格上下文不丢失',
          inTableAfter && dom.formatGroup.dataset.inTable === 'true',
          `光标在表格内=${inTableAfter} data-in-table=${dom.formatGroup.dataset.inTable}`
        )

        /**
         * 「插入表格」必须恢复可用。
         *
         * 它没有 `data-format`，曾因此躲过"回到所见即所得时清除 disabled"的循环，
         * 被源码模式禁用后**永久保持灰色**——用户表现为"切一次源码就再也插不了表格"。
         * 断言按钮的 disabled 状态，而不是只看它是否可见：
         * 灰色但可见的按钮正是这个缺陷的形态。
         */
        const insertButton = dom.formatGroup.querySelector<HTMLButtonElement>(
          '[data-table="insert"]'
        )
        check(
          '切换模式后「插入表格」按钮恢复可用',
          insertButton !== null && !insertButton.disabled,
          `disabled=${insertButton?.disabled ?? 'null'}`
        )

        // 不论文档里有没有表格，整组按钮都不该残留灰色
        const stillDisabled = Array.from(
          dom.formatGroup.querySelectorAll<HTMLButtonElement>('button')
        ).filter((button) => button.disabled).length
        check(
          '回所见即所得后格式组无残留禁用按钮',
          stillDisabled === 0,
          `仍禁用 ${stillDisabled} 个`
        )
      }

      modeEditor.setMarkdown('')
    }

    /* --- 表格：增删行列后 markdown 必须仍然合法 --- */
    /**
     * 覆盖用户报告："这个表格是不是有问题"。
     *
     * 表格在 markdown 里是**必须自洽**的结构：表头行、分隔行、每个数据行
     * 的单元格数量都要一致，否则解析器会拒绝或错位解析。
     * 增删列最容易破坏这个不变式（分隔行是独立生成的，漏改就错位）。
     */
    {
      const tableEditor = editor()!
      tableEditor.setMarkdown('')
      cursorToStart(tableEditor)
      tableEditor.execute(tableCommands.insert)
      await nextFrame()

      const describe = (): string => {
        let table: import('prosemirror-model').Node | null = null
        tableEditor.state.doc.descendants((node) => {
          if (node.type.name === 'table') table = node
          return true
        })
        if (!table) return '无表格'
        const found: import('prosemirror-model').Node = table
        const rows: string[] = []
        found.forEach((row: import('prosemirror-model').Node) => {
          rows.push(String(row.childCount))
        })
        return `行数=${found.childCount} 各行列数=[${rows.join(',')}]`
      }

      const afterInsert = describe()

      // 连续加两列：分隔行必须同步扩展
      for (let index = 0; index < 2; index += 1) {
        tableEditor.execute(tableCommands.addColumnAfter)
        await nextFrame()
      }
      const afterAddColumns = describe()

      const markdown = tableEditor.getMarkdown()
      const markdownLines = markdown.split('\n').filter((line) => line.trim().length > 0)

      /** 统计一行 pipe table 的单元格数（首尾竖线不计）。 */
      const cellCount = (line: string): number =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|').length

      const counts = markdownLines.map(cellCount)
      const allSame = counts.length >= 2 && counts.every((count) => count === counts[0])

      check(
        '增列后 markdown 各行单元格数一致',
        allSame,
        `各行列数=[${counts.join(',')}] 内容=${JSON.stringify(markdown.slice(0, 80))}`
      )

      // 往返：重新解析后列数必须与增列后一致
      const beforeRoundTrip = afterAddColumns
      tableEditor.setMarkdown(markdown)
      await nextFrame()
      const afterRoundTrip = describe()

      check(
        '表格 markdown 往返后维度不变',
        beforeRoundTrip === afterRoundTrip,
        `增列后 ${beforeRoundTrip} → 往返后 ${afterRoundTrip}`
      )

      check(
        '增列确实生效',
        afterAddColumns !== afterInsert,
        `初始 ${afterInsert} → 增列后 ${afterAddColumns}`
      )

      tableEditor.setMarkdown('')
    }

    /* --- 必须能走出文末的代码块 --- */
    /**
     * 覆盖用户报告的问题："光标一直在代码块里，出不来"。
     *
     * 代码块是文档最后一块时，块后没有任何可落脚的位置：
     * 单次回车只在块内换行，默认方向键也移不出去。
     * 这里验证连续两次 Enter、⌘Enter 与 ↓ 都能在其后开出新段落。
     */
    {
      const exitEditor = editor()!

      /** 把光标放到代码块内容的末尾。 */
      const cursorToCodeBlockEnd = (): void => {
        let last: number | null = null
        exitEditor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'code_block') last = pos + 1 + node.content.size
          return true
        })
        if (last === null) return
        exitEditor.view.dispatch(
          exitEditor.state.tr.setSelection(
            TextSelection.near(exitEditor.state.doc.resolve(last))
          )
        )
        exitEditor.view.focus()
      }

      const tryExit = (label: string, key: string, modifiers: { mod?: boolean } = {}): void => {
        exitEditor.setMarkdown('```text\n1111\n```')
        cursorToCodeBlockEnd()

        const before = exitEditor.state.doc.childCount
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          metaKey: modifiers.mod === true,
          ctrlKey: false
        })
        exitEditor.view.dom.dispatchEvent(event)

        const after = exitEditor.state.doc.childCount
        const { $from } = exitEditor.state.selection

        check(
          `${label}可在文末代码块之后继续写作`,
          after > before && $from.parent.type.name === 'paragraph',
          `块数 ${before} → ${after}，光标所在块类型=${$from.parent.type.name}`
        )
      }

      tryExit('⌘Enter ', 'Enter', { mod: true })
      tryExit('↓ 方向键', 'ArrowDown')

      const codeInput = '```text\n11111\n22222\n3333\nqqqq\n```'
      exitEditor.setMarkdown(codeInput)
      cursorToCodeBlockEnd()
      const enter = (shiftKey = false): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, shiftKey, bubbles: true, cancelable: true
        })
        exitEditor.view.dom.dispatchEvent(event)
        return event
      }
      const firstEnter = enter()
      check(
        '代码末尾第一次 Enter 保持块内换行',
        firstEnter.defaultPrevented && activeBlockKind(exitEditor.state) === 'code_block' &&
          exitEditor.state.doc.firstChild?.textContent === '11111\n22222\n3333\nqqqq\n'
      )
      const secondEnter = enter()
      await nextFrame()
      await nextFrame()
      const { doc, selection } = exitEditor.state
      check(
        '代码末尾第二次 Enter 退出到下方正文',
        secondEnter.defaultPrevented && doc.childCount === 2 &&
          doc.firstChild?.type.name === 'code_block' && doc.lastChild?.type.name === 'paragraph' &&
          selection.empty && selection.$from.depth === 1 && selection.from === doc.content.size - 1,
        doc.toString()
      )
      check('退出代码块后原代码和语言保持不变', exitEditor.getMarkdown() === codeInput)
      check('退出代码块后焦点仍在编辑器', exitEditor.view.hasFocus())
      exitEditor.insertText('代码外正文')
      check('退出代码块后可输入普通正文', exitEditor.getMarkdown() === `${codeInput}\n\n代码外正文`)

      exitEditor.setMarkdown(codeInput)
      cursorToCodeBlockEnd()
      enter()
      enter(true)
      check(
        '代码末尾 Shift+Enter 可继续保留空行',
        activeBlockKind(exitEditor.state) === 'code_block' && exitEditor.state.doc.childCount === 1 &&
          exitEditor.state.doc.firstChild?.textContent.endsWith('qqqq\n\n') === true
      )
    }

    /* --- 引用按钮与连续回车的打包态回归 --- */
    {
      const quoteEditor = editor()!
      quoteEditor.setMarkdown('')
      cursorToStart(quoteEditor)
      quoteEditor.focus()
      const quoteButton = dom.formatGroup.querySelector<HTMLButtonElement>('[data-format="blockquote"]')
      quoteButton?.click()
      check(
        '点击引用按钮进入引用并更新高亮',
        activeBlockKind(quoteEditor.state) === 'blockquote' && quoteButton?.classList.contains('is-active') === true
      )
      quoteEditor.insertText('引用回车测试')

      // 事件经过 EditorView 的 DOM 监听器和全部插件，不直接调用命令。
      const enter = (): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
        })
        quoteEditor.view.dom.dispatchEvent(event)
        return event
      }
      const firstEnter = enter()
      check(
        '引用末尾第一次 Enter 在引用内续段',
        firstEnter.defaultPrevented && activeBlockKind(quoteEditor.state) === 'blockquote' &&
          quoteEditor.state.selection.$from.parent.content.size === 0
      )
      const secondEnter = enter()
      await nextFrame()
      await nextFrame()
      const { doc, selection } = quoteEditor.state
      check(
        '引用末尾第二次 Enter 退出到下方正文',
        secondEnter.defaultPrevented && doc.childCount === 2 &&
          doc.firstChild?.type.name === 'blockquote' && doc.firstChild.textContent === '引用回车测试' &&
          doc.lastChild?.type.name === 'paragraph' && doc.lastChild.content.size === 0 &&
          selection.empty && selection.$from.depth === 1 && selection.from === doc.content.size - 1,
        doc.toString()
      )
      check('退出引用后按钮取消高亮', quoteButton !== null && !quoteButton.classList.contains('is-active'))
      check('退出引用后焦点仍在编辑器', quoteEditor.view.hasFocus())
      quoteEditor.insertText('引用外正文')
      check('退出引用后输入正文不带引用标记', quoteEditor.getMarkdown() === '> 引用回车测试\n\n引用外正文')
      quoteEditor.setMarkdown('')
    }

    /* --- 代码块只在头部拦截事件 --- */
    /**
     * 覆盖"光标出不了代码块"的另一半原因。
     *
     * 原先 `stopEvent` 写成"`dom` 内、`contentDOM` 外一律拦截"，
     * 于是点击 `<pre>` 留白区域时 ProseMirror **收不到事件**，
     * 无法把光标放到那里。收窄到只拦截头部后应当能正常落光标。
     *
     * 用真实坐标点击（而非直接改选区），才能验证事件确实到达了 ProseMirror。
     */
    {
      const clickEditor = editor()!
      clickEditor.setMarkdown('段落一\n\n```text\ncode line\n```\n\n段落二\n')
      await nextFrame()

      const pre = dom.wysiwygHost.querySelector('.code-block pre')
      const blockDom = pre?.parentElement as
        | (HTMLElement & { pmViewDesc?: { stopEvent(event: Event): boolean } })
        | null

      check(
        '代码块渲染出 pre 容器与 NodeView 描述符',
        pre !== null && typeof blockDom?.pmViewDesc?.stopEvent === 'function',
        pre ? '存在' : '未找到'
      )

      if (pre && blockDom?.pmViewDesc) {
        /**
         * 直接断言 ProseMirror 依赖的那个契约。
         *
         * ProseMirror 在 `eventBelongsToView` 里沿 DOM 向上逐个询问
         * `pmViewDesc.stopEvent(event)`，**任一返回 true 就丢弃整个事件**。
         * 因此"`<pre>` 不被拦截"是点击能落入光标的前提。
         *
         * 用合成鼠标事件测端到端行为在本环境不可靠（ProseMirror 的
         * `LeftMouseDown` 需要完整的按下-抬起序列），但断言这个契约是精确且稳定的。
         */
        const nodeView = blockDom.pmViewDesc
        const probeStop = (target: Element): boolean => {
          let stopped: boolean | null = null
          const listener = (event: Event): void => {
            stopped = nodeView.stopEvent(event)
          }
          blockDom.addEventListener('mousedown', listener)
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
          blockDom.removeEventListener('mousedown', listener)
          return stopped ?? false
        }

        check(
          '代码块留白不被 stopEvent 拦截（否则点击无法落入光标）',
          probeStop(pre) === false,
          `pre 的 stopEvent=${probeStop(pre)}`
        )

        // 反向检查：头部必须被拦截，否则语言下拉框会被 ProseMirror 抢走事件
        const languageSelect = dom.wysiwygHost.querySelector('.code-block__language')
        check(
          '语言下拉框仍被 stopEvent 拦截（保留原生行为）',
          languageSelect !== null && probeStop(languageSelect) === true,
          `select 的 stopEvent=${languageSelect ? probeStop(languageSelect) : 'n/a'}`
        )
      }
    }
    /**
     * 代码块里的**单字符删除不由键映射处理**：命令返回 false 后交给浏览器
     * 原生 contenteditable 删除，再由 DOM 观察器同步回文档模型。
     *
     * 因此"退格没反应"可能出在三个位置，必须分别验证：
     *  1. 键映射是否吞掉了按键
     *  2. DOM 变化能否同步回模型
     *  3. 焦点是否还在编辑区（语言下拉框会抢焦点）
     */
    codeEditor.setMarkdown('```java\n1111\n```')
    await nextFrame()

    const codeMarkdownBefore = codeEditor.getMarkdown()
    const codeElement = dom.wysiwygHost.querySelector<HTMLElement>('.code-block__code')

    // 场景 1：DOM 原生删除必须能同步回文档模型
    if (!codeElement) {
      check('代码块 DOM 可定位', false, '未找到 .code-block__code')
    } else {
      const collectTextNodes = (root: Node, out: Text[]): void => {
        for (const child of Array.from(root.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').length > 0) {
            out.push(child as Text)
          } else {
            collectTextNodes(child, out)
          }
        }
      }
      const textNodes: Text[] = []
      collectTextNodes(codeElement, textNodes)

      const lastText = textNodes[textNodes.length - 1]
      if (!lastText) {
        check('代码块内有可删除文本', false, codeElement.innerHTML.slice(0, 60))
      } else {
        // 直接改文本节点：这正是浏览器原生退格所做的事
        lastText.data = lastText.data.slice(0, -1)
        await nextFrame()
        await nextFrame()

        const afterDelete = codeEditor.getMarkdown()
        check(
          '代码块内原生删除可同步回模型',
          afterDelete !== codeMarkdownBefore,
          `${JSON.stringify(codeMarkdownBefore)} → ${JSON.stringify(afterDelete)}`
        )
      }
    }

    // 场景 2：空代码块退格应退出代码块（进入代码块后的标准退出手势）
    codeEditor.setMarkdown('```\n```')
    cursorToStart(codeEditor)
    backspaceAtStart(codeEditor)
    const afterExit = codeEditor.getMarkdown()
    check('空代码块退格退出为正文', !afterExit.includes('```'), JSON.stringify(afterExit))

    // 场景 3：非空代码块块首退格不得丢内容
    codeEditor.setMarkdown('```java\n1111\n```')
    cursorToStart(codeEditor)
    backspaceAtStart(codeEditor)
    check(
      '非空代码块块首退格不丢内容',
      codeEditor.getMarkdown().includes('1111'),
      JSON.stringify(codeEditor.getMarkdown())
    )

    // 场景 4：语言变更后焦点必须回到编辑区，否则后续按键全被下拉框吃掉
    codeEditor.setMarkdown('```ts\nconst a = 1\n```')
    await nextFrame()
    const focusProbeSelect = dom.wysiwygHost.querySelector<HTMLSelectElement>('.code-block__language')
    if (!focusProbeSelect) {
      check('语言下拉框可定位', false, '未找到 .code-block__language')
    } else {
      focusProbeSelect.value = 'javascript'
      focusProbeSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await nextFrame()

      const active = document.activeElement
      const focusInEditor = active !== null && dom.wysiwygHost.contains(active)
      check(
        '切换语言后焦点回到编辑区',
        focusInEditor,
        `activeElement=${active?.tagName ?? 'null'}${active?.className ? `.${active.className}` : ''}`
      )

      const beforeTyping = codeEditor.getMarkdown()
      codeEditor.autoInsert('7')
      check(
        '切换语言后仍可继续输入',
        codeEditor.getMarkdown() !== beforeTyping,
        JSON.stringify(codeEditor.getMarkdown())
      )
    }

    codeEditor.setMarkdown('')
  }

  /* ---------- L3：表格 ---------- */
  {
    const tableEditor = editor()!

    /**
     * 真正的往返：markdown → 文档 → markdown。
     *
     * 这里原先写的是 `normalize(normalize(source)) === normalize(source)`，
     * 那是**恒真**的——它只验证了 normalize 自身的幂等性，
     * 完全没有经过解析与序列化，因此对表格序列化缺陷零检测能力
     * （"多行被合并成一行"正是这样长期漏过的）。
     *
     * 用编辑器的 setMarkdown/getMarkdown 走完整链路，才是有意义的往返。
     * 列宽会按内容重算，所以比较前仍需规范化空白。
     */
    const tableSource = '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |'
    tableEditor.setMarkdown(tableSource)
    await nextFrame()
    const tableRoundTripped = tableEditor.getMarkdown()

    check(
      '表格 markdown 往返稳定',
      normalize(tableRoundTripped) === normalize(tableSource),
      JSON.stringify(tableRoundTripped).slice(0, 120)
    )

    // 行结构必须保住：这是"多行被合并"缺陷的直接判据
    let roundTripRows = 0
    tableEditor.state.doc.descendants((node) => {
      if (node.type.name === 'table_row') roundTripRows += 1
      return true
    })
    check('表格往返后行数不变', roundTripRows === 2, `行数=${roundTripRows}（期望 2）`)

    // 单元格数量必须逐行一致：合并行的特征就是某行单元格数翻倍
    const rowCellCounts: number[] = []
    tableEditor.state.doc.descendants((node) => {
      if (node.type.name === 'table_row') rowCellCounts.push(node.childCount)
      return true
    })
    check(
      '表格往返后各行列数一致',
      rowCellCounts.length >= 2 && rowCellCounts.every((count) => count === rowCellCounts[0]),
      `各行列数=[${rowCellCounts.join(',')}]`
    )

    // 必须解析为 table 节点，而不是退化成普通段落
    const parsedTable = markdownToDocument(tableSource)
    let tableNodeCount = 0
    let rowCount = 0
    parsedTable.descendants((node) => {
      if (node.type.name === 'table') tableNodeCount += 1
      if (node.type.name === 'table_row') rowCount += 1
      return true
    })
    check('表格解析为 table 节点', tableNodeCount === 1 && rowCount === 2, `table=${tableNodeCount} row=${rowCount}`)

    // 表头行必须映射为 table_header，否则存盘会丢掉表头
    let headerCount = 0
    parsedTable.descendants((node) => {
      if (node.type.name === 'table_header') headerCount += 1
      return true
    })
    check('首行映射为表头', headerCount === 2, `${headerCount} 个 table_header`)

    // 对齐方式往返：`:--:` 必须保持居中
    const aligned = '| 左 | 中 | 右 |\n| :--- | :--: | ---: |\n| a | b | c |'
    const alignedRoundTrip = normalize(aligned)
    check(
      '对齐标记往返保留',
      alignedRoundTrip.includes(':--:') && alignedRoundTrip.includes('---:'),
      JSON.stringify(alignedRoundTrip).slice(0, 100)
    )

    // 单元格内管道符：未转义会把 2 列解析成 3 列
    const escapedSource = '| 列 A | 列 B |\n| --- | --- |\n| a \\| b | c |'
    const escapedParsed = markdownToDocument(escapedSource)
    let escapedCellCount = 0
    escapedParsed.descendants((node) => {
      if (node.type.name === 'table_cell' || node.type.name === 'table_header') escapedCellCount += 1
      return true
    })
    check('单元格内转义管道不拆列', escapedCellCount === 4, `${escapedCellCount} 个单元格（期望 4）`)

    // 单元格内的行内标记必须与正文一致
    const richCell = '| 列 A |\n| --- |\n| **粗体** 与 `代码` |'
    const richRoundTrip = normalize(richCell)
    check(
      '单元格内行内标记保留',
      richRoundTrip.includes('**粗体**') && richRoundTrip.includes('`代码`'),
      JSON.stringify(richRoundTrip).slice(0, 90)
    )

    // 代码块里的管道符不能被当成表格
    const fenceTable = markdownToDocument('```\n| a | b |\n| --- | --- |\n```')
    let fenceTableCount = 0
    fenceTable.descendants((node) => {
      if (node.type.name === 'table') fenceTableCount += 1
      return true
    })
    check('代码块内的管道表不解析', fenceTableCount === 0, `${fenceTableCount} 个 table`)

    // 插入表格命令：DOM 出现 <table>，且模型里是 table 节点
    tableEditor.setMarkdown('')
    cursorToStart(tableEditor)
    const inserted = tableEditor.execute(tableCommands.insert)
    const tableDom = dom.wysiwygHost.querySelector('table')
    check(
      '插入表格命令生效',
      inserted && tableDom !== null,
      `命令=${inserted} DOM=${tableDom !== null}`
    )

    const context = tableContext(tableEditor.state)
    check(
      '表格上下文可查询',
      context.inTable && context.rows === 2 && context.columns === 3,
      `rows=${context.rows} columns=${context.columns} header=${context.isHeaderRow}`
    )

    // 增删行列
    const addedRow = tableEditor.execute(tableCommands.addRowAfter)
    const afterAdd = tableContext(tableEditor.state)
    check('增加行生效', addedRow && afterAdd.rows === 3, `rows=${afterAdd.rows}`)

    const addedColumn = tableEditor.execute(tableCommands.addColumnAfter)
    const afterColumn = tableContext(tableEditor.state)
    check('增加列生效', addedColumn && afterColumn.columns === 4, `columns=${afterColumn.columns}`)

    const deletedRow = tableEditor.execute(tableCommands.deleteRow)
    const afterDelete = tableContext(tableEditor.state)
    check('删除行生效', deletedRow && afterDelete.rows === 2, `rows=${afterDelete.rows}`)

    // 表格必须经 markdown 往返而不塌成段落
    const tableMarkdown = tableEditor.getMarkdown()
    const reparsed = markdownToDocument(tableMarkdown)
    let reparsedTables = 0
    reparsed.descendants((node) => {
      if (node.type.name === 'table') reparsedTables += 1
      return true
    })
    check(
      '编辑后的表格仍能往返',
      reparsedTables === 1 && tableMarkdown.includes('|'),
      `${reparsedTables} 个 table / ${tableMarkdown.length} 字符`
    )

    tableEditor.setMarkdown('')
  }

  /* ---------- L3：图片 ---------- */
  {
    const imageEditor = editor()!

    // markdown 往返
    const imageCases: [string, string][] = [
      ['相对路径图片', '![alt](assets/a.png)'],
      ['无 alt 图片', '![](assets/b.jpg)'],
      ['带 title 图片', '![图](assets/c.png "说明")'],
      ['正文中的行内图片', '文字 ![图](assets/d.png) 之后']
    ]
    const imageFailures: string[] = []
    for (const [label, markdown] of imageCases) {
      const result = normalize(markdown)
      if (result !== markdown) imageFailures.push(`${label}: ${JSON.stringify(result)}`)
    }
    check(
      '图片 markdown 逐字往返',
      imageFailures.length === 0,
      `${imageCases.length - imageFailures.length}/${imageCases.length}${
        imageFailures.length ? ` 失败 ${JSON.stringify(imageFailures)}` : ''
      }`
    )

    const parsedImage = markdownToDocument('![alt](assets/a.png)')
    let imageCount = 0
    parsedImage.descendants((node) => {
      if (node.type.name === 'image') imageCount += 1
      return true
    })
    check('图片解析为 image 节点', imageCount === 1, `${imageCount} 个 image`)

    // 真实二进制写入 + 路径解析（走主进程资源通道）
    const workspace = api.smoke.tempDir
    if (workspace.length === 0) {
      check('资源通道可用', false, '未注入临时目录')
    } else {
      // 8 字节 PNG magic + 任意载荷：足以验证无损写入，不需要是真图
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5
      ])
      const assetPath = `${workspace}/assets/test-image.png`

      try {
        const written = await api.assets.write({
          filePath: assetPath,
          bytes: pngBytes.buffer as ArrayBuffer
        })
        check(
          '图片二进制写入',
          written.byteLength === pngBytes.byteLength,
          `${written.byteLength} 字节`
        )

        const resolved = await api.assets.resolve({
          target: 'assets/test-image.png',
          baseDirectory: workspace
        })
        check('相对路径解析为绝对路径', resolved === assetPath, resolved ?? 'null')

        const missing = await api.assets.resolve({
          target: 'assets/not-there.png',
          baseDirectory: workspace
        })
        check('不存在的图片返回 null', missing === null, missing ?? 'null')
      } catch (error) {
        check('图片二进制写入', false, describeError(error))
        check('相对路径解析为绝对路径', false, '前置写入失败')
        check('不存在的图片返回 null', false, '前置写入失败')
      }

      // 越界防护：非图片扩展名与路径穿越必须被拒绝
      let rejectedExtension = false
      try {
        await api.assets.write({
          filePath: `${workspace}/assets/evil.sh`,
          bytes: pngBytes.buffer as ArrayBuffer
        })
      } catch {
        rejectedExtension = true
      }
      check('非图片扩展名被拒绝', rejectedExtension)

      let rejectedTraversal = false
      try {
        await api.assets.write({
          filePath: `${workspace}/assets/../../evil.png`,
          bytes: pngBytes.buffer as ArrayBuffer
        })
      } catch {
        rejectedTraversal = true
      }
      check('路径穿越被拒绝', rejectedTraversal)
    }

    // 缺失图片必须显示可读占位而不是破图
    imageEditor.setMarkdown('![缺失](assets/nope.png)')
    // 解析要经主进程 stat 往返，等条件成立而不是固定等一帧
    const placeholderAppeared = await waitFor(
      () => dom.wysiwygHost.querySelector('.image-node.is-missing') !== null
    )
    const missingPlaceholder = dom.wysiwygHost.querySelector('.image-node.is-missing')
    check(
      '缺失图片显示占位而非破图',
      placeholderAppeared,
      missingPlaceholder?.textContent ??
        `未显示占位（当前=${dom.wysiwygHost.querySelector('.image-node')?.className ?? '无'}）`
    )

    imageEditor.setMarkdown('')
  }

  /* ---------- 图片拖放：首次保存、另存为与标签生命周期 ---------- */
  {
    const previousId = store.active!.id
    const testSessions: string[] = []
    try {
      const workspace = api.smoke.tempDir
      if (!workspace) throw new Error('未注入图片自检临时目录')
      const directoryA = `${workspace}/image-drop-a`
      const directoryB = `${workspace}/image-drop-b`
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 2
      const context = canvas.getContext('2d')!
      context.fillStyle = '#2563eb'
      context.fillRect(0, 0, 2, 2)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('生成测试图片失败')), 'image/jpeg')
      })
      const file = new File([blob], '社保应缴尽缴的原因与信号（3）.jpeg', { type: 'image/jpeg' })
      const bytes = await file.arrayBuffer()
      const imageSession = store.createUntitled()
      testSessions.push(imageSession.id)
      await handleImageFiles([file])
      check(
        '真正未保存的文档仍提示先保存，不插图也不变脏',
        editor()!.isEmpty() && !store.isDirty(imageSession) &&
          dom.statusMessage.textContent === messages().error.imageNeedsSavedDocument
      )

      // 跳过原生路径选择对话框，沿用保存成功后的落盘与会话更新顺序。
      const saveTo = async (filePath: string): Promise<void> => {
        const markdown = editor()!.getMarkdown()
        const result = await api.file.write({ filePath, content: markdown, encoding: 'utf8', eol: 'lf' })
        store.markSaved(imageSession.id, markdown, result.encoding)
        store.updateFilePath(imageSession.id, filePath)
      }
      const sources = (): string[] => {
        const result: string[] = []
        editor()!.state.doc.descendants((node) => {
          if (node.type.name === 'image') result.push(String(node.attrs.src))
        })
        return result
      }
      const dropImage = async (expectedCount: number): Promise<boolean> => {
        const current = editor()!
        current.view.dispatch(current.state.tr.setSelection(TextSelection.atEnd(current.state.doc)))
        current.focus()
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(file)
        const event = new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })
        current.view.dom.dispatchEvent(event)
        await waitFor(() => sources().length === expectedCount ||
          dom.statusMessage.textContent?.includes(messages().status.imagePartialFailure) === true)
        return event.defaultPrevented && sources().length === expectedCount
      }
      const imagesLoaded = (count: number, directory: string): Promise<boolean> => waitFor(() => {
        const images = [...dom.wysiwygHost.querySelectorAll<HTMLImageElement>('.image-node img')]
        return images.length === count && images.every((image) =>
          image.complete && image.naturalWidth === 2 &&
          decodeURIComponent(image.src).startsWith(`file://${directory}/assets/`))
      })

      await saveTo(`${directoryA}/未命名.md`)
      const inserted = await dropImage(1)
      check('首次保存后无需切标签即可拖入中文文件名 JPEG', inserted, dom.statusMessage.textContent ?? '')
      if (!inserted) throw new Error('首次保存后的图片拖放失败')
      const source = sources()[0]
      const absolutePath = await api.assets.resolve({ target: source, baseDirectory: directoryA })
      const storedBytes = absolutePath ? await api.assets.read(absolutePath) : null
      check(
        '拖入图片写入文档旁 assets 且字节无损',
        absolutePath === `${directoryA}/${source}` && storedBytes !== null &&
          storedBytes.byteLength === bytes.byteLength &&
          new Uint8Array(storedBytes).every((value, index) => value === new Uint8Array(bytes)[index])
      )
      check('拖入图片可实际解码显示，文档标记为已修改', await imagesLoaded(1, directoryA) && store.isDirty(imageSession))

      // 预先复制测试资源，以单独验证另存为后的路径解析；应用并不自动迁移已有资源。
      const markdown = editor()!.getMarkdown()
      editor()!.setMarkdown(`${markdown}\n\n${markdown}`)
      store.commitActive(editor()!.getMarkdown())
      await api.assets.write({ filePath: `${directoryB}/${source}`, bytes })
      await saveTo(`${directoryB}/另存为.md`)
      check('另存为后同一图片的多个节点都刷新到新目录', await imagesLoaded(2, directoryB))
      const insertedAgain = await dropImage(3)
      const newSource = sources()[2]
      check(
        '另存为后拖入的新图片只写入新目录',
        insertedAgain &&
          await api.assets.resolve({ target: newSource, baseDirectory: directoryB }) === `${directoryB}/${newSource}` &&
          await api.assets.resolve({ target: newSource, baseDirectory: directoryA }) === null
      )
      await saveSession(imageSession)

      const temporary = store.createUntitled()
      testSessions.push(temporary.id)
      await handleImageFiles([file])
      check('已保存文档后新建空白文档，不沿用旧图片目录', editor()!.isEmpty() &&
        dom.statusMessage.textContent === messages().error.imageNeedsSavedDocument)
      store.activate(imageSession.id)
      check('切换标签后图片重新挂载并全部显示', await imagesLoaded(3, directoryB))

      const beforeSlowDrop = imageSession.markdown
      let finishRead!: (value: ArrayBuffer) => void
      const slowFile = new File([blob], '读取较慢的图片.jpeg', { type: 'image/jpeg' })
      Object.defineProperty(slowFile, 'arrayBuffer', {
        value: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve })
      })
      const pendingInsert = handleImageFiles([slowFile])
      store.activate(temporary.id)
      editor()!.insertText('切换后的正文')
      finishRead(bytes)
      await pendingInsert
      check('图片读取期间切标签不污染新旧文档',
        editor()!.getMarkdown() === '切换后的正文' && imageSession.markdown === beforeSlowDrop)

      store.close(imageSession.id)
      await openDocumentByPath(`${directoryB}/另存为.md`)
      if (store.active) testSessions.push(store.active.id)
      check('保存并重新打开文档后，图片相对路径仍可显示', await imagesLoaded(3, directoryB))
    } catch (error) {
      check('图片拖放与保存生命周期回归', false, describeError(error))
    } finally {
      for (const id of testSessions.reverse()) store.close(id)
      store.activate(previousId)
    }
  }

  /* ---------- L4：导出与主题 ---------- */
  {
    const exportEditor = editor()!
    const workspace = api.smoke.tempDir

    // 覆盖全部导出关注点：中文、公式、代码、表格、图片
    const exportSource = normalize(
      '# 导出验证\n\n' +
        '中文正文段落，含 **粗体** 与 `行内代码`。\n\n' +
        '行内公式 $E = mc^2$ 与块级公式：\n\n' +
        '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n' +
        '```ts\nconst answer: number = 42\n```\n\n' +
        '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n'
    )
    exportEditor.setMarkdown(exportSource)
    await nextFrame()

    /* --- HTML 生成 --- */
    const bodyHtml = documentToHtml(exportEditor.state.doc)
    check(
      '导出 HTML 含标题结构',
      bodyHtml.includes('<h1') && bodyHtml.includes('导出验证'),
      `${bodyHtml.length} 字符`
    )
    check(
      '导出 HTML 保留行内标记',
      bodyHtml.includes('<strong>') && bodyHtml.includes('<code>')
    )
    check(
      '导出 HTML 含表格结构',
      bodyHtml.includes('<table') && bodyHtml.includes('<th')
    )

    /**
     * 公式导出必须走 MathML。
     *
     * 这里断言的是**不含 KaTeX 的 HTML 输出标记**：KaTeX HTML 输出会带
     * `katex-html` 类并依赖 20 多个字体文件；MathML 输出带 `<math>` 且零依赖。
     * 若这条断言失败，说明导出改回了 HTML 输出，PDF 里公式会缺字。
     */
    check(
      '公式导出为 MathML（零字体依赖）',
      bodyHtml.includes('<math') && !bodyHtml.includes('katex-html'),
      bodyHtml.includes('<math') ? 'MathML 就绪' : '未找到 MathML'
    )

    const exportHtml = buildExportHtml({ title: '导出验证', bodyHtml })
    check(
      '导出 HTML 是完整独立文档',
      exportHtml.startsWith('<!doctype html>') &&
        exportHtml.includes('charset="utf-8"') &&
        exportHtml.includes('PingFang SC'),
      `${exportHtml.length} 字符`
    )
    check(
      '导出样式含分页控制',
      exportHtml.includes('break-inside: avoid') && exportHtml.includes('@page')
    )

    /* --- 图片内联 --- */
    try {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7])
      await api.assets.write({
        filePath: `${workspace}/assets/export-test.png`,
        bytes: pngBytes.buffer as ArrayBuffer
      })

      const withImage = `${bodyHtml}<p><img data-src="assets/export-test.png" alt="测试"></p>`
      const inlined = await inlineImages(withImage, workspace, api.assets)
      check(
        '图片内联为 data URL',
        inlined.inlined === 1 && inlined.html.includes('data:image/png;base64,'),
        `内联 ${inlined.inlined} 张 / 缺失 ${inlined.missing.length} 张`
      )

      const missingImage = await inlineImages(
        '<img data-src="assets/not-there.png" alt="缺失">',
        workspace,
        api.assets
      )
      check(
        '缺失图片导出为可见占位',
        missingImage.missing.length === 1 && missingImage.html.includes('image-missing'),
        missingImage.html.slice(0, 80)
      )
    } catch (error) {
      check('图片内联为 data URL', false, describeError(error))
      check('缺失图片导出为可见占位', false, '前置失败')
    }

    /* --- HTML 落盘 --- */
    try {
      const htmlResult = await api.export.html({
        html: exportHtml,
        suggestedName: 'typeflow-export.html',
        targetPath: `${workspace}/export-test.html`
      })
      check(
        'HTML 导出落盘',
        !htmlResult.canceled && htmlResult.filePath === `${workspace}/export-test.html`,
        htmlResult.filePath ?? 'null'
      )

      const written = await api.file.read(`${workspace}/export-test.html`, false)
      check(
        '导出的 HTML 可回读且内容完整',
        written.content.includes('导出验证') && written.content.includes('<table'),
        `${written.byteLength} 字节`
      )
    } catch (error) {
      check('HTML 导出落盘', false, describeError(error))
      check('导出的 HTML 可回读且内容完整', false, '前置失败')
    }

    /* --- PDF 落盘（关键：中文与字体嵌入） --- */
    if (workspace.length === 0) {
      check('PDF 导出落盘', false, '未注入临时目录')
    } else {
      try {
        const pdfResult = await api.export.pdf({
          html: exportHtml,
          suggestedName: 'typeflow-export.pdf',
          targetPath: `${workspace}/export-test.pdf`
        })

        check(
          'PDF 导出落盘',
          !pdfResult.canceled && (pdfResult.byteLength ?? 0) > 0,
          `${((pdfResult.byteLength ?? 0) / 1024).toFixed(1)} KB`
        )

        // 读取原始字节以校验 PDF 结构与字体嵌入
        const bytes = await api.assets.read(`${workspace}/export-test.pdf`)
        if (!bytes) {
          check('PDF 结构有效', false, '无法读取导出的 PDF')
        } else {
          const raw = new Uint8Array(bytes)
          const header = String.fromCharCode(...raw.subarray(0, 5))
          const text = latin1(raw)

          check('PDF 结构有效', header === '%PDF-', header)

          /**
           * 中文字体嵌入检查。
           *
           * PDF 里中文必须作为**嵌入字体**输出，否则在未安装对应字体的机器上
           * 会显示为空白或方框。`/FontFile2`（TrueType）与 `/FontFile3`（CFF）
           * 是字体数据被内嵌的标志，出现其一即说明字体随文件携带。
           *
           * 这里同时要求文件里出现 `/Font` 资源字典——只检查大小容易被
           * "导出了一张全是方框的 PDF"骗过。
           */
          const hasEmbeddedFont = text.includes('/FontFile2') || text.includes('/FontFile3')
          check(
            'PDF 嵌入字体数据',
            hasEmbeddedFont,
            `/FontFile2=${text.includes('/FontFile2')} /FontFile3=${text.includes('/FontFile3')} /Font=${text.includes('/Font')}`
          )

          // 中文 PDF 若字体未嵌入，体积会异常小（只存占位方框）
          check(
            'PDF 体积与内容量匹配',
            (pdfResult.byteLength ?? 0) > 20 * 1024,
            `${((pdfResult.byteLength ?? 0) / 1024).toFixed(1)} KB（含中文与公式，应明显大于 20 KB）`
          )
        }
      } catch (error) {
        check('PDF 导出落盘', false, describeError(error))
        check('PDF 结构有效', false, '前置失败')
        check('PDF 嵌入字体数据', false, '前置失败')
        check('PDF 体积与内容量匹配', false, '前置失败')
      }
    }

    /* --- 主题 --- */
    const originalVariant = state.themeVariant
    setThemeVariant('serif')
    check('排版主题切换', dom.root.dataset.variant === 'serif', dom.root.dataset.variant ?? '未设置')
    cycleThemeVariant()
    check('排版主题循环', state.themeVariant !== 'serif', state.themeVariant)
    setThemeVariant(originalVariant)

    injectCustomTheme('.typeflow-editor { color: rgb(1, 2, 3); }')
    const customStyle = document.getElementById('custom-theme')
    check(
      '自定义主题注入',
      customStyle !== null && (customStyle.textContent ?? '').includes('rgb(1, 2, 3)')
    )

    injectCustomTheme(null)
    check('自定义主题可清除', document.getElementById('custom-theme') === null)

    // 明暗与排版两轴必须可以自由组合
    setTheme('dark')
    setThemeVariant('serif')
    check(
      '明暗与排版主题正交',
      dom.root.dataset.theme === 'dark' && dom.root.dataset.variant === 'serif',
      `theme=${dom.root.dataset.theme} variant=${dom.root.dataset.variant}`
    )
    setTheme('light')
    setThemeVariant(originalVariant)

    exportEditor.setMarkdown('')
  }

  /* ---------- L5：i18n / 性能 / 更新 ---------- */
  {
    /* --- i18n 结构完整性 --- */
    const zh = messages('zh-CN')
    const en = messages('en-US')

    /**
     * 两份语言表的键结构必须完全一致。
     *
     * 缺键时英文界面会露出中文（或键名），这类缺陷在只测中文时完全不可见，
     * 因此这里做结构化比对而不是抽查几个字符串。
     */
    const flatten = (value: unknown, prefix = ''): string[] => {
      if (typeof value === 'string') return [prefix]
      if (typeof value !== 'object' || value === null) return []
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key)
      )
    }

    const zhKeys = flatten(zh).sort()
    const enKeys = flatten(en).sort()
    const onlyInZh = zhKeys.filter((key) => !enKeys.includes(key))
    const onlyInEn = enKeys.filter((key) => !zhKeys.includes(key))

    check(
      'i18n 两份语言表键结构一致',
      onlyInZh.length === 0 && onlyInEn.length === 0,
      `共 ${zhKeys.length} 键${onlyInZh.length ? ` 仅中文: ${onlyInZh.slice(0, 3).join(',')}` : ''}${
        onlyInEn.length ? ` 仅英文: ${onlyInEn.slice(0, 3).join(',')}` : ''
      }`
    )

    // 覆盖率下限：键数过少通常意味着字符串表被误删或被合并
    check(
      'i18n 字符串表规模合理',
      zhKeys.length > 100 && Object.values(zh).every((section) => typeof section === 'object'),
      `${zhKeys.length} 键`
    )

    /**
     * 英文界面里不得残留中文。
     *
     * 这类缺陷只在切到英文后才可见：工具栏里几个按钮的文案是**硬编码中文**
     * （表格的 +行/+列/−行/−列/✕表），没有 data-i18n 标注，
     * 于是中文界面看着正常、英文界面露出一片中文。
     *
     * 判据用"是否含 CJK 字符"而不是逐个比对文案：
     * 这样新增按钮忘记标注时也会被抓住，而不是只覆盖已知的那几个。
     */
    {
      const CJK = /[\u3400-\u9fff\uff00-\uffef]/
      const originalLocale = getLocale()

      /**
       * 收集"界面外壳"里所有面向用户的文字。
       *
       * 刻意**排除**文档内容、预览区与文件树里的文件名——
       * 那些是用户自己的文本，含中文完全正常。要检查的是 chrome 自身的文案。
       */
      const collectChromeText = (): { where: string; value: string }[] => {
        const entries: { where: string; value: string }[] = []

        const push = (where: string, value: string | null | undefined): void => {
          if (value !== null && value !== undefined && value.trim().length > 0) {
            entries.push({ where, value: value.trim() })
          }
        }

        for (const element of document.querySelectorAll<HTMLElement>(
          '.toolbar button, .sidebar__tab, .finder button'
        )) {
          push(
            element.dataset.action ?? element.dataset.table ?? element.dataset.format ?? element.className,
            element.textContent
          )
          push('title', element.getAttribute('title'))
        }

        // 面板空状态（大纲、文件树）由模块自绘，不在 data-i18n 体系里
        for (const element of document.querySelectorAll<HTMLElement>('.panel-empty, .tree-empty')) {
          push('空状态', element.textContent)
        }

        // 侧栏输入框的占位符同样由模块自绘
        for (const element of document.querySelectorAll<HTMLInputElement>(
          '#panel-search input, #finder input'
        )) {
          push('placeholder', element.placeholder)
        }

        // 状态栏所有 chip
        for (const element of document.querySelectorAll<HTMLElement>('.status-bar > *')) {
          push('状态栏', element.textContent)
        }

        return entries
      }

      await changeLocale('en-US')
      await nextFrame()

      const chrome = collectChromeText()
      const withCjk = chrome.filter((entry) => CJK.test(entry.value))

      check(
        '英文界面全部界面文案无中文残留',
        chrome.length > 0 && withCjk.length === 0,
        withCjk.length === 0
          ? `检查 ${chrome.length} 处文案`
          : `${withCjk.map((entry) => `${entry.where}=${JSON.stringify(entry.value)}`).join(', ')} [locale=${getLocale()} 切换异常=${JSON.stringify(lastLocaleError)}]`
      )

      /**
       * 菜单标签必须是当前语言。
       *
       * 菜单标签在 `Menu.buildFromTemplate` 时被固化成字符串。
       * `installRecentFilesMenu` 内部会重建整份菜单，因此语言切换后应予更新；
       * 这条断言是防回归的守卫（撤掉重建逻辑即会失败）。
       */
      const enMenu = await api.smoke.menuLabels()
      const enMenuHasCjk = [...enMenu.top, ...enMenu.file].some((label) => CJK.test(label))

      check(
        '切换为英文后应用菜单同步重建',
        enMenu.top.length > 0 && !enMenuHasCjk,
        `顶级菜单=[${enMenu.top.join('|')}]`
      )

      /**
       * 窗口标题同样由主进程生成。
       *
       * 未命名文档的标题取自 `messages().app.untitled`，只在文件路径变化时重设；
       * 语言切换不会触发路径变化，因此渲染层必须主动重推一次。
       */
      check(
        '切换为英文后窗口标题同步更新',
        !CJK.test(enMenu.windowTitle) && enMenu.windowTitle.includes('TypeFlow'),
        JSON.stringify(enMenu.windowTitle)
      )

      // 切回中文：菜单与标题都要跟着回来
      await changeLocale('zh-CN')
      await nextFrame()

      const zhMenu = await api.smoke.menuLabels()
      check(
        '切回中文后应用菜单同样重建',
        zhMenu.top.some((label) => CJK.test(label)),
        `顶级菜单=[${zhMenu.top.join('|')}]`
      )

      if (getLocale() !== originalLocale) await changeLocale(originalLocale)
    }

    /**
     * 语言菜单项必须可以**反复**切换。
     *
     * 覆盖用户报告："视图 → 切换界面语言，只有一次有效，后面点击无效"。
     *
     * 根因是循环切换时用了 localStorage 里的语言快照，而它只在启动时写入一次：
     * 每次点击都算同一个"下一个语言"，于是第一次之后就没有变化。
     *
     * 断言连续三次切换的语言序列，而不是只切一次——
     * 只切一次的断言对这个缺陷毫无检测能力（第一次本来就是好的）。
     */
    {
      const originalLocale = getLocale()
      const sequence: string[] = [originalLocale]

      for (let step = 0; step < 3; step += 1) {
        await cycleLocale()
        await nextFrame()
        sequence.push(getLocale())
      }

      const allDifferent = sequence.every(
        (locale, index) => index === 0 || locale !== sequence[index - 1]
      )

      check(
        '语言菜单项可连续切换（不止第一次生效）',
        allDifferent &&
          sequence.every((locale) => SUPPORTED_LOCALES.includes(locale as never)),
        sequence.join(' → ')
      )

      // 界面文案必须跟着语言走：切到英文时工具栏无中文
      const CJK = /[\u3400-\u9fff\uff00-\uffef]/
      await changeLocale('en-US')
      await nextFrame()
      const englishOk = Array.from(document.querySelectorAll<HTMLElement>('.toolbar button')).every(
        (button) => !CJK.test(button.textContent ?? '') && !CJK.test(button.title)
      )

      await changeLocale('zh-CN')
      await nextFrame()
      const chineseOk = Array.from(document.querySelectorAll<HTMLElement>('.toolbar button')).some(
        (button) => CJK.test(button.textContent ?? '')
      )

      check(
        '反复切换后界面文案与当前语言一致',
        englishOk && chineseOk,
        `英文界面无中文=${englishOk} 中文界面有中文=${chineseOk}`
      )

      if (getLocale() !== originalLocale) await changeLocale(originalLocale)
    }

    /**
     * 工具栏必须让所有按钮可达。
     *
     * 曾经用 `nowrap + overflow-x: auto` 加隐藏滚动条：窗口稍窄时右侧按钮
     * 被裁掉且**看不见滚动条**，用户以为按钮丢了（英文标签更长，更易触发）。
     * 现在允许换行，判据变成"没有任何按钮被水平裁掉"。
     */
    {
      const toolbar = document.querySelector<HTMLElement>('.toolbar')
      check('工具栏存在', toolbar !== null, toolbar ? '存在' : '未找到')

      if (toolbar) {
        const toolbarRect = toolbar.getBoundingClientRect()
        const buttons = Array.from(toolbar.querySelectorAll<HTMLElement>('button'))

        /**
         * 用"按钮右边缘不超出工具栏内容右边缘"判断裁剪。
         * 注意要按 **offsetLeft/offsetTop** 这类布局值比较：
         * 换行后按钮分布在多行，getBoundingClientRect 会受滚动位置影响。
         */
        const clipped = buttons.filter((button) => {
          const right = button.offsetLeft + button.offsetWidth
          return right > toolbar.clientWidth + 1
        })

        check(
          '工具栏按钮不被水平裁剪',
          buttons.length > 0 && clipped.length === 0,
          clipped.length === 0
            ? `${buttons.length} 个按钮全部可达`
            : `${clipped.length} 个被裁剪，例如 ${clipped[0]?.textContent?.trim() || clipped[0]?.dataset.action || '?'}`
        )

        // 工具栏也不该出现横向滚动（出现即说明仍有内容被藏起来）
        check(
          '工具栏无横向溢出',
          toolbar.scrollWidth <= toolbar.clientWidth + 1,
          `scrollWidth=${toolbar.scrollWidth} clientWidth=${toolbar.clientWidth} 高=${Math.round(
            toolbarRect.height
          )}`
        )
      }
    }

    check(
      'locale 归一化正确',
      normalizeLocale('zh-Hans-CN') === 'zh-CN' &&
        normalizeLocale('en-GB') === 'en-US' &&
        // 海外上架：未支持的系统语言回退英文，而不是默认中文
        normalizeLocale('fr-FR') === 'en-US' &&
        normalizeLocale(null) === 'zh-CN',
      [
        normalizeLocale('zh-Hans-CN'),
        normalizeLocale('en-GB'),
        normalizeLocale('fr-FR')
      ].join('/')
    )

    // 切换语言后界面文案必须真的变
    setLocale('en-US')
    applyTranslations()
    const englishReady = dom.statusMessage.textContent
    setLocale('zh-CN')
    applyTranslations()
    const chineseReady = dom.statusMessage.textContent
    check(
      '切换语言后界面文案变化',
      englishReady !== chineseReady && englishReady !== null && chineseReady !== null,
      `${JSON.stringify(englishReady)} → ${JSON.stringify(chineseReady)}`
    )

    // 静态元素确实被翻译（工具栏按钮）
    const exportButton = document.querySelector<HTMLElement>('[data-action="export-html"]')
    check(
      '静态元素按标注翻译',
      exportButton !== null && (exportButton.title ?? '').length > 0,
      exportButton?.title ?? '无 title'
    )

    /* --- 性能：昂贵刷新合并 --- */
    const perfEditor = editor()!
    perfEditor.setMarkdown('# 性能验证\n\n初始内容\n')
    await nextFrame()

    const before = getExpensiveRefreshCount()

    // 模拟连续快速输入：合并调度应把它压成远少于 20 次的计算
    for (let index = 0; index < 20; index += 1) {
      perfEditor.autoInsert('x')
    }

    const duringBurst = getExpensiveRefreshCount() - before
    check(
      '连续输入不触发逐键重算',
      duringBurst === 0,
      `20 次输入期间重算 ${duringBurst} 次（应为 0，说明已合并）`
    )

    // 等待合并刷新落地
    await new Promise((resolve) => setTimeout(resolve, EXPENSIVE_REFRESH_DELAY_MS + 60))
    const afterSettle = getExpensiveRefreshCount() - before
    check(
      '停止输入后完成一次合并刷新',
      afterSettle >= 1 && afterSettle <= 3,
      `20 次输入最终重算 ${afterSettle} 次`
    )

    // 统计结果必须仍然正确——合并不能导致数据错误
    const statsText = dom.statusStats.textContent ?? ''
    check(
      '合并刷新后统计仍准确',
      statsText.includes(String(perfEditor.getMarkdown().length)),
      `${statsText} / 实际 ${perfEditor.getMarkdown().length} 字符`
    )

    // 装载文档必须立即刷新（用户正在等结果）
    const beforeLoad = getExpensiveRefreshCount()
    perfEditor.setMarkdown('# 立即刷新\n')
    flushExpensiveRefresh()
    check(
      '装载文档立即刷新',
      getExpensiveRefreshCount() > beforeLoad,
      `重算 ${getExpensiveRefreshCount() - beforeLoad} 次`
    )

    perfEditor.setMarkdown('')

    /* --- 自动更新状态 --- */
    const updateState = await api.update.getState()
    check(
      '更新状态可查询',
      typeof updateState.status === 'string',
      updateState.status
    )

    /**
     * 更新检查失败时，**只允许是网络层失败**，不允许是配置/文件系统层失败。
     *
     * 三种构建下的实际形态：
     *  - 开发态：app.isPackaged 为 false → unavailable（"开发模式不支持自动更新"）
     *  - 打包态（dir 目标）：缺少 app-update.yml → unavailable，且带可读原因
     *  - 打包态（zip/dmg）：有配置 → 真的发起请求，离线时 error / net::ERR_NAME_NOT_RESOLVED
     *
     * 早先版本在缺少配置时返回 error 并夹带原始 ENOENT，
     * 那是用户无法理解的报错——这个问题只在打包产物上才暴露。
     *
     * 但网络层失败必须放过：自检机器离线是常态，
     * 若把 `net::ERR_NAME_NOT_RESOLVED` 判为失败，这条断言就变成"自检需要联网"，
     * 与本项目"全部验证都在本地跑"的原则冲突。
     * 区分依据是消息形态：网络失败一律以 `net::` 开头或带 DNS/连接错误码，
     * 而配置缺失的原始错误里必然出现文件路径或 ENOENT。
     */
    const checkResult = await api.update.check()
    const failureMessage = checkResult.message ?? ''
    const networkFailure =
      /^net::/.test(failureMessage) ||
      /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(
        failureMessage
      )
    check(
      '更新检查不抛原始错误',
      checkResult.status !== 'error' || networkFailure,
      `${checkResult.status}${failureMessage ? ` / ${failureMessage}` : ''}`
    )
    check('更新状态订阅通道可用', typeof api.update.onStateChanged === 'function')
  }

  /* ---------- UI 缺陷回归（人工验收发现） ---------- */
  {
    /* --- 查找框必须能连续输入 --- */
    /**
     * 这条断言针对一个真实缺陷：**每输入一个字符，焦点就被抢回编辑区**，
     * 于是用户只能输入一个字母（想搜 "docker" 只能搜到 "d"）。
     *
     * 断言方式是"逐字符输入并检查焦点是否还在查找框"——
     * 而不是只检查最终查询串。因为缺陷恰恰发生在字符之间，
     * 只看结果会以为"查询串是对的"（其实是在编辑器里继续打了字）。
     */
    {
      /**
       * 必须用**长文档**：短文档一屏就装得下，滚动位置恒为 0，
       * 断言"滚动发生了变化"会永远失败（真机上却看不出问题）。
       * 这里的匹配刻意分散在文档首尾，确保步进必然跨越视口。
       */
      const finderEditor = editor()!
      const paragraphs = Array.from({ length: 120 }, (_unused, index) =>
        index % 30 === 0 ? `第 ${index} 段含有 docker 关键词` : `第 ${index} 段普通内容`
      )
      finderEditor.setMarkdown(`# docker 笔记\n\n${paragraphs.join('\n\n')}\n`)
      await nextFrame()

      openFinder()
      await nextFrame()

      dom.finderInput.value = ''
      dom.finderInput.dispatchEvent(new Event('input'))

      const query = 'docker'
      let focusLostAt: string | null = null

      for (const character of query) {
        if (document.activeElement !== dom.finderInput) {
          focusLostAt = character
          break
        }
        dom.finderInput.value += character
        dom.finderInput.dispatchEvent(new Event('input'))
        await nextFrame()
      }

      check(
        '查找框可连续输入（每输入一字符不被抢焦点）',
        focusLostAt === null && dom.finderInput.value === query,
        focusLostAt === null
          ? `完整输入 ${JSON.stringify(dom.finderInput.value)}`
          : `在第 ${JSON.stringify(focusLostAt)} 个字符处失去焦点，实际输入 ${JSON.stringify(dom.finderInput.value)}`
      )

      check(
        '完整查询可命中多个匹配',
        finder.matches.length >= 4,
        `${finder.matches.length} 处匹配（期望 ≥4）`
      )

      check(
        '查找期间焦点仍在查找框',
        document.activeElement === dom.finderInput,
        `activeElement=${document.activeElement?.id || document.activeElement?.tagName || 'null'}`
      )

      /**
       * 步进必须真的改变编辑器里的显示。
       *
       * 这一条覆盖用户报告的问题：**按 Enter / 点上下箭头没有跳转**。
       * 断言两层——装饰器存在（有高亮）且当前项唯一（能看出跳到哪了），
       * 以及滚动位置确实发生了变化。
       *
       * 只断言"计数变成 5/28"是不够的：计数属于查找框自身，
       * 即使编辑器完全没反应计数也会变。
       */
      const hitsBefore = dom.wysiwygHost.querySelectorAll('.search-hit').length
      const currentBefore = dom.wysiwygHost.querySelectorAll('.search-hit--current').length

      check('查找在编辑器中渲染全部匹配高亮', hitsBefore >= 4, `${hitsBefore} 处高亮`)
      check('当前匹配项唯一标出', currentBefore === 1, `${currentBefore} 个当前项`)

      /**
       * 步进必须让**编辑器里的显示**跟着动。
       *
       * 断言的判据是"当前高亮在屏幕上的纵坐标"与"滚动位置"，
       * 而不是查找框里的计数——计数属于查找框自身，
       * 即使编辑器毫无反应它也会变（用户报告的问题正是这样：计数在动，内容不动）。
       */
      const indexBefore = finder.index
      const positionBefore = currentHitTop()
      const scrollBefore = findScrollOffset()

      dom.finderInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
      await nextFrame()
      await nextFrame()

      check(
        '按 Enter 步进推进了当前项',
        finder.index !== indexBefore,
        `index ${indexBefore} → ${finder.index}`
      )
      check(
        'Enter 步进使当前高亮在屏幕上的位置改变',
        currentHitTop() !== positionBefore,
        `top ${Math.round(positionBefore)} → ${Math.round(currentHitTop())}`
      )
      /**
       * 滚动断言必须走到**视口之外**的匹配项。
       *
       * 前几个匹配就在文档顶部，此时"把匹配放到视口上方三分之一处"
       * 计算结果本就为 0——不滚动是正确行为。
       * 因此这里一直步进到滚动位置真的变化为止，
       * 而不是只走一步就断言（那只会在匹配恰好靠前时误报失败）。
       */
      let scrollChanged = false
      for (let step = 0; step < finder.matches.length; step += 1) {
        dom.finderInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
        await nextFrame()
        if (findScrollOffset() !== scrollBefore) {
          scrollChanged = true
          break
        }
      }

      check(
        '步进到视口外的匹配时触发滚动',
        scrollChanged,
        scrollChanged
          ? `scrollTop 0 → ${Math.round(findScrollOffset())}`
          : `遍历 ${finder.matches.length} 个匹配均未滚动 诊断=${JSON.stringify(getLastScrollDiagnostics())}`
      )

      // 上下箭头按钮走的是同一条 stepMatch 路径，验证按钮确实接上了
      const indexBeforeButton = finder.index
      requireElement('finder-next').click()
      await nextFrame()
      check(
        '上下箭头按钮同样可步进',
        finder.index !== indexBeforeButton,
        `index ${indexBeforeButton} → ${finder.index}`
      )

      // 关闭后高亮必须清干净，不能在文档上留下无来源的标记
      closeFinder()
      await nextFrame()
      check(
        '关闭查找框后高亮清除',
        dom.wysiwygHost.querySelectorAll('.search-hit').length === 0,
        `残留 ${dom.wysiwygHost.querySelectorAll('.search-hit').length} 处高亮`
      )

      // 关闭查找框后焦点应归还编辑区，用户可以直接继续写作
      closeFinder()
      await nextFrame()
      check(
        '关闭查找框后焦点回到编辑区',
        dom.wysiwygHost.contains(document.activeElement),
        `activeElement=${document.activeElement?.className || document.activeElement?.tagName || 'null'}`
      )

      finderEditor.setMarkdown('')
    }

    /* --- 行内代码与选区必须视觉可分 --- */
    /**
     * 这两者曾用同一个背景色，导致用户把"行内代码"误认为"被选中的内容"——
     * 报告的现象是"点击搜索结果后高亮跑到别处去了"。
     *
     * 断言方式是"两个变量的取值不同"，而不是比较具体颜色值：
     * 前者表达的是设计意图（必须可区分），后者一改配色就会失效。
     */
    {
      const rootStyle = getComputedStyle(document.documentElement)
      const codeBg = rootStyle.getPropertyValue('--code-inline-bg').trim()
      const selectionBg = rootStyle.getPropertyValue('--selection-bg').trim()

      check(
        '行内代码与选区背景色不同（避免误判为高亮）',
        codeBg.length > 0 && selectionBg.length > 0 && codeBg !== selectionBg,
        `code=${codeBg} selection=${selectionBg}`
      )
    }

    /* --- 界面设置可重置 --- */
    /**
     * 界面设置必须存在一条明确的退路。
     *
     * 界面状态是"粘性"的：用户误设了不明显的选项（排版主题、布局）
     * 或遇到显示异常时，如果只能靠手动删配置文件恢复，那就是产品缺陷。
     */
    {
      const beforeReset = window.localStorage.getItem(PREFERENCE_KEYS.themeVariant)
      window.localStorage.setItem(PREFERENCE_KEYS.themeVariant, 'compact')
      window.localStorage.setItem(PREFERENCE_KEYS.layout, 'preview')

      // 只清 localStorage 的那部分逻辑（重载由真实调用负责）
      for (const key of Object.values(PREFERENCE_KEYS)) window.localStorage.removeItem(key)

      const cleared =
        window.localStorage.getItem(PREFERENCE_KEYS.themeVariant) === null &&
        window.localStorage.getItem(PREFERENCE_KEYS.layout) === null

      check('重置界面设置可清空界面偏好', cleared, `themeVariant=${beforeReset ?? 'null'}`)

      // 最近文件属于工作痕迹，不应被界面重置影响——这里验证它仍可读
      const prefsAfterReset = await api.prefs.get()
      check(
        '重置界面设置不影响最近文件',
        Array.isArray(prefsAfterReset.recent),
        `recent=${prefsAfterReset.recent.length} 条`
      )
    }

    /* --- 工具栏按钮必须有可见内容 --- */
    /**
     * 这条断言针对的是一类特定缺陷：**给按钮加 i18n 标注时把文字删掉了**。
     *
     * 只要按钮有 `data-i18n`，`applyTranslations` 会填回文字；
     * 但若只有 `data-i18n-title`（title 不显示为内容），按钮就会渲染成空白。
     * 单看代码很难发现——它需要"把每个按钮都当成可能为空"来审查。
     */
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar button'))
    const blankButtons = buttons.filter((button) => {
      const hasText = (button.textContent ?? '').trim().length > 0
      const hasIcon = button.querySelector('svg') !== null
      return !hasText && !hasIcon
    })

    check(
      '工具栏按钮均有可见内容或图标',
      blankButtons.length === 0,
      blankButtons.length === 0
        ? `共 ${buttons.length} 个按钮`
        : `空白按钮: ${blankButtons
            .map((button) => button.dataset.action ?? button.dataset.table ?? button.dataset.format ?? '?')
            .join(', ')}`
    )

    // 反向检查：带图标类名的按钮必须真的有 svg，避免类名加了但图标忘了
    const iconButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.toolbar__icon')
    )
    check(
      '图标按钮均含 SVG',
      iconButtons.length > 0 && iconButtons.every((button) => button.querySelector('svg') !== null),
      `${iconButtons.length} 个图标按钮`
    )

    /* --- 显示区开关与滚动联动 --- */
    /**
     * 覆盖用户报告的两个问题：
     *  1. 编辑区滚到底、显示区还停在顶部（历史上从未实现过联动）；
     *  2. 想要"点一下只留编辑区、再点一下恢复"的工具栏开关。
     *
     * 滚动断言必须落在**真实滚动位置**上，而不是直接调用 syncScroll()：
     * 直接调函数只能证明函数自身没错，证明不了 scroll 事件真的接到了它——
     * 而"监听器没绑上/绑到了错误的容器"恰恰是这类功能最可能的失效方式。
     */
    {
      const layoutBefore = state.layout
      const modeBefore = state.mode
      setMode('wysiwyg')
      setLayout('split')

      // 必须用长文档：一屏装得下时两端 scrollHeight 都不超过 clientHeight，
      // "滚到底"恒等于 0，断言会永远通过却什么也没验证
      const syncParagraphs = Array.from({ length: 160 }, (_unused, index) => `第 ${index} 段联动内容`)
      editor()!.setMarkdown(`# 联动\n\n${syncParagraphs.join('\n\n')}\n`)
      await nextFrame()
      flushExpensiveRefresh()
      setLayout('split')
      await nextFrame()

      const from = editorScroller()
      const to = dom.preview
      const bothScrollable =
        from.scrollHeight > from.clientHeight && to.scrollHeight > to.clientHeight

      check(
        '分屏下编辑区与显示区均可滚动（联动的前提）',
        bothScrollable,
        `editor ${from.scrollHeight}/${from.clientHeight} preview ${to.scrollHeight}/${to.clientHeight}`
      )

      from.scrollTop = 0
      to.scrollTop = 0
      await nextFrame()
      await nextFrame()

      from.scrollTop = from.scrollHeight - from.clientHeight
      const followedDown = await waitFor(
        () => to.scrollTop >= to.scrollHeight - to.clientHeight - 2
      )
      check(
        '编辑区滚到底时显示区跟随到底',
        followedDown,
        `editor=${Math.round(from.scrollTop)} preview=${Math.round(to.scrollTop)}/${Math.round(
          to.scrollHeight - to.clientHeight
        )}`
      )

      from.scrollTop = 0
      await nextFrame()
      await nextFrame()

      to.scrollTop = to.scrollHeight - to.clientHeight
      const followedUp = await waitFor(
        () => from.scrollTop >= from.scrollHeight - from.clientHeight - 2
      )
      check(
        '显示区滚到底时编辑区跟随到底（反向同样生效）',
        followedUp,
        `preview=${Math.round(to.scrollTop)} editor=${Math.round(from.scrollTop)}/${Math.round(
          from.scrollHeight - from.clientHeight
        )}`
      )

      /**
       * 端点对齐只能证明"到底就是到底"——把映射写成常数 max 也能通过。
       * 中点才证明用的是比例映射：这也是本功能选定的语义（首尾严格对齐，中部按高度比例）。
       */
      from.scrollTop = 0
      to.scrollTop = 0
      await nextFrame()
      await nextFrame()

      const toMax = to.scrollHeight - to.clientHeight
      from.scrollTop = Math.round((from.scrollHeight - from.clientHeight) / 2)
      await nextFrame()
      await nextFrame()

      const ratio = toMax > 0 ? to.scrollTop / toMax : 0
      check(
        '编辑区滚到一半时显示区也停在中点（比例映射）',
        Math.abs(ratio - 0.5) < 0.05,
        `preview=${(ratio * 100).toFixed(1)}%`
      )

      /**
       * 用户报告的场景是"在文档底部编辑"，所以光滚到底还不够：
       * 打字会触发显示区**整体重渲染**（`renderPreview()` 用 `replaceChildren` 换掉整棵子树），
       * 必须确认重渲染不把显示区弹回顶部——否则联动只在纯滚动时有用，
       * 一动手写字就失效，而这恰恰是写作时的常态。
       */
      from.scrollTop = from.scrollHeight - from.clientHeight
      const backAtBottom = await waitFor(
        () => to.scrollTop >= to.scrollHeight - to.clientHeight - 2
      )
      editor()!.execute((editorState, dispatch) => {
        if (dispatch === undefined) return false
        dispatch(editorState.tr.setSelection(TextSelection.atEnd(editorState.doc)))
        return true
      })
      const refreshBefore = getExpensiveRefreshCount()
      editor()!.insertText('补一句')
      await new Promise((resolve) => window.setTimeout(resolve, EXPENSIVE_REFRESH_DELAY_MS + 120))
      await nextFrame()

      const bottomRatio = to.scrollHeight - to.clientHeight > 0
        ? to.scrollTop / (to.scrollHeight - to.clientHeight)
        : 0
      // 必须同时断言"重渲染真的发生了"：否则等不到刷新时这条也会通过，等于没测
      const refreshed = getExpensiveRefreshCount() - refreshBefore
      check(
        '在底部编辑后显示区仍停在底部（重渲染不弹回顶部）',
        backAtBottom && bottomRatio > 0.9 && refreshed > 0,
        `preview=${Math.round(to.scrollTop)}/${Math.round(to.scrollHeight - to.clientHeight)}（${(
          bottomRatio * 100
        ).toFixed(0)}%）重渲染 ${refreshed} 次`
      )

      /* 显示区开关：长在内容区右上角（分屏 ↔ 仅编辑区 ↔ 仅预览） */
      /**
       * 开关不再在工具栏里：它浮在内容区右上角，分屏 / 仅预览时在显示区里、
       * 仅编辑区时在编辑区里——三种布局下都落在同一个屏幕角落，位置不跳。
       * 可见性用 offsetParent 判：pane 被 display:none 时，里面按钮的 computed
       * display 仍是它自己的值（flex），读 computed 会把藏起来的按钮当成可见。
       * 图标读 computed display 而不是 data-preview——属性对了但选择器写错时，
       * 用户看到的是一个与当前状态相反的图标，而属性断言全绿。
       */
      const toggles = (): HTMLButtonElement[] =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('.pane-toggle[data-action="toggle-preview"]')
        )
      const visibleToggle = (): HTMLButtonElement | undefined =>
        toggles().find((button) => button.offsetParent !== null)
      const iconDisplay = (button: HTMLButtonElement, selector: string): string =>
        getComputedStyle(button.querySelector<SVGElement>(selector)!).display
      const iconState = (button: HTMLButtonElement): string =>
        `${iconDisplay(button, '.icon-preview-visible')}/${iconDisplay(button, '.icon-preview-hidden')}/${iconDisplay(
          button,
          '.icon-preview-reading'
        )}`
      const inPane = (button: HTMLButtonElement | undefined, paneSelector: string): boolean =>
        button !== undefined && button.closest(paneSelector) !== null
      const paneOf = (button: HTMLButtonElement | undefined): string =>
        button?.closest('.pane')?.className ?? '无'

      const previewPaneElement = document.querySelector<HTMLElement>('.pane--preview')!
      const splitToggle = visibleToggle()
      check(
        '显示区开关长在内容区里、工具栏里没有（两个 pane 各一个）',
        document.querySelector('.toolbar [data-action="toggle-preview"]') === null &&
          toggles().length === 2 &&
          inPane(splitToggle, '.pane--preview') &&
          splitToggle?.dataset.preview === 'visible' &&
          splitToggle?.title === messages().toolbar.hidePreview,
        `工具栏=${
          document.querySelector('.toolbar [data-action="toggle-preview"]') === null ? '无' : '有'
        } 开关=${toggles().length} 个 可见者所在=${paneOf(splitToggle)} title=${splitToggle?.title ?? '无'}`
      )

      splitToggle?.click()
      await nextFrame()
      const collapsedToggle = visibleToggle()
      const hiddenOk =
        state.layout === 'source' &&
        dom.editorArea.dataset.view === 'source' &&
        getComputedStyle(previewPaneElement).display === 'none' &&
        inPane(collapsedToggle, '.pane--editor') &&
        collapsedToggle?.dataset.preview === 'hidden' &&
        collapsedToggle?.title === messages().toolbar.showPreview &&
        collapsedToggle !== undefined &&
        iconDisplay(collapsedToggle, '.icon-preview-visible') === 'none' &&
        iconDisplay(collapsedToggle, '.icon-preview-hidden') !== 'none'
      check(
        '点显示区里的开关收起显示区（按钮落到编辑区同一角落）',
        hiddenOk,
        `view=${dom.editorArea.dataset.view} pane=${getComputedStyle(previewPaneElement).display} 可见者所在=${paneOf(
          collapsedToggle
        )} icon=${collapsedToggle === undefined ? '无' : iconState(collapsedToggle)} title=${
          collapsedToggle?.title ?? '无'
        }`
      )

      collapsedToggle?.click()
      await nextFrame()
      const restoredToggle = visibleToggle()
      const shownOk =
        state.layout === 'split' &&
        dom.editorArea.dataset.view === 'split' &&
        getComputedStyle(previewPaneElement).display !== 'none' &&
        inPane(restoredToggle, '.pane--preview') &&
        restoredToggle?.dataset.preview === 'visible' &&
        restoredToggle?.title === messages().toolbar.hidePreview
      check(
        '点编辑区里的开关恢复编辑区 + 显示区',
        shownOk,
        `view=${dom.editorArea.dataset.view} pane=${getComputedStyle(previewPaneElement).display} 可见者所在=${paneOf(
          restoredToggle
        )} title=${restoredToggle?.title ?? '无'}`
      )

      setLayout('preview')
      await nextFrame()
      const readingToggle = visibleToggle()
      const readingOk =
        readingToggle !== undefined &&
        inPane(readingToggle, '.pane--preview') &&
        readingToggle.dataset.preview === 'reading' &&
        readingToggle.title === messages().toolbar.restoreSplit &&
        iconDisplay(readingToggle, '.icon-preview-visible') === 'none' &&
        iconDisplay(readingToggle, '.icon-preview-reading') !== 'none'
      readingToggle?.click()
      await nextFrame()
      check(
        '仅预览态开关意为恢复分屏，点击后编辑区回来',
        readingOk && state.layout === 'split' && getComputedStyle(previewPaneElement).display !== 'none',
        `reading=${readingOk} 点击后 layout=${state.layout} icon=${
          readingToggle === undefined ? '无' : iconState(readingToggle)
        } title=${readingToggle?.title ?? '无'}`
      )

      /* 右上角让给了开关，查找条左移——两者的矩形不得相交 */
      await handleCommand('edit:find')
      await nextFrame()
      const finderRect = dom.finder.getBoundingClientRect()
      const toggleRect = visibleToggle()?.getBoundingClientRect()
      const overlaps =
        toggleRect !== undefined &&
        finderRect.left < toggleRect.right &&
        toggleRect.left < finderRect.right &&
        finderRect.top < toggleRect.bottom &&
        toggleRect.top < finderRect.bottom
      closeFinder()
      check(
        '查找条与显示区开关不互相遮挡',
        !overlaps,
        `finder=[${Math.round(finderRect.left)},${Math.round(finderRect.right)}] toggle=[${
          toggleRect === undefined ? '-' : Math.round(toggleRect.left)
        },${toggleRect === undefined ? '-' : Math.round(toggleRect.right)}]`
      )

      editor()!.setMarkdown('')
      setLayout(layoutBefore)
      setMode(modeBefore)
      await nextFrame()
    }

    /* --- 预览必须与编辑区同义（行内标记与转义） --- */
    /**
     * 用户报告："预览模式显示的不正确，把 /his-server/api/** 显示错了"。
     * 截图里同一段文字叠着两个独立缺陷：
     *  1. `.md-list-item` 是 flex（标记 + 内容两栏），而行内节点曾被直接挂到
     *     item 上——每个文本段/粗体/代码各自成为一个 flex 项并排铺开，
     *     含行内标记的列表项因此被拆成好几列；
     *  2. 反斜杠转义没被识别：`\*\*` 的两对转义星号被行内正则配成一段"粗体"，
     *     反斜杠还原样漏进显示，预览与编辑区就此分家。
     * 前五轮自检完全没有断言过预览的 DOM 结构——这正是它活到现在的理由。
     */
    {
      const layoutBefore = state.layout
      setLayout('split')
      editor()!.setMarkdown(
        '1. /api/\\*\\* 与 `code` 和 **粗体** 在同一行\n\n' +
          '转义 \\*斜体\\* 不应倾斜，`真代码` 仍是代码\n\n' +
          '**真粗体** 与 *真斜体*\n'
      )
      flushExpensiveRefresh()
      await nextFrame()

      const listItem = dom.preview.querySelector('.md-list-item')
      const listContent = listItem?.querySelector(':scope > .md-list-content') ?? null
      check(
        '列表项的行内内容包在单个容器里（不被 flex 拆成多列）',
        listItem !== null &&
          listItem.children.length === 2 &&
          listContent !== null &&
          listContent.querySelectorAll('code, strong').length === 2,
        listItem === null
          ? '未渲染出列表项'
          : `item 子节点 ${listItem.children.length} 个，内容容器行内元素 ${
              listContent?.querySelectorAll('code, strong').length ?? 0
            } 个`
      )

      check(
        '列表项文字与源码同义（转义星号是字面字符）',
        listContent?.textContent === '/api/** 与 code 和 粗体 在同一行',
        JSON.stringify(listContent?.textContent ?? null)
      )

      const paragraphs = dom.preview.querySelectorAll('.md-paragraph')
      const escaped = paragraphs[0]
      check(
        '反斜杠转义在预览中显示为字面字符、不产生强调',
        escaped !== undefined &&
          escaped.textContent === '转义 *斜体* 不应倾斜，真代码 仍是代码' &&
          escaped.querySelectorAll('em, strong').length === 0 &&
          escaped.querySelector('code')?.textContent === '真代码',
        escaped === undefined
          ? '未渲染出段落'
          : `${JSON.stringify(escaped.textContent)} em/strong=${escaped.querySelectorAll('em, strong').length}`
      )

      const real = paragraphs[1]
      check(
        '真粗体与真斜体仍正常渲染（转义屏蔽没有误伤）',
        real !== undefined &&
          real.querySelector('strong')?.textContent === '真粗体' &&
          real.querySelector('em')?.textContent === '真斜体',
        real === undefined
          ? '未渲染出段落'
          : `strong=${JSON.stringify(real.querySelector('strong')?.textContent ?? null)} em=${JSON.stringify(
              real.querySelector('em')?.textContent ?? null
            )}`
      )

      editor()!.setMarkdown('')
      setLayout(layoutBefore)
      await nextFrame()
    }

    /* --- 预览：表格 --- */
    /**
     * 预览器是手写逐行渲染器，此前完全不认表格：
     * 管道表会被当普通段落输出成一堆竖线（商店截图里就长这样）。
     *
     * 表格识别的关键不是"这一行有竖线"（普通段落也有），
     * 而是"下一行是分隔行"——因此下面分别验证正例与三种反例。
     */
    {
      const layoutBefore = state.layout
      setLayout('split')

      editor()!.setMarkdown(
        '| 名称 | 数量 | 备注 |\n' +
          '| :--- | :---: | ---: |\n' +
          '| `code` | 3 | **粗体** |\n' +
          '| a\\|b | 4 | 无 |\n'
      )
      flushExpensiveRefresh()
      await nextFrame()

      const tables = dom.preview.querySelectorAll('table.md-table')
      check('预览把管道表渲染为 table 元素', tables.length === 1, `${tables.length} 个表格`)

      const table = tables[0]
      const headers = table?.querySelectorAll<HTMLTableCellElement>('thead th') ?? []
      const cells = table?.querySelectorAll<HTMLTableCellElement>('tbody td') ?? []

      check(
        '预览表格列数与行数与源码一致',
        headers.length === 3 && cells.length === 6,
        `th=${headers.length} td=${cells.length}（期望 3 / 6）`
      )

      /**
       * 对齐由分隔行的冒号决定：`:---` 左、`:---:` 居中、`---:` 右。
       * 断言 inline style 而不是计算值——后者会受继承影响，无法区分"设置了"与"默认继承"。
       */
      check(
        '预览表格按分隔行应用对齐',
        headers[0]?.style.textAlign === 'left' &&
          headers[1]?.style.textAlign === 'center' &&
          headers[2]?.style.textAlign === 'right',
        `[${Array.from(headers)
          .map((cell) => cell.style.textAlign || '默认')
          .join(',')}] 第一个表头=${headers[0]?.outerHTML.slice(0, 80) ?? 'null'}`
      )

      // 单元格内的行内语法必须仍然生效，否则表格里的代码/加粗会变成裸文本
      check(
        '预览表格单元格内的行内语法生效',
        cells[0]?.querySelector('code')?.textContent === 'code' &&
          cells[2]?.querySelector('strong')?.textContent === '粗体',
        `code=${JSON.stringify(cells[0]?.querySelector('code')?.textContent ?? null)} strong=${JSON.stringify(
          cells[2]?.querySelector('strong')?.textContent ?? null
        )}`
      )

      /**
       * 转义竖线是单个单元格内的字面字符。
       *
       * 若按未转义的竖线切分，`a\|b` 会被切成两列，
       * 整行的列数就此错位（列数由表头决定，多出的被丢弃，内容会静默丢失）。
       */
      check(
        '预览表格的转义竖线保留在单元格内',
        cells[3]?.textContent === 'a|b' && cells.length === 6,
        JSON.stringify(cells[3]?.textContent ?? null)
      )

      /* --- 反例一：围栏内的表格样式文本不应被解析 --- */
      editor()!.setMarkdown('```text\n| a | b |\n| --- | --- |\n```\n')
      flushExpensiveRefresh()
      await nextFrame()

      check(
        '围栏代码块内的表格样式文本不被解析',
        dom.preview.querySelectorAll('table.md-table').length === 0 &&
          (dom.preview.querySelector('.md-code-block')?.textContent ?? '').includes('| --- |'),
        `表格数=${dom.preview.querySelectorAll('table.md-table').length}`
      )

      /* --- 反例二：含竖线但无分隔行的普通段落 --- */
      /**
       * 注意用空行分隔两段：markdown 里单个换行属于**同一段落**（软换行），
       * 若写成 `a | b\n没有分隔行`，编辑器会把它合并成一段，
       * 断言"2 个段落"就会失败——那是测试写错，不是功能错。
       */
      editor()!.setMarkdown('a | b\n\n普通段落\n')
      flushExpensiveRefresh()
      await nextFrame()

      check(
        '含竖线但无分隔行的段落不会被误判为表格',
        dom.preview.querySelectorAll('table.md-table').length === 0 &&
          dom.preview.querySelectorAll('.md-paragraph').length === 2,
        `表格数=${dom.preview.querySelectorAll('table.md-table').length} 段落数=${
          dom.preview.querySelectorAll('.md-paragraph').length
        }`
      )

      /* --- 反例三：分隔行列数与表头不一致时仍按表头列数渲染 --- */
      editor()!.setMarkdown('| a | b |\n| --- |\n| 1 | 2 | 3 |\n')
      flushExpensiveRefresh()
      await nextFrame()

      const ragged = dom.preview.querySelector('table.md-table')
      check(
        '表头与数据行列数不一致时按表头列数渲染',
        ragged !== null &&
          ragged.querySelectorAll('thead th').length === 2 &&
          ragged.querySelectorAll('tbody td').length === 2,
        `th=${ragged?.querySelectorAll('thead th').length ?? 0} td=${
          ragged?.querySelectorAll('tbody td').length ?? 0
        }`
      )

      /* --- 对齐必须能往返（此前的数据丢失） --- */
      /**
       * 此前 schema 的单元格**没有 align 属性**：解析阶段读出对齐却无处存放，
       * 序列化时只能硬编码 `---`。结果是含 `:---:` 的表格打开再保存就丢了对齐——
       * 属于静默数据丢失，而预览只是把这个问题暴露出来的地方。
       */
      editor()!.setMarkdown('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n')
      await nextFrame()

      const alignedMarkdown = editor()!.getMarkdown()
      const separatorLine = alignedMarkdown
        .split('\n')
        .find((line) => /^\s*\|?\s*:?-{1,}/.test(line) && line.includes('|'))

      const separatorCells = (separatorLine ?? '')
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())

      check(
        '表格对齐在 markdown 往返后保留',
        separatorCells.length === 3 &&
          separatorCells[0].startsWith(':') &&
          separatorCells[1].startsWith(':') &&
          separatorCells[1].endsWith(':') &&
          separatorCells[2].endsWith(':' ),
        `分隔行=${JSON.stringify(separatorLine ?? null)}`
      )

      editor()!.setMarkdown('')
      setLayout(layoutBefore)
      await nextFrame()
    }

    /* --- 查找框不得遮挡工具栏 --- */
    openFinder()
    await nextFrame()

    const toolbarRect = document.querySelector('.toolbar')?.getBoundingClientRect()
    const finderRect = dom.finder.getBoundingClientRect()

    check(
      '查找框位于工具栏下方（不遮挡）',
      toolbarRect !== undefined && finderRect.top >= toolbarRect.bottom - 1,
      `toolbar.bottom=${Math.round(toolbarRect?.bottom ?? -1)} finder.top=${Math.round(finderRect.top)}`
    )

    // 定位上下文必须是编辑区：它上方确实没有其它 UI
    check(
      '查找框锚定在编辑区内',
      dom.finder.offsetParent !== null &&
        dom.finder.offsetParent === dom.finder.closest('.editor-area'),
      `offsetParent=${(dom.finder.offsetParent as HTMLElement | null)?.className ?? 'null'}`
    )

    // 同样不得遮挡标签栏
    const tabBarRect = dom.tabBarHost.getBoundingClientRect()
    check(
      '查找框位于标签栏下方（不遮挡）',
      finderRect.top >= tabBarRect.bottom - 1,
      `tabBar.bottom=${Math.round(tabBarRect.bottom)} finder.top=${Math.round(finderRect.top)}`
    )
    closeFinder()

    /* --- 工具栏不得换行（高度随宽度漂移会让定位失效） --- */
    /**
     * 工具栏允许换行（尺寸稳定性不再是约束）。
     *
     * 原设计用 nowrap 保证高度恒定，是为了让查找框的固定 top 偏移不失效；
     * 查找框后来改为锚定编辑区内部，该约束随之消失。
     * 而 nowrap 的代价是窄窗口下按钮被裁掉且看不见滚动条。
     */
    const toolbarStyle = toolbarRect !== undefined ? getComputedStyle(document.querySelector('.toolbar') as Element) : null
    check(
      '工具栏允许换行（避免按钮被裁）',
      toolbarStyle?.flexWrap === 'wrap',
      `flex-wrap=${toolbarStyle?.flexWrap ?? 'unknown'}`
    )

    /* --- 未打开工作区时：路径栏隐藏，空状态承担提示 --- */
    check(
      '无工作区时路径栏隐藏',
      dom.workspacePath.hidden === true,
      `hidden=${dom.workspacePath.hidden}`
    )
    check(
      '文件树空状态给出可操作提示',
      dom.fileTreeHost.textContent?.includes(messages().panel.noWorkspaceHint) === true,
      dom.fileTreeHost.textContent?.trim().slice(0, 40) ?? '空'
    )
    check(
      '空状态与路径栏文案不重复',
      dom.workspacePath.textContent !== dom.fileTreeHost.textContent,
      `路径栏=${JSON.stringify(dom.workspacePath.textContent)}`
    )

    /* --- 表格行列按钮仅在表格内出现 --- */
    const tableEditor = editor()!
    tableEditor.setMarkdown('普通段落\n')
    cursorToStart(tableEditor)
    updateFormatButtons()

    const tableButtons = Array.from(
      dom.formatGroup.querySelectorAll<HTMLButtonElement>('[data-table]')
    )
    const hiddenOutsideTable = tableButtons
      .filter((button) => button.dataset.table !== 'insert')
      .every((button) => getComputedStyle(button).display === 'none')
    const insertAlwaysVisible =
      getComputedStyle(
        tableButtons.find((button) => button.dataset.table === 'insert') as Element
      ).display !== 'none'

    check(
      '非表格时行列按钮隐藏、插入按钮保留',
      hiddenOutsideTable && insertAlwaysVisible,
      `隐藏=${hiddenOutsideTable} 插入可见=${insertAlwaysVisible}`
    )

    // 先清空再插入：对已是表格的文档再执行"插入表格"会在段落上失败
    tableEditor.setMarkdown('')
    cursorToStart(tableEditor)
    tableEditor.execute(tableCommands.insert)
    await nextFrame()
    updateFormatButtons()

    const visibleInTable = Array.from(
      dom.formatGroup.querySelectorAll<HTMLButtonElement>('[data-table]')
    ).some((button) => button.dataset.table !== 'insert' && getComputedStyle(button).display !== 'none')

    check('表格内行列按钮出现', visibleInTable, `data-in-table=${dom.formatGroup.dataset.inTable}`)

    tableEditor.setMarkdown('')
  }

  /* ---------- 点击工作区搜索结果必须定位到正确文本 ---------- */
  {
    const workspace = api.smoke.tempDir

    if (workspace.length === 0) {
      check('搜索结果定位', false, '未注入临时目录')
    } else {
      /**
       * 构造一个"真实形态"的文档：标题、空行、行内代码、代码块、列表混合。
       *
       * 这类结构是行号错位的高发场景——ripgrep 报告的是**文件里的行号**，
       * 而编辑器里的位置要经过 markdown → 文档 → markdown 的规范化，
       * 两种行号不保证一致。用纯文本测试会掩盖这个问题。
       */
      const lines: string[] = []
      lines.push('# Docker 操作手册')
      lines.push('')
      for (let index = 0; index < 40; index += 1) {
        lines.push(`## 第 ${index} 节`)
        lines.push('')
        lines.push(`说明文字，含行内代码 \`inline-code-${index}\` 与 **粗体**。`)
        lines.push('')
        lines.push('```bash')
        lines.push(`docker exec -it container-${index} bash`)
        lines.push('```')
        lines.push('')
      }
      // 中段标记：测试"能放到视口上三分之一"的正常情况
      const middleIndex = Math.floor(lines.length / 2)
      lines.splice(middleIndex, 0, 'docker stats  # MIDDLE-LINE-MARKER')

      // 末尾标记：测试"目标靠近文档结尾"的钳制情况
      lines.push('## 查看所有容器')
      lines.push('')
      lines.push('```bash')
      lines.push('docker ps -a  # TARGET-LINE-MARKER')
      lines.push('```')

      const fileContent = `${lines.join('\n')}\n`
      const targetPath = `${workspace}/locate-target.md`
      await api.workspace.createFile(workspace, targetPath, fileContent)

      // 从主进程搜索拿到行号——与被点击时用的完全是同一个来源
      const searchResult = await api.workspace.search(workspace, 'TARGET-LINE-MARKER')
      const hit = searchResult.files
        .flatMap((file) => file.matches.map((match) => ({ file, match })))
        .find((entry) => entry.file.path === targetPath)

      check(
        '工作区搜索返回目标行号',
        hit !== undefined && hit.match.line > 0,
        hit ? `行 ${hit.match.line}` : '未命中'
      )

      if (hit) {
        await openAtLocation(targetPath, hit.match.line, hit.match.lineText)

        /** 读取当前选中的文本；用于区分"从未选中"与"选中后被重置"。 */
        const readSelection = (): string => {
          const instance = editor()
          if (!instance) return ''
          const { selection } = instance.state
          return instance.state.doc.textBetween(selection.from, selection.to, ' ')
        }

        const immediate = readSelection()
        await nextFrame()
        const afterFrame = readSelection()

        const selectedText = immediate.length > 0 ? immediate : afterFrame

        /**
         * 断言的是**选中文本的内容**，而不是"有没有选中"。
         *
         * 用户报告的现象正是"高亮出现在别处"——只断言"选中非空"
         * 会让错误位置的高亮也通过。
         */
        check(
          '点击搜索结果选中正确的文本',
          selectedText.includes('TARGET-LINE-MARKER'),
          `立即=${JSON.stringify(immediate.slice(0, 36))} 一帧后=${JSON.stringify(
            afterFrame.slice(0, 36)
          )}（搜索命中第 ${hit.match.line} 行）`
        )

        // 文件里那一行确实包含标记，用于排除"搜索本身返回错行"
        const fileLine = fileContent.split('\n')[hit.match.line - 1] ?? ''
        check(
          '搜索行号与文件内容一致',
          fileLine.includes('TARGET-LINE-MARKER'),
          JSON.stringify(fileLine.slice(0, 60))
        )

        /**
         * 行号映射的前提：编辑器的 markdown 与文件的行数不能差太多。
         *
         * 定位依赖"用文件行号去编辑器 markdown 里取同一行"这一近似。
         * markdown → 文档 → markdown 的规范化会改变行数（空行、标记风格），
         * 一旦漂移过大，取到的就是别的行，定位会静默指向错误位置。
         *
         * 这条断言守住这个前提，让漂移在超限时立刻暴露，
         * 而不是等用户报告"高亮跳到别处去了"。
         */
        const editorLineCount = Number(lastLocateDiagnostics?.editorLineCount ?? -1)
        check(
          '编辑器行号与文件行号量级一致（定位近似的前提）',
          editorLineCount > 0 && Math.abs(editorLineCount - hit.match.line) <= 8,
          `编辑器 ${editorLineCount} 行 / 文件第 ${hit.match.line} 行`
        )

        /**
         * 定位必须**看得见**。
         *
         * 断言装饰器而非选区：选区依赖焦点且会被 NodeView 重建 DOM 吞掉
         * （两个已修缺陷的成因），装饰器与这两者都无关，因此才是
         * "用户能不能看见"的可靠判据。
         */
        // 滚动在下一帧才稳定（浏览器自身会把选区滚入视口，需一帧后压过它）
        await nextFrame()
        await nextFrame()

        const locator = dom.wysiwygHost.querySelector('.search-locator')
        check(
          '点击搜索结果后目标处渲染定位标记',
          locator !== null,
          locator
            ? JSON.stringify((locator.textContent ?? '').slice(0, 40))
            : `未渲染 诊断=${JSON.stringify(lastLocateDiagnostics)}`
        )

        /**
         * 定位必须滚动到视口内。
         *
         * 断言里要区分两种情况，否则会写出错误的期望：
         *
         * - **目标在文档中段**：应落在视口上半部（调用方按"上方三分之一"定位），
         *   这样上下都有上下文可读。
         * - **目标靠近文档结尾**：即便滚到最底也无法把它抬到上三分之一，
         *   浏览器会把 scrollTop 钳制到最大值。此时"贴底"是**正确行为**，
         *   断言只要求它可见。
         *
         * 最初只写了"必须在上半部"，于是文档末尾的目标永远判失败——
         * 那是断言不了解边界情况，不是功能缺陷。
         */
        if (locator) {
          const locatorRect = locator.getBoundingClientRect()
          const scroller = findScrollContainerElement()
          const scrollerRect = scroller?.getBoundingClientRect()

          const visible =
            scrollerRect !== undefined &&
            locatorRect.top >= scrollerRect.top - 1 &&
            locatorRect.bottom <= scrollerRect.bottom + 1

          const atMaxScroll =
            scroller !== null &&
            scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1

          const upperHalf =
            scrollerRect !== undefined &&
            locatorRect.top < scrollerRect.top + (scrollerRect.bottom - scrollerRect.top) * 0.5

          check(
            '定位标记滚动到视口内（贴底仅允许发生在已滚到底时）',
            visible && (upperHalf || atMaxScroll),
            scrollerRect
              ? `标记 top=${Math.round(locatorRect.top)} 视口 ${Math.round(scrollerRect.top)}–${Math.round(
                  scrollerRect.bottom
                )} 可见=${visible} 上半部=${upperHalf} 已滚到底=${atMaxScroll}`
              : '未找到滚动容器'
          )
        }

        /* --- 中段目标应被放到视口上三分之一 --- */
        {
          const middleSearch = await api.workspace.search(workspace, 'MIDDLE-LINE-MARKER')
          const middleHit = middleSearch.files
            .flatMap((file) => file.matches.map((match) => ({ file, match })))
            .find((entry) => entry.file.path === targetPath)

          if (!middleHit) {
            check('中段目标可被搜索到', false, '未命中')
          } else {
            await openAtLocation(targetPath, middleHit.match.line, middleHit.match.lineText)
            await nextFrame()
            await nextFrame()

            const middleLocator = dom.wysiwygHost.querySelector('.search-locator')
            const middleRect = middleLocator?.getBoundingClientRect()
            const middleScroller = findScrollContainerElement()
            const middleScrollerRect = middleScroller?.getBoundingClientRect()

            const upperHalf =
              middleRect !== undefined &&
              middleScrollerRect !== undefined &&
              middleRect.top <
                middleScrollerRect.top + (middleScrollerRect.bottom - middleScrollerRect.top) * 0.5

            check(
              '中段目标被放到视口上半部',
              middleLocator !== null && upperHalf,
              middleScrollerRect && middleRect
                ? `标记 top=${Math.round(middleRect.top)} 视口中点=${Math.round(
                    middleScrollerRect.top + (middleScrollerRect.bottom - middleScrollerRect.top) / 2
                  )}`
                : '未渲染定位标记'
            )
          }
        }

        // 源码模式应精确到行首
        setMode('raw')
        await nextFrame()
        await openAtLocation(targetPath, hit.match.line, hit.match.lineText)
        await nextFrame()

        const rawLineIndex = dom.rawEditor.value
          .slice(0, dom.rawEditor.selectionStart)
          .split('\n').length
        const rawLine = dom.rawEditor.value.split('\n')[rawLineIndex - 1] ?? ''

        check(
          '源码模式定位到正确行',
          rawLine.includes('TARGET-LINE-MARKER'),
          `第 ${rawLineIndex} 行: ${JSON.stringify(rawLine.slice(0, 50))}`
        )
        setMode('wysiwyg')
      }
    }
  }

  /* ---------- L2：多标签 ---------- */
  store.createUntitled()
  store.createUntitled()
  check('多标签创建', store.list().length >= 3, `${store.list().length} 个标签`)

  const titles = store.list().map((item) => item.title)
  check('未命名标题不重复', new Set(titles).size === titles.length, titles.join(' / '))

  const firstId = store.list()[0].id
  store.activate(firstId)
  check('切换标签', store.active?.id === firstId)

  // 每个标签独立内容：切走再切回不应互相污染
  const documentA = normalize('# 标签 A\n')
  editor()!.setMarkdown(documentA)
  store.commitActive(documentA)

  const secondId = store.list()[1].id
  store.activate(secondId)
  const documentB = normalize('# 标签 B\n')
  editor()!.setMarkdown(documentB)
  store.commitActive(documentB)

  store.activate(firstId)
  check('标签内容互不污染', editor()!.getMarkdown() === documentA, JSON.stringify(editor()!.getMarkdown()))

  store.activate(secondId)
  check('第二标签内容保持', editor()!.getMarkdown() === documentB, JSON.stringify(editor()!.getMarkdown()))

  /* 启动时先给一张空白未命名标签；用户随后打开文件时若再新建标签，
     就会留下一个永远没人用的"未命名"。因此打开应当就地替换那张白纸。 */
  const tabsBeforeOpen = store.list().length
  const blankSession = store.createUntitled()
  const replaced = store.createFromDocument(`${api.smoke.tempDir}/replace-blank.md`, {
    content: '# 替换白纸\n',
    eol: 'lf',
    encoding: 'utf8',
    byteLength: 13,
    encodingGuessed: false
  })
  check(
    '打开文档替换空白的未命名标签',
    replaced.id === blankSession.id &&
      replaced.filePath === `${api.smoke.tempDir}/replace-blank.md` &&
      store.list().length === tabsBeforeOpen + 1,
    `标签 ${tabsBeforeOpen} → ${store.list().length}（不替换会是 ${tabsBeforeOpen + 2}）`
  )

  // 写过内容的未命名标签必须留下：替换的底线是不吃用户已经写下的东西
  const tabsBeforeKeep = store.list().length
  const writtenSession = store.createUntitled()
  // 模拟"用户写过字"：内容要真的在内核里，否则切走时内核会序列化回空内容
  editor()!.setMarkdown('用户已经写下的内容')
  store.commitActive('用户已经写下的内容')
  const kept = store.createFromDocument(`${api.smoke.tempDir}/keep-written.md`, {
    content: '# 新标签\n',
    eol: 'lf',
    encoding: 'utf8',
    byteLength: 10,
    encodingGuessed: false
  })
  check(
    '有内容的未命名标签不被替换',
    kept.id !== writtenSession.id &&
      writtenSession.filePath === null &&
      writtenSession.markdown === '用户已经写下的内容' &&
      store.list().length === tabsBeforeKeep + 2,
    `标签 ${tabsBeforeKeep} → ${store.list().length}`
  )
  store.close(kept.id)
  store.close(writtenSession.id)
  store.close(replaced.id)
  store.activate(secondId)

  /* ---------- L2：脏标记 ---------- */
  // 用当前活动标签自身的基线做对比，避免依赖"哪个标签是活动的"这种脆弱假设
  const dirtyTarget = store.active!
  const baseLength = dirtyTarget.markdown.length
  store.commitActive(`${dirtyTarget.markdown}新增内容`)
  check(
    '提交内容后变脏',
    store.isDirty(dirtyTarget),
    `${baseLength} → ${dirtyTarget.markdown.length} 字符, dirty=${store.isDirty(dirtyTarget)}`
  )

  // 保存后应恢复干净：这是"关闭标签时不误报未保存"的前提
  try {
    await api.file.write({
      filePath: `${api.smoke.tempDir}/dirty-check.md`,
      content: dirtyTarget.markdown,
      eol: 'lf',
      encoding: 'utf8'
    })
    store.markSaved(dirtyTarget.id, dirtyTarget.markdown, 'utf8')
    check('保存后脏标记清除', !store.isDirty(dirtyTarget), `dirty=${store.isDirty(dirtyTarget)}`)
  } catch (error) {
    check('保存后脏标记清除', false, describeError(error))
  }

  /* ---------- L2：大纲 ---------- */
  const outlineDocument = normalize('# 一级\n\n正文\n\n## 二级\n\n### 三级\n\n## 另一个二级\n')
  store.activate(firstId)
  editor()!.setMarkdown(outlineDocument)
  store.commitActive(outlineDocument)
  const outline = buildOutline(outlineDocument)
  check(
    '大纲提取标题层级',
    outline.length === 4 &&
      outline[0].level === 1 &&
      outline[1].level === 2 &&
      outline[2].level === 3 &&
      outline[3].level === 2,
    outline.map((item) => `h${item.level}:${item.text}`).join(' | ')
  )
  check(
    '大纲可定位到文档位置',
    outline.every((item) => item.position > 0 && item.position <= editor()!.state.doc.content.size),
    outline.map((item) => item.position).join(',')
  )
  check(
    '大纲跳过代码块内的井号',
    buildOutline('正文\n\n```\n# 不是标题\n```\n').length === 0
  )

  /* ---------- L2：文档内查找（跨模式） ---------- */
  store.activate(firstId)
  editor()!.setMarkdown('# 查找目标\n\n正文包含 查找目标 两次：查找目标\n')
  const findResult = findTextMatches(editor()!.state.doc, '查找目标')
  check('所见即所得查找命中', findResult.matches.length === 3, `${findResult.matches.length} 处`)
  check(
    '查找位置在文档范围内',
    findResult.matches.every(
      (match) => match.from >= 0 && match.to <= editor()!.state.doc.content.size && match.from < match.to
    ),
    findResult.matches.map((match) => `${match.from}-${match.to}`).join(',')
  )
  check('查找可选中命中区间', findResult.matches.length > 0 && selectRange(editor()!, findResult.matches[0]))

  /* ---------- L2：工作区文件操作 ---------- */
  const workspace = api.smoke.tempDir
  if (workspace.length === 0) {
    check('工作区临时目录可用', false, '主进程未注入 ELECTRON_SMOKE_TMPDIR')
  } else {
    try {
      await api.workspace.createDirectory(workspace, `${workspace}/notes`)
      await api.workspace.createFile(workspace, `${workspace}/notes/alpha.md`, '# Alpha\n\n内容关键字\n')
      await api.workspace.createFile(workspace, `${workspace}/notes/beta.md`, '# Beta\n\n另一个关键字\n')
      await api.workspace.createFile(workspace, `${workspace}/readme.txt`, '纯文本 readme\n')
      await api.workspace.createFile(workspace, `${workspace}/config.json`, '{ "notText": true }\n')

      const tree = await api.workspace.readTree(workspace)
      const notes = findNode(tree.root, 'notes')
      check(
        '工作区目录树读取',
        notes?.isDirectory === true && (notes.children?.length ?? 0) === 2,
        `${notes?.children?.map((child) => child.name).join(',') ?? '未找到 notes'}`
      )
      check(
        '树中标记可打开的文本文档',
        findNode(tree.root, 'alpha.md')?.isText === true &&
          findNode(tree.root, 'readme.txt')?.isText === true &&
          findNode(tree.root, 'config.json')?.isText === false,
        [
          `alpha.md=${findNode(tree.root, 'alpha.md')?.isText}`,
          `readme.txt=${findNode(tree.root, 'readme.txt')?.isText}`,
          `config.json=${findNode(tree.root, 'config.json')?.isText}`
        ].join(' ')
      )
      check(
        '文档类型判定覆盖大小写与无扩展名',
        isDocumentPath('notes.MD') &&
          isDocumentPath('dir/README.TXT') &&
          !isDocumentPath('photo.png') &&
          !isDocumentPath('LICENSE') &&
          isPlainTextPath('a.txt') &&
          !isPlainTextPath('a.md') &&
          !isPlainTextPath(null)
      )

      /* --- 新建输入行必须落在目标文件夹内部 --- */
      /**
       * 覆盖用户报告："点击在此新建文件，新建文件没有出现在当前文件夹的最下面"。
       *
       * 原先待处理输入行被追加到**整棵树的末尾**，给中段文件夹新建时
       * 输入行跑到列表最下方（常常还在视口外），看起来像"点了没反应"。
       *
       * 断言的是**插入位置本身**（DOM 顺序 + 缩进深度），
       * 因为"在新文件出现在文件夹里"这件事发生在提交之后，
       * 而用户点完按钮、还没输入名字时就已经看不到输入行了。
       */
      {
        await setWorkspace(workspace)
        await nextFrame()

        const list = dom.fileTreeHost.querySelector('.tree-list')
        check('文件树已渲染', list !== null, list ? '存在' : '未找到')

        /**
         * 展开 notes 并点击它的"在此新建文件"。
         *
         * 直接按标题找按钮，而不是按位置取第几个——位置会随树结构变化。
         */
        const findRowByName = (name: string): HTMLElement | null => {
          const labels = Array.from(
            dom.fileTreeHost.querySelectorAll<HTMLElement>('.tree-label')
          )
          return (
            labels
              .find((label) => label.querySelector('.tree-label__name')?.textContent === name)
              ?.closest('.tree-row') ?? null
          )
        }

        const notesRow = findRowByName('notes')
        check('文件树中可定位 notes 文件夹', notesRow !== null, notesRow ? '存在' : '未找到')

        if (notesRow && list) {
          // 展开文件夹（点击标签）
          notesRow.querySelector<HTMLElement>('.tree-label')?.click()
          await nextFrame()

          const expandedRow = findRowByName('notes')
          const createButton = expandedRow
            ? Array.from(expandedRow.querySelectorAll<HTMLButtonElement>('.tree-action')).find(
                (button) => button.title === '在此新建文件'
              )
            : undefined

          check('文件夹行提供新建文件入口', createButton !== undefined, createButton?.title ?? '未找到')

          if (createButton) {
            createButton.click()
            await nextFrame()

            const rows = Array.from(list.querySelectorAll<HTMLElement>('.tree-row'))
            const pendingIndex = rows.findIndex((row) =>
              row.classList.contains('tree-row--pending')
            )
            const notesIndex = rows.findIndex(
              (row) =>
                row.querySelector('.tree-label__name')?.textContent === 'notes'
            )
            const betaIndex = rows.findIndex(
              (row) =>
                row.querySelector('.tree-label__name')?.textContent === 'beta.md'
            )
            const readmeIndex = rows.findIndex(
              (row) =>
                row.querySelector('.tree-label__name')?.textContent === 'readme.txt'
            )

            check(
              '新建输入行渲染出来了',
              pendingIndex >= 0,
              `pending 行下标=${pendingIndex}`
            )

            /**
             * 关键断言：输入行必须位于 notes 的**子项之后**、且在
             * 根级下一项（readme.txt）**之前**。
             *
             * 这就是"在当前文件夹的最下面"的可检验定义。
             */
            check(
              '新建输入行位于目标文件夹的子项之后',
              pendingIndex > notesIndex && betaIndex >= 0 && pendingIndex > betaIndex,
              `notes=${notesIndex} beta=${betaIndex} pending=${pendingIndex}`
            )
            check(
              '新建输入行位于根级下一项之前（没跑到整棵树末尾）',
              readmeIndex < 0 || pendingIndex < readmeIndex,
              `pending=${pendingIndex} readme=${readmeIndex}`
            )

            // 缩进必须比文件夹本身深一级，否则看不出归属
            const pendingRow = rows[pendingIndex]
            const pendingDepth = pendingRow
              ? Number(pendingRow.style.getPropertyValue('--tree-depth'))
              : -1
            const notesDepth = notesRow.style.getPropertyValue('--tree-depth')
            const notesDepthNumber = notesDepth === '' ? 0 : Number(notesDepth)

            check(
              '新建输入行缩进比文件夹深一级',
              pendingDepth === notesDepthNumber + 1,
              `文件夹深度=${notesDepthNumber} 输入行深度=${pendingDepth}`
            )

            // 收起：避免悬空输入行影响后续断言
            findRowByName('notes')?.querySelector<HTMLElement>('.tree-label')?.click()
            await nextFrame()
          }
        }
      }

      const searchResult = await api.workspace.search(workspace, '关键字')
      check('工作区内容搜索', searchResult.totalMatches === 2, `${searchResult.totalMatches} 处`)
      check(
        '搜索结果带行号与片段',
        searchResult.files.every(
          (file) => file.matches.every((match) => match.line > 0 && match.snippet.length > 0)
        ),
        searchResult.files.map((file) => `${file.relativePath}:${file.matches.length}`).join(' ')
      )

      const textSearch = await api.workspace.search(workspace, '纯文本')
      check(
        '搜索覆盖 .txt 文件',
        textSearch.totalMatches === 1 && textSearch.files[0]?.relativePath === 'readme.txt',
        `${textSearch.totalMatches} 处：${textSearch.files.map((file) => file.relativePath).join(',')}`
      )

      const caseResult = await api.workspace.search(workspace, 'ALPHA', true)
      check('搜索区分大小写可控', caseResult.totalMatches === 0, `${caseResult.totalMatches} 处`)

      await api.workspace.rename(workspace, `${workspace}/notes/beta.md`, `${workspace}/notes/gamma.md`)
      const renamed = await api.workspace.readTree(workspace)
      check(
        '文件重命名',
        findNode(renamed.root, 'gamma.md') !== undefined && findNode(renamed.root, 'beta.md') === undefined
      )

      await api.workspace.remove(workspace, `${workspace}/notes/gamma.md`)
      const removed = await api.workspace.readTree(workspace)
      check('文件删除', findNode(removed.root, 'gamma.md') === undefined)

      /* 越界防护：路径不在工作区内必须被拒绝——这是把文件能力交给渲染层的底线 */
      let rejected = false
      try {
        await api.workspace.remove(workspace, '/tmp/typeflow-should-not-exist.md')
      } catch {
        rejected = true
      }
      check('工作区边界防护', rejected)
    } catch (error) {
      check('工作区文件操作', false, describeError(error))
    }
  }

  /* ---------- L2：纯文本（.txt）会话 ---------- */
  /**
   * 纯文本不能走所见即所得内核：内核保存时按 Markdown 规范化内容
   * （`*`→`\*`、`a[0]`→`a\[0\]`、单换行并进同一段、`1)`→`1.`），
   * 对 Markdown 是"整理源码"，对 .txt 就是改坏用户的文件。
   * 因此这类会话钉在源码模式，且保存内容必须与磁盘逐字一致。
   */
  if (workspace.length > 0) {
    const previousSessionId = store.active?.id ?? null
    try {
      const textPath = `${workspace}/plain.txt`
      // 填充行把文本撑过一屏：光标/滚动位置是否回文首才测得出来
      const textContent = `价格 3 * 4 = 12\n1) 第一条\n    缩进四空格\n${'填充行，用于把文本撑过一屏\n'.repeat(60)}`
      await api.file.write({ filePath: textPath, content: textContent, eol: 'lf', encoding: 'utf8' })

      await openDocumentByPath(textPath)
      const textSession = store.active
      check(
        '纯文本文档以源码模式打开',
        state.mode === 'raw' && dom.rawEditor.value === textContent,
        `mode=${state.mode} value=${JSON.stringify(dom.rawEditor.value.slice(0, 24))}…`
      )
      check(
        '打开后光标与滚动停在文首',
        dom.rawEditor.selectionStart === 0 && dom.rawEditor.scrollTop === 0,
        `caret=${dom.rawEditor.selectionStart} scrollTop=${dom.rawEditor.scrollTop}`
      )

      setMode('wysiwyg')
      check('纯文本文档拒绝切到所见即所得', state.mode === 'raw', `mode=${state.mode}`)

      const edited = `${textContent}新增一行 * 号\n`
      dom.rawEditor.value = edited
      dom.rawEditor.dispatchEvent(new Event('input'))
      if (textSession) await saveSession(textSession, false)
      const textReadBack = await api.file.read(textPath, false)
      check(
        '纯文本保存逐字无损',
        textReadBack.content === edited,
        `${textReadBack.content.length} 字符 vs 期望 ${edited.length} 字符`
      )

      /* 切到别的标签再切回来：既不能串文档，也不能被 Markdown 序列化结果覆盖 */
      const markdownSession = store
        .list()
        .find((item) => item.id !== textSession?.id && !isPlainTextPath(item.filePath))
      if (markdownSession && textSession) {
        const markdownBefore = markdownSession.markdown
        store.activate(markdownSession.id)
        afterSessionActivated(markdownSession.filePath)
        check(
          '切到 Markdown 文档恢复偏好模式',
          state.mode === state.preferredMode && markdownSession.markdown === markdownBefore,
          `mode=${state.mode} preferred=${state.preferredMode}`
        )

        store.activate(textSession.id)
        afterSessionActivated(textSession.filePath)
        check(
          '源码模式切标签不串文档',
          state.mode === 'raw' && dom.rawEditor.value === edited && textSession.markdown === edited,
          `mode=${state.mode} caret=${dom.rawEditor.selectionStart} value=${JSON.stringify(dom.rawEditor.value.slice(0, 24))}…`
        )
      } else {
        check('源码模式切标签不串文档', false, '缺少可切换的 Markdown 会话')
      }
    } catch (error) {
      check('纯文本文档会话', false, describeError(error))
    } finally {
      /* 复原：关掉 .txt 标签并回到原会话，后续断言依赖所见即所得模式 */
      const textSession = store.list().find((item) => isPlainTextPath(item.filePath))
      if (textSession) store.close(textSession.id)
      if (previousSessionId) {
        store.activate(previousSessionId)
        afterSessionActivated(store.active?.filePath ?? null)
      }
    }
  }

  /* ---------- 只读查看器：PDF / HTML / 图片 ---------- */
  /**
   * 这三类对象的共同点是"只能看"。因此断言分两半：
   *  - 渲染确实成功（图片解码、PDF 栅格化、HTML 净化后仍可读）
   *  - 编辑面被彻底关掉。保存路径一旦对查看会话放行，写回的就是空内容——
   *    那是数据损坏，比"显示不出来"严重得多，必须显式验证而不是靠推论
   */
  if (workspace.length > 0) {
    const previousSessionId = store.active?.id ?? null
    const layoutBefore = state.layout
    const imagePath = `${workspace}/viewer-sample.png`
    const htmlPath = `${workspace}/viewer-sample.html`
    const pdfPath = `${workspace}/export-test.pdf`
    const smokeFlag = window as unknown as { smokePwned?: number }

    try {
      /* 图片：现造一张真 PNG。假 magic 字节能验证写盘，验证不了解码路径 */
      const canvas = document.createElement('canvas')
      canvas.width = 24
      canvas.height = 16
      canvas.getContext('2d')?.fillRect(0, 0, 24, 16)
      const dataUrl = canvas.toDataURL('image/png')
      const pngBytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (byte) =>
        byte.charCodeAt(0)
      )
      await api.assets.write({ filePath: imagePath, bytes: pngBytes.buffer as ArrayBuffer })

      // 查找条锚在编辑区内部，切到查看会话时必须自己关掉
      openFinder()
      const finderOpened = dom.finder.hidden === false

      await openViewerByPath(imagePath)
      const imageDecoded = await waitFor(
        () => dom.viewerHost.querySelector<HTMLImageElement>('.viewer-image img')?.naturalWidth === 24
      )
      check('图片以只读查看器打开', imageDecoded, `${pngBytes.byteLength} 字节 PNG`)
      check(
        '切到查看会话时查找条自动关闭',
        !finderOpened || dom.finder.hidden === true,
        `打开=${finderOpened} hidden=${dom.finder.hidden}`
      )
      check(
        '查看会话是独立的一类',
        store.active?.kind === 'viewer' && store.active?.viewerKind === 'image',
        `kind=${store.active?.kind} viewerKind=${store.active?.viewerKind}`
      )
      check(
        '查看表面接管编辑区',
        dom.editorArea.dataset.view === 'viewer' && dom.viewerHost.hidden === false
      )
      check('查看会话不挂内核', editor() === null)
      check('查看会话不是脏的', store.active !== null && !store.isDirty(store.active))
      check(
        '状态栏给出尺寸与只读说明',
        (dom.statusStats.textContent ?? '').includes('24 × 16') &&
          (dom.statusStats.textContent ?? '').includes(messages().status.viewerReadOnly),
        dom.statusStats.textContent ?? ''
      )
      check(
        '编码指示对二进制对象留空',
        dom.statusEncoding.textContent === '—' && dom.statusEol.textContent === '—',
        `${dom.statusEncoding.textContent}/${dom.statusEol.textContent}`
      )

      /* 只读约束：模式、命令、工具栏、保存四条路径都要挡住 */
      const imageBytesBefore = await api.assets.read(imagePath)
      setMode('wysiwyg')
      check(
        '查看会话拒绝切换编辑模式',
        dom.editorArea.dataset.view === 'viewer' && editor() === null,
        `view=${dom.editorArea.dataset.view}`
      )
      setLayout('preview')
      check('查看会话拒绝切换布局', dom.editorArea.dataset.view === 'viewer')

      await handleCommand('file:save')
      await handleCommand('view:toggle-mode')
      await handleCommand('view:toggle-preview')
      await handleCommand('edit:undo')
      const imageBytesAfter = await api.assets.read(imagePath)
      check(
        '查看会话下保存命令不改动文件',
        (imageBytesAfter?.byteLength ?? -1) === (imageBytesBefore?.byteLength ?? -2),
        `${imageBytesBefore?.byteLength ?? 0} → ${imageBytesAfter?.byteLength ?? 0} 字节`
      )
      check(
        '命令拦截后仍是查看表面',
        dom.editorArea.dataset.view === 'viewer' && editor() === null
      )

      const viewerSessionObject = store.active
      const saveReturned = viewerSessionObject ? await saveSession(viewerSessionObject, false) : true
      check('saveSession 对查看会话直接返回失败', saveReturned === false)

      const disabledActions = ['toggle-mode', 'toggle-preview', 'save', 'export-html', 'export-pdf']
      const enabledActions = disabledActions.filter((action) =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`)
        ).some((button) => button.disabled !== true)
      )
      check(
        '查看会话禁用无作用对象的按钮',
        enabledActions.length === 0,
        enabledActions.length === 0 ? disabledActions.join(',') : `仍可点击 ${enabledActions.join(',')}`
      )
      check(
        '格式按钮组对查看会话禁用',
        dom.formatGroup.dataset.disabled === 'true' &&
          Array.from(dom.formatGroup.querySelectorAll('button')).every((button) => button.hasAttribute('disabled'))
      )

      /* HTML：把该拦的东西一次性都放进去 */
      const dirtyHtml =
        '<!DOCTYPE html><html><head>' +
        '<style>p{color:rgb(1,2,3)}</style>' +
        '<script>window.smokePwned=1</script>' +
        '</head><body>' +
        '<p id="keep">正文保留</p>' +
        '<div>外层<script>window.smokePwned=2</script>内层文本</div>' +
        '<img src="viewer-sample.png" onerror="window.smokePwned=3" alt="图">' +
        '<a href="javascript:window.smokePwned=4">危险链接</a>' +
        '<a href="https://example.com/">外链</a>' +
        '<iframe src="https://example.com/"></iframe>' +
        '<p style="color:red;background:url(javascript:window.smokePwned=5)">样式</p>' +
        '</body></html>'
      await api.file.write({ filePath: htmlPath, content: dirtyHtml, eol: 'lf', encoding: 'utf8' })

      await openViewerByPath(htmlPath)
      const shadow = dom.viewerHost.querySelector<HTMLDivElement>('.viewer-html')?.shadowRoot ?? null
      check('HTML 挂进 shadow root 隔离', shadow !== null)
      check(
        '脚本整棵丢弃且从未执行',
        shadow?.querySelector('script') === null && smokeFlag.smokePwned === undefined,
        `smokePwned=${String(smokeFlag.smokePwned)}`
      )
      check('iframe 被丢弃', shadow?.querySelector('iframe') === null)
      check(
        '事件属性被剥离',
        shadow?.querySelector('img')?.hasAttribute('onerror') === false &&
          smokeFlag.smokePwned === undefined
      )
      const anchors = Array.from(shadow?.querySelectorAll('a') ?? [])
      check(
        'javascript: 链接被拦下、https 链接保留',
        anchors.some((anchor) => anchor.getAttribute('href') === 'https://example.com/') &&
          anchors.every((anchor) => !/^\s*javascript:/i.test(anchor.getAttribute('href') ?? '')),
        anchors.map((anchor) => anchor.getAttribute('href') ?? '(无)').join(' ')
      )
      const styledParagraph = Array.from(shadow?.querySelectorAll('p') ?? []).find((paragraph) =>
        paragraph.hasAttribute('style')
      )
      check(
        '含 javascript: 的样式值被整体拒绝',
        styledParagraph === undefined ||
          !/javascript:/i.test(styledParagraph.getAttribute('style') ?? ''),
        styledParagraph?.getAttribute('style') ?? '(无 style 元素)'
      )
      check(
        '正文与非白名单元素的子节点都保留',
        shadow?.querySelector('#keep')?.textContent === '正文保留' &&
          (shadow?.textContent ?? '').includes('内层文本'),
        (shadow?.textContent ?? '').slice(0, 40)
      )
      check(
        '文档自带样式进入 shadow root',
        (shadow?.querySelector('style')?.textContent ?? '').includes('rgb(1, 2, 3)') ||
          (shadow?.querySelector('style')?.textContent ?? '').includes('rgb(1,2,3)'),
        (shadow?.querySelector('style')?.textContent ?? '').slice(0, 60)
      )
      const resolvedImageSource = shadow?.querySelector('img')?.getAttribute('src') ?? ''
      check(
        '相对图片按 file:// 解析',
        resolvedImageSource.startsWith('file://') && resolvedImageSource.endsWith('viewer-sample.png'),
        resolvedImageSource
      )
      check(
        '净化结果给出提示',
        (dom.statusMessage.textContent ?? '').includes(messages().status.viewerSanitized),
        dom.statusMessage.textContent ?? ''
      )

      /* pdf.js 资源回源通道：cMap 缺失的后果是使用预定义编码的中文 PDF 整页失败，
         而打包产物的资源根目录与开发期不同，必须真的读一次才算验证过 */
      const cMapBytes = await api.viewer.readPdfResource('cmaps/UniGB-UCS2-H.bcmap')
      const fontBytes = await api.viewer.readPdfResource('standard_fonts/FoxitFixed.pfb')
      check(
        'PDF 资源通道能回源 cMap 与标准字体',
        (cMapBytes?.byteLength ?? 0) > 0 && (fontBytes?.byteLength ?? 0) > 0,
        `cMap=${cMapBytes?.byteLength ?? 0} 字节 font=${fontBytes?.byteLength ?? 0} 字节`
      )
      const escaped = await api.viewer.readPdfResource('../package.json')
      const outside = await api.viewer.readPdfResource('cmaps/../../main/index.js')
      const unlisted = await api.viewer.readPdfResource('wasm/qcms_bg.wasm')
      check(
        'PDF 资源通道只放行白名单目录内的单段文件名',
        escaped === null && outside === null && unlisted === null,
        `../=${escaped === null} 跨段=${outside === null} 非白名单目录=${unlisted === null}`
      )

      /* useWasm: false 时 JPEG2000 / JBIG2 改走纯 JS 解码器，pdf.js 用动态 import
         从 wasmUrl 取它们。这条断言真的 import 一次：URL 拼错、目录没随包分发、
         CSP 挡住 file:// 脚本，三种情况都会在这里现形，而不是等用户打开扫描件 */
      const wasmUrl = await api.viewer.pdfWasmUrl()
      const decoderType = async (name: string): Promise<string> => {
        try {
          const mod = (await import(/* @vite-ignore */ `${wasmUrl}${name}`)) as {
            default?: unknown
          }
          return typeof mod.default
        } catch (error) {
          return describeError(error)
        }
      }
      const openjpegType = await decoderType('openjpeg_nowasm_fallback.js')
      const jbig2Type = await decoderType('jbig2_nowasm_fallback.js')
      check(
        'PDF 纯 JS 解码器可加载（JPEG2000 / JBIG2 不依赖 wasm）',
        wasmUrl.endsWith('/wasm/') && openjpegType === 'function' && jbig2Type === 'function',
        `openjpeg=${openjpegType} jbig2=${jbig2Type} url=${wasmUrl}`
      )

      /* PDF：L4 导出段已经生成了一份含中文与公式的真 PDF，直接拿来用 */
      const pdfBytes = await api.assets.read(pdfPath)
      if (!pdfBytes) {
        check('PDF 以只读查看器打开', false, `读不到 ${pdfPath}`)
      } else {
        await openViewerByPath(pdfPath)
        const placeholdersReady = await waitFor(
          () => dom.viewerHost.querySelectorAll('.viewer-pdf__page').length > 0,
          300
        )
        const pageCount = dom.viewerHost.querySelectorAll('.viewer-pdf__page').length
        check(
          'PDF 逐页铺出占位块',
          placeholdersReady && pageCount > 0,
          `${pageCount} 页 / ${dom.statusMessage.textContent ?? ''}`
        )

        const firstCanvas = await waitFor(
          () =>
            (dom.viewerHost.querySelector<HTMLCanvasElement>('.viewer-pdf__page canvas')?.width ?? 0) >
            0,
            600
        )
        const painted = dom.viewerHost.querySelector<HTMLCanvasElement>('.viewer-pdf__page canvas')
        check(
          'PDF 首页栅格化到 canvas',
          firstCanvas && painted !== null && painted !== undefined,
          `${painted?.width ?? 0}×${painted?.height ?? 0}`
        )
        check(
          '状态栏给出页数',
          (dom.statusStats.textContent ?? '').includes(messages().status.viewerPages),
          dom.statusStats.textContent ?? ''
        )
        check('PDF 页面不落在可编辑内核里', editor() === null)
      }

      /* 目录树与搜索范围 */
      const viewerTree = await api.workspace.readTree(workspace)
      const flagOf = (name: string): string => {
        const node = findNode(viewerTree.root, name)
        return `${name}=${node ? `${node.isText}/${node.isViewable}` : '缺失'}`
      }
      check(
        '树中区分可编辑文档与只读对象',
        findNode(viewerTree.root, 'export-test.pdf')?.isViewable === true &&
        findNode(viewerTree.root, 'export-test.pdf')?.isText === false &&
        findNode(viewerTree.root, 'viewer-sample.html')?.isViewable === true &&
        findNode(viewerTree.root, 'viewer-sample.png')?.isViewable === true &&
        findNode(viewerTree.root, 'readme.txt')?.isViewable === false &&
        findNode(viewerTree.root, 'config.json')?.isViewable === false,
        [
          flagOf('export-test.pdf'),
          flagOf('viewer-sample.html'),
          flagOf('viewer-sample.png'),
          flagOf('readme.txt'),
          flagOf('config.json')
        ].join(' ')
      )

      const htmlSearch = await api.workspace.search(workspace, '正文保留')
      check(
        '全文搜索不覆盖只读对象',
        htmlSearch.totalMatches === 0,
        `${htmlSearch.totalMatches} 处（只读对象无处可跳，纳入只会给出死链接）`
      )

      check(
        '类型判定覆盖三类只读对象',
        viewerKindOf('a/b.PDF') === 'pdf' &&
          viewerKindOf('a/b.HTM') === 'html' &&
          viewerKindOf('a/b.jpeg') === 'image' &&
          viewerKindOf('a/b.svg') === 'image' &&
          viewerKindOf('a/b.md') === null &&
          isOpenablePath('a/b.md') &&
          isOpenablePath('a/b.pdf') &&
          !isOpenablePath('a/b.json')
      )
    } catch (error) {
      check('只读查看器', false, describeError(error))
    } finally {
      /* 复原：关掉所有查看标签并回到原会话，后续断言依赖可编辑表面 */
      for (const session of [...store.list()]) {
        if (session.kind === 'viewer') store.close(session.id)
      }
      if (previousSessionId) {
        store.activate(previousSessionId)
        afterSessionActivated(store.active?.filePath ?? null)
      }
      setLayout(layoutBefore)
    }
  }

  /* ---------- L2：侧边栏与面板 ---------- */
  setSidebarVisible(false)
  check('侧边栏可隐藏', dom.workbench.dataset.sidebar === 'hidden')
  setSidebarVisible(true)
  check('侧边栏可显示', dom.workbench.dataset.sidebar === 'visible')

  setSidePanel('outline')
  check('面板切换到大纲', dom.sidebar.querySelector<HTMLElement>('#panel-outline')?.hidden === false)
  setSidePanel('files')
  check('面板切换回文件', dom.sidebar.querySelector<HTMLElement>('#panel-files')?.hidden === false)

  /* ---------- L0 数据安全回归 ---------- */
  try {
    const diskDocument = normalize('# L2 落盘\n\n中文 + 🚀 + `code`\n\n- 项一\n')
    editor()!.setMarkdown(diskDocument)
    const written = await api.file.write({
      filePath: `${api.smoke.tempDir}/l2-roundtrip.md`,
      content: editor()!.getMarkdown(),
      eol: 'lf',
      encoding: 'utf8'
    })
    const readBack = await api.file.read(`${api.smoke.tempDir}/l2-roundtrip.md`, false)
    check(
      '落盘逐字无损（回归）',
      readBack.content === diskDocument,
      `${written.byteLength} 字节 / ${readBack.content.length} 字符`
    )
  } catch (error) {
    check('落盘逐字无损（回归）', false, describeError(error))
  }

  check('关闭前保存回执通道可用', typeof api.window.notifyCloseAfterSave === 'function')

  const failures = results.filter((result) => !result.ok).length
  console.log(`[typeflow:smoke] 断言 ${results.length} 项，失败 ${failures} 项`)
  api.smoke.report({ checks: results, failures })
}

/**
 * 把字节按 latin1 转为字符串。
 *
 * PDF 的字体资源标记（`/FontFile2` 等）是 ASCII 明文，
 * 但内容流是二进制。用 latin1 可以保证字节不被改写，
 * 从而在整份文件里安全地做 ASCII 子串查找。
 */
function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let output = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return output
}

function findNode(node: FileTreeNode, name: string): FileTreeNode | undefined {
  if (node.name === name) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, name)
    if (found) return found
  }
  return undefined
}

void init()
