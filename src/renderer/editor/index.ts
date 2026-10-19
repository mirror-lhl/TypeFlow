import { EditorState, Plugin, TextSelection, AllSelection, type Command, type Transaction } from 'prosemirror-state'
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import type { EditorView as EditorViewType } from 'prosemirror-view'
import { schema } from './schema'
import { buildInputRules, buildKeymap, getLastMarkRuleDiagnostics, inlineCommands, type MarkRuleDiagnostics } from './behavior'
import { MathNodeView } from './math'
import { CodeBlockNodeView } from './code-block'
import { codeHighlightPlugin } from './code-highlight'
import { buildTableKeymap, buildTablePlugins } from './table-plugins'
import { searchHighlightKey, searchHighlightPlugin } from './search-highlight'
import { ImageNodeView, type ImageResolver } from './image'
import { documentToMarkdown, markdownToDocument } from './markdown'

/**
 * 编辑器内核：ProseMirror 的 TypeFlow 封装。
 *
 * 对外只暴露"markdown 字符串进、markdown 字符串出"的窄接口，
 * 让渲染层（以及未来的标签页、导出、搜索）完全不必了解 ProseMirror 的节点模型。
 *
 * 这条边界是刻意设计的：内核实现可以整体替换（例如换成 Milkdown 或自研解析器），
 * 只要守住这个接口，上层功能一行都不用改。L1 的绝大部分风险因此被限制在本目录内。
 */

/* ------------------------------------------------------------------ *
 * 占位提示
 * ------------------------------------------------------------------ */

/** 空文档时挂一个装饰器显示提示，不写入文档内容（因此不会污染 markdown）。 */
function placeholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state: EditorState) {
        const { doc } = state
        if (
          doc.childCount === 1 &&
          doc.firstChild?.isTextblock &&
          doc.firstChild.content.size === 0
        ) {
          const placeholder = document.createElement('span')
          placeholder.className = 'editor-placeholder'
          placeholder.textContent = text
          return DecorationSet.create(doc, [
            Decoration.widget(1, placeholder, { side: -1, ignoreSelection: true })
          ])
        }
        return null
      }
    }
  })
}

/* ------------------------------------------------------------------ *
 * 公共接口
 * ------------------------------------------------------------------ */

export interface EditorChangeEvent {
  /** 当前文档序列化后的 markdown */
  markdown: string
  /** 是否由用户输入触发（false 表示程序化 setMarkdown） */
  userInitiated: boolean
}

export interface EditorOptions {
  placeholder?: string
  /**
   * 图片解析器。未提供时图片按"缺失"占位显示——
   * 这样内核在没有宿主环境（例如 jsdom 单测）时仍可独立创建。
   */
  imageResolver?: ImageResolver
  onChange?(event: EditorChangeEvent): void
  /** 选区变化时触发，供工具栏更新高亮状态 */
  onSelectionChange?(): void
}

/** 文本注入结果。 */
export type AutoInsertResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported-input' | 'no-input-handler' }

/**
 * 最近一次 autoInsert 的诊断信息。
 *
 * 输入规则链路上任何一环失效都表现为"看似无反应"，而渲染进程的 console
 * 不会出现在宿主终端，因此把关键状态结构化暴露出来供自检回传。
 */
export interface AutoInsertDiagnostics {
  text: string
  handlerFound: boolean
  composing: boolean
  focused: boolean
  from: number
  parentType: string
  parentOffset: number
  textBefore: string
  /** 若本次命中标记类规则但未成功加标记，这里带上规则内部坐标 */
  markRule: MarkRuleDiagnostics | null
}

let lastAutoInsertDiagnostics: AutoInsertDiagnostics | null = null

export function getLastAutoInsertDiagnostics(): AutoInsertDiagnostics | null {
  return lastAutoInsertDiagnostics
}

export interface EditorApi {
  getMarkdown(): string
  /** 程序化替换内容；不触发 onChange（避免回环） */
  setMarkdown(markdown: string): void
  /** 在光标处插入纯文本（直接改文档，不经过输入规则） */
  insertText(text: string): void
  /**
   * 模拟真实键入一个字符。
   *
   * 与 `insertText` 的区别：字符会先经过输入规则管线，因此 `#` 后接空格会变成标题。
   * 这是"逐字注入"类功能（听写、AI 续写、外部宏）的正确接入点，
   * 也是自检验证输入规则的可靠途径。
   */
  autoInsert(text: string): AutoInsertResult
  /**
   * 只跑输入规则管线、不做兜底插入。
   *
   * 自检需要区分"规则命中并转换"与"没有规则命中"——后者在真实键入下
   * 会退化成普通插入，若与前者混为一谈就无法断言规则是否真的生效。
   */
  applyDefaultInput(text: string): AutoInsertResult
  /** 执行命令；返回是否被处理 */
  execute(command: Command): boolean
  canExecute(command: Command): boolean
  undo(): boolean
  redo(): boolean
  focus(): void
  isEmpty(): boolean
  selectAll(): void
  /**
   * 设置查找高亮。
   *
   * 用装饰器而非选区，因此**不需要焦点**也能显示——
   * 这正是支持"边在查找框输入边看编辑器里的结果"的前提。
   */
  setSearchHighlights(matches: readonly { from: number; to: number }[], currentIndex: number): void
  clearSearchHighlights(): void
  /**
   * 标出"刚跳转到这里"的位置。
   *
   * 与选区不同，它不依赖焦点，也不会被 NodeView 重建 DOM 吞掉——
   * 因此是展示"我跳到了哪"的可靠方式。
   */
  setLocator(range: { from: number; to: number } | null): void
  destroy(): void
  readonly view: EditorViewType
  readonly state: EditorState
}

/* ------------------------------------------------------------------ *
 * 实现
 * ------------------------------------------------------------------ */

class TypeFlowEditor implements EditorApi {
  readonly view: EditorViewType
  private readonly options: EditorOptions
  private suppressChange = false
  private lastHandlerFound = false

  constructor(mount: HTMLElement, options: EditorOptions = {}) {
    this.options = options

    const initial = EditorState.create({
      doc: markdownToDocument(''),
      plugins: [
        buildInputRules(schema),
        buildKeymap(schema),
        keymap(baseKeymap),
        // 表格键盘映射放在 baseKeymap 之后：Tab 需要先被表格消费，
        // 否则会落到 baseKeymap 的缩进处理上
        buildTableKeymap(),
        ...buildTablePlugins(),
        history(),
        // 语法高亮用装饰器：NodeView 改写 contentDOM 会同时破坏选区、装饰器与 IME（见 code-highlight.ts）
        codeHighlightPlugin(),
        // 查找高亮用装饰器而非选区：查找框持有焦点时 ProseMirror 不会写入 DOM 选区
        searchHighlightPlugin(),
        dropCursor({ color: 'currentColor', width: 2 }),
        gapCursor(),
        placeholderPlugin(options.placeholder ?? '开始写作…')
      ]
    })

    this.view = new EditorView(mount, {
      state: initial,
      dispatchTransaction: (transaction) => this.dispatch(transaction),
      // 公式与代码块需要自定义渲染，但都保持 doc 模型与可编辑性不变
      nodeViews: {
        math_inline: (node, view, getPos) => new MathNodeView(node, view, getPos, false),
        math_block: (node, view, getPos) => new MathNodeView(node, view, getPos, true),
        code_block: (node, view, getPos) => new CodeBlockNodeView(node, view, getPos),
        image: (node) => new ImageNodeView(node, options.imageResolver ?? NULL_IMAGE_RESOLVER)
      },
      attributes: {
        class: 'typeflow-editor',
        // 中文文档若开启拼写检查会被大量误标
        spellcheck: 'false',
        autocapitalize: 'off',
        translate: 'no'
      }
    })

    // 光标移动不经过 dispatchTransaction，需额外监听才能及时更新工具栏高亮
    this.view.dom.addEventListener('keyup', () => this.options.onSelectionChange?.())
    this.view.dom.addEventListener('mouseup', () => this.options.onSelectionChange?.())
  }

  private dispatch(transaction: Transaction): void {
    const previousDoc = this.view.state.doc
    const nextState = this.view.state.apply(transaction)
    this.view.updateState(nextState)

    if (!nextState.doc.eq(previousDoc)) {
      this.options.onSelectionChange?.()
      if (!this.suppressChange) {
        this.options.onChange?.({
          markdown: documentToMarkdown(nextState.doc),
          userInitiated: transaction.docChanged
        })
      }
    } else if (transaction.selectionSet) {
      this.options.onSelectionChange?.()
    }
  }

  getMarkdown(): string {
    return documentToMarkdown(this.view.state.doc)
  }

  setMarkdown(markdown: string): void {
    const doc = markdownToDocument(markdown)
    const transaction = this.view.state.tr
      .replaceWith(0, this.view.state.doc.content.size, doc.content)
      // 程序化替换不进历史：否则"打开文件"会变成一次可撤销操作
      .setMeta('addToHistory', false)

    this.suppressChange = true
    try {
      this.view.dispatch(transaction)
    } finally {
      this.suppressChange = false
    }
    this.options.onSelectionChange?.()
  }

  insertText(text: string): void {
    this.view.dispatch(this.view.state.tr.insertText(text).scrollIntoView())
  }

  /**
   * 模拟真实键入一个字符。
   *
   * 与 `insertText` 的区别：字符会先经过输入规则管线，因此 `#` 后接空格会变成标题。
   * 这是"逐字注入"类功能（听写、AI 续写、外部宏）的正确接入点。
   *
   * 注意"没有规则命中"不算失败：真实键入此时会正常插入字符，
   * 因此这里返回 ok=true 并由内部兜底插入，与用户敲键完全一致。
   */
  autoInsert(text: string): AutoInsertResult {
    const handled = this.runInputPipeline(text)
    // 无论规则是否命中，字符都必须落进文档（与真实输入一致）
    if (!handled) this.view.dispatch(this.defaultInsert(text))
    return { ok: true }
  }

  /**
   * 只跑输入规则管线，不做兜底插入。
   *
   * 这是自检验证输入规则的唯一可靠途径：它必须能区分
   * "规则命中并转换" 与 "没有规则命中"——后者在真实键入下会退化成普通插入，
   * 若混为一谈就无法断言规则是否真的生效。
   */
  applyDefaultInput(text: string): AutoInsertResult {
    const handled = this.runInputPipeline(text)
    return handled
      ? { ok: true }
      : { ok: false, reason: this.lastHandlerFound ? 'unsupported-input' : 'no-input-handler' }
  }

  /** 执行输入规则管线，返回是否被某条规则处理。 */
  private runInputPipeline(text: string): boolean {
    const view = this.view
    const { from, to, $from } = view.state.selection

    this.lastHandlerFound = view.someProp('handleTextInput', () => true) === true
    lastAutoInsertDiagnostics = {
      text,
      handlerFound: this.lastHandlerFound,
      composing: view.composing,
      focused: view.hasFocus(),
      from,
      parentType: $from.parent.type.name,
      parentOffset: $from.parentOffset,
      textBefore: $from.parent.textBetween(0, $from.parentOffset, null, '\ufffc'),
      markRule: getLastMarkRuleDiagnostics()
    }

    const handled =
      view.someProp('handleTextInput', (handler) => handler(view, from, to, text, () => this.defaultInsert(text))) ===
      true
    return handled
  }

  /** 真实键入的默认结果：在光标处插入字符。 */
  private defaultInsert(text: string): Transaction {
    const { from, to } = this.view.state.selection
    return this.view.state.tr.insertText(text, from, to)
  }

  execute(command: Command): boolean {
    return command(this.view.state, this.view.dispatch, this.view)
  }

  canExecute(command: Command): boolean {
    return command(this.view.state, undefined, this.view)
  }

  undo(): boolean {
    this.view.focus()
    return undo(this.view.state, this.view.dispatch)
  }

  redo(): boolean {
    this.view.focus()
    return redo(this.view.state, this.view.dispatch)
  }

  focus(): void {
    this.view.focus()
  }

  isEmpty(): boolean {
    const { doc } = this.view.state
    return doc.childCount <= 1 && (doc.firstChild?.content.size ?? 1) === 0
  }

  selectAll(): void {
    const { state } = this.view
    this.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)))
  }

  setSearchHighlights(
    matches: readonly { from: number; to: number }[],
    currentIndex: number
  ): void {
    this.view.dispatch(
      this.view.state.tr.setMeta(searchHighlightKey, { matches, currentIndex })
    )
  }

  clearSearchHighlights(): void {
    this.view.dispatch(
      this.view.state.tr.setMeta(searchHighlightKey, { matches: [], currentIndex: -1 })
    )
  }

  setLocator(range: { from: number; to: number } | null): void {
    this.view.dispatch(this.view.state.tr.setMeta(searchHighlightKey, { locator: range }))
  }

  get state(): EditorState {
    return this.view.state
  }

  destroy(): void {
    this.view.destroy()
  }
}

/**
 * 未提供解析器时的兜底：图片一律显示为缺失。
 *
 * 用常量而非抛出异常，是为了让内核在无宿主环境（单测、jsdom）下也能创建，
 * 同时明确表达"没有解析能力"而不是悄悄失败。
 */
const NULL_IMAGE_RESOLVER: ImageResolver = {
  assetDirectoryName: 'assets',
  setBaseDirectory: () => undefined,
  get: () => ({ absolutePath: null, status: 'resolved' }),
  unsubscribe: () => undefined,
  storeImage: () => Promise.reject(new Error('当前环境不支持图片写入'))
}

export function createMarkdownEditor(mount: HTMLElement, options: EditorOptions = {}): EditorApi {
  return new TypeFlowEditor(mount, options)
}

/** 光标定位到文档内容起点（第一个块的内部位置）。 */
export function cursorToStart(editorApi: EditorApi): void {
  const { state } = editorApi.view
  const position = Math.min(1, state.doc.content.size)
  editorApi.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(position))))
}

/** 光标定位到文档末尾。 */
export function cursorToEnd(editorApi: EditorApi): void {
  const { state } = editorApi.view
  editorApi.view.dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)))
}

export { inlineCommands }
export { tableCommands, tableContext, isSelectionInTable } from './table-plugins'
