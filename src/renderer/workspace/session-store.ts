import type { FileEncoding, LineEnding, LoadedDocument } from '../../shared/ipc'
import { createMarkdownEditor, type EditorApi } from '../editor'
import type { ImageResolver } from '../editor/image'
import { messages } from '../../shared/i18n'
import { isPlainTextPath, type ViewerKind } from '../../shared/document-types'

/**
 * 多标签会话模型。
 *
 * 核心约束（沿用 L1 的"单一权威"原则）：
 * **每个会话的权威内容是它自己的 markdown 字符串**，与是否有内核实例无关。
 *
 * 因此内核是**按需挂载**的：只有当前活动会话持有 EditorApi 与 DOM。
 * 这样做换来三件确定的好处：
 *  1. 标签数不影响内存：打开 50 个文件不会创建 50 个 contenteditable
 *  2. 内核实例与"当前可见文档"强绑定，天然没有隐藏编辑器读到过期数据的问题
 *     （L1 曾因此丢过内容）
 *  3. 切标签只是"序列化旧会话 → 装载新会话"，没有状态共享
 *
 * 代价是切标签会丢失每个会话独立的撤销栈。对 L2 而言这个取舍可接受；
 * 若要做常驻多实例（保留各自撤销栈），只需把 `editor` 从"单例"改为 "Map<id, EditorApi>"，
 * 其余逻辑无需改动——这正是把 markdown 作为权威内容带来的好处。
 */

export interface Session {
  id: string
  /** null 表示未命名文档 */
  filePath: string | null
  title: string
  /**
   * 会话种类。
   *
   * `viewer` 是只读会话：没有权威文本、不挂编辑内核、永不产生脏标记。
   * 它必须是**显式**的一类，而不是"markdown 恰好为空的文档"——
   * 否则保存、模式切换、字数统计都会把它当文档处理，
   * 出现"查看一个 PDF 却把空内容写回磁盘"这种事故。
   */
  kind: 'document' | 'viewer'
  /** 仅 viewer 会话有值 */
  viewerKind: ViewerKind | null
  /** 权威内容 */
  markdown: string
  /** 打开或上次保存时的内容，用于判断是否真的产生改动 */
  savedMarkdown: string
  encoding: FileEncoding
  eol: LineEnding
  /** 该文件编码是否为推测结果（GBK 回退），UI 需提示 */
  encodingGuessed: boolean
  /** 内核是否已挂载到 DOM（仅活动的文档会话为 true） */
  mounted: boolean
}

type SessionListener = () => void

export class SessionStore {
  private sessions: Session[] = []
  private activeId: string | null = null
  private readonly listeners = new Set<SessionListener>()
  private readonly mountHost: HTMLElement
  private editor: EditorApi | null = null
  private counter = 0

  private readonly imageResolver: ImageResolver | undefined

  constructor(mountHost: HTMLElement, options: { imageResolver?: ImageResolver } = {}) {
    this.mountHost = mountHost
    this.imageResolver = options.imageResolver
  }

  /* --------------------------- 订阅 --------------------------- */

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /* --------------------------- 查询 --------------------------- */

  list(): readonly Session[] {
    return this.sessions
  }

  get active(): Session | null {
    return this.sessions.find((session) => session.id === this.activeId) ?? null
  }

  get activeEditor(): EditorApi | null {
    return this.editor
  }

  /** 是否存在未保存内容——关窗守卫需要它 */
  hasUnsavedWork(): boolean {
    return this.sessions.some((session) => this.isDirty(session))
  }

  isDirty(session: Session): boolean {
    return session.markdown !== session.savedMarkdown
  }

  find(filePath: string): Session | undefined {
    return this.sessions.find((session) => session.filePath === filePath)
  }

  /* --------------------------- 会话生命周期 --------------------------- */

  private nextId(): string {
    this.counter += 1
    return `session-${this.counter}`
  }

  /**
   * 活动标签是不是"一张白纸"：未命名、没保存过、内容为空、没改过。
   *
   * 启动时会先给一张白纸；用户随后打开文件时若再新建标签，
   * 就会留下一个永远没人用的"未命名"。因此打开行为应当就地替换它。
   * 条件里带脏检查是底线：替换绝不能吃掉用户已经写下的内容。
   */
  private blankUntitledActive(): Session | null {
    const session = this.active
    if (session === null || session.kind !== 'document') return null
    if (session.filePath !== null) return null
    if (session.markdown !== '' || session.savedMarkdown !== '') return null
    return session
  }

  /** 未命名文档的标题：依次取"未命名"、"未命名 2"…避免重名。 */
  private nextUntitledTitle(): string {
    const existing = new Set(this.sessions.map((session) => session.title))
    const untitled = messages().app.untitled
    if (!existing.has(untitled)) return untitled
    let index = 2
    while (existing.has(`${untitled} ${index}`)) index += 1
    return `${untitled} ${index}`
  }

  /**
   * 语言切换后重命名所有未命名文档。
   *
   * 标题是 `messages().app.untitled` 的**快照**：建标签时取一次，
   * 之后语言变了标签与窗口标题仍是旧语言（"未命名 — TypeFlow"）。
   * 只改未命名文档——已有文件路径的标签标题取自文件名，与语言无关。
   */
  retitleUntitled(): void {
    const untitled = messages().app.untitled
    let index = 1

    for (const session of this.sessions) {
      if (session.filePath !== null) continue
      session.title = index === 1 ? untitled : `${untitled} ${index}`
      index += 1
    }
  }

  createUntitled(): Session {
    const session: Session = {
      id: this.nextId(),
      filePath: null,
      title: this.nextUntitledTitle(),
      kind: 'document',
      viewerKind: null,
      markdown: '',
      savedMarkdown: '',
      encoding: 'utf8',
      eol: 'lf',
      encodingGuessed: false,
      mounted: false
    }
    this.sessions.push(session)
    this.activate(session.id)
    return session
  }

  /**
   * 新建或复用会话。
   *
   * 同一个文件只应有一个标签：重复打开时聚焦已有标签，
   * 否则会出现"两个标签编辑同一文件、互相覆盖"的严重问题。
   */
  createFromDocument(filePath: string, document_: LoadedDocument): Session {
    const existing = this.find(filePath)
    if (existing) {
      this.activate(existing.id)
      return existing
    }

    const blank = this.blankUntitledActive()
    if (blank) {
      this.unmountActive()
      blank.filePath = filePath
      blank.title = baseName(filePath)
      blank.markdown = document_.content
      blank.savedMarkdown = document_.content
      blank.encoding = document_.encoding
      blank.eol = document_.eol
      blank.encodingGuessed = document_.encodingGuessed
      this.mount(blank)
      this.emit()
      return blank
    }

    const session: Session = {
      id: this.nextId(),
      filePath,
      title: baseName(filePath),
      kind: 'document',
      viewerKind: null,
      markdown: document_.content,
      savedMarkdown: document_.content,
      encoding: document_.encoding,
      eol: document_.eol,
      encodingGuessed: document_.encodingGuessed,
      mounted: false
    }
    this.sessions.push(session)
    this.activate(session.id)
    return session
  }

  /**
   * 新建或复用只读查看会话（PDF / HTML / 图片）。
   *
   * 不读取正文：这些文件要么是二进制（PDF、图片），要么按原文交给净化层（HTML），
   * 因此 `markdown` 恒为空，脏标记与保存流程天然不成立。
   */
  createViewer(filePath: string, viewerKind: ViewerKind): Session {
    const existing = this.find(filePath)
    if (existing) {
      this.activate(existing.id)
      return existing
    }

    const blank = this.blankUntitledActive()
    if (blank) {
      this.unmountActive()
      blank.filePath = filePath
      blank.title = baseName(filePath)
      blank.kind = 'viewer'
      blank.viewerKind = viewerKind
      this.emit()
      return blank
    }

    const session: Session = {
      id: this.nextId(),
      filePath,
      title: baseName(filePath),
      kind: 'viewer',
      viewerKind,
      markdown: '',
      savedMarkdown: '',
      encoding: 'utf8',
      eol: 'lf',
      encodingGuessed: false,
      mounted: false
    }
    this.sessions.push(session)
    this.activate(session.id)
    return session
  }

  /** 切换活动会话：序列化旧会话、卸载内核、挂载新会话。 */
  activate(id: string): boolean {
    if (this.activeId === id) return false
    const target = this.sessions.find((session) => session.id === id)
    if (!target) return false

    this.unmountActive()

    this.activeId = id
    this.mount(target)
    this.emit()
    return true
  }

  /** 关闭会话。返回关闭后的活动会话 id（用于决定是否新建空白文档）。 */
  close(id: string): string | null {
    const index = this.sessions.findIndex((session) => session.id === id)
    if (index < 0) return this.activeId

    const wasActive = this.activeId === id
    if (wasActive) this.unmountActive()

    this.sessions.splice(index, 1)

    if (wasActive) {
      this.activeId = null
      // 关闭后聚焦相邻标签：优先右侧，与常见编辑器一致
      const next = this.sessions[index] ?? this.sessions[index - 1]
      if (next) this.activate(next.id)
    }

    this.emit()
    return this.activeId
  }

  /** 内核内容变化后回写权威内容。 */
  commitActive(markdown: string): void {
    const session = this.active
    if (!session) return
    if (session.markdown === markdown) return
    session.markdown = markdown
    this.emit()
  }

  /** 保存成功后更新基线，脏标记随之消失。 */
  markSaved(id: string, markdown: string, encoding: FileEncoding): void {
    const session = this.sessions.find((item) => item.id === id)
    if (!session) return
    session.markdown = markdown
    session.savedMarkdown = markdown
    session.encoding = encoding
    session.encodingGuessed = false
    this.emit()
  }

  /** 另存为 / 重命名后更新文件路径与标题。 */
  updateFilePath(id: string, filePath: string | null): void {
    const session = this.sessions.find((item) => item.id === id)
    if (!session) return
    session.filePath = filePath
    session.title = filePath ? baseName(filePath) : session.title
    this.emit()
  }

  /** 工作区里文件被重命名/删除后同步会话状态。 */
  updatePathPrefix(fromPrefix: string, toPrefix: string | null): void {
    for (const session of this.sessions) {
      if (!session.filePath || !session.filePath.startsWith(fromPrefix)) continue
      if (toPrefix === null) {
        session.filePath = null
        session.title = `${session.title}${messages().status.fileDeletedSuffix}`
      } else {
        session.filePath = toPrefix + session.filePath.slice(fromPrefix.length)
        session.title = baseName(session.filePath)
      }
    }
    this.emit()
  }

  /* --------------------------- 内核挂载 --------------------------- */

  private mount(session: Session): void {
    // 只读查看会话不挂内核：查看器由渲染层单独渲染，
    // 这里挂一个空文档内核只会在切回时把空内容当成"用户改过"
    if (session.kind === 'viewer') return

    this.editor = createMarkdownEditor(this.mountHost, {
      placeholder: messages().placeholder.editor,
      // 图片相对路径的基准目录必须随活动文档走，否则会串图
      ...(this.imageResolver ? { imageResolver: this.imageResolver } : {}),
      onChange: (event) => {
        // 只有用户输入才算改动；程序化装载由 setMarkdown 抑制，不会走到这里
        if (event.userInitiated) this.commitActive(event.markdown)
      },
      onSelectionChange: () => this.emit()
    })

    this.editor.setMarkdown(session.markdown)
    session.mounted = true
  }

  private unmountActive(): void {
    const session = this.active

    // 先序列化再销毁：销毁后再取内容就晚了。
    // 纯文本会话例外——它的权威内容是文件原文，一旦被 Markdown 序列化结果覆盖，
    // 切个标签就会把 `*` 变成 `\*`、把单换行合并成一段。
    if (session) {
      if (this.editor && !isPlainTextPath(session.filePath)) {
        session.markdown = this.editor.getMarkdown()
      }
      session.mounted = false
    }

    this.editor?.destroy()
    this.editor = null
    this.mountHost.replaceChildren()
  }

  /** 供自检与"强制重载"使用：丢弃内核，用当前权威内容重新挂载。 */
  remountActive(): void {
    const session = this.active
    if (!session) return
    this.unmountActive()
    this.mount(session)
    this.emit()
  }

  dispose(): void {
    this.unmountActive()
    this.sessions = []
    this.activeId = null
    this.emit()
  }
}

export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}
