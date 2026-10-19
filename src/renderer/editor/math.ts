import katex from 'katex'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import type { NodeSpec } from 'prosemirror-model'

/**
 * 数学公式：schema、markdown 往返、KaTeX 渲染。
 *
 * 为什么行内与块级用两套机制：
 *  - 行内 `$...$` 交给 markdown-it 的 inline 规则——它能正确判断边界，
 *    不会把 `$` 在代码块里或转义的 `\$` 误判为公式起始
 *  - 块级 `$$...$$` 交给 markdown-it 规则则需要在 block 解析器里处理嵌套、
 *    围栏冲突、缩进等一堆情况。改用在解析前**抽取为占位符、解析后回填**，
 *    逻辑更短且不依赖 markdown-it 内部结构
 */

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * 行内公式。
 *
 * `atom: true` 让公式成为不可再分的内联原子：光标不会进入其"内部"，
 * 与 Typora 的手感一致（点选整体、退格整体删除）。
 */
export const mathInlineSpec: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  draggable: false,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-math-inline]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute('data-math-inline') ?? '' })
    }
  ],
  toDOM(node) {
    return ['span', { 'data-math-inline': node.attrs.value }, node.attrs.value]
  }
}

/** 块级公式。`group: 'block'` 使其成为独立块，前后自然分断。 */
export const mathBlockSpec: NodeSpec = {
  group: 'block',
  atom: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-math-block]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).getAttribute('data-math-block') ?? '' })
    }
  ],
  toDOM(node) {
    return ['div', { 'data-math-block': node.attrs.value }, node.attrs.value]
  }
}

/* ------------------------------------------------------------------ *
 * KaTeX 渲染
 * ------------------------------------------------------------------ */

/**
 * 把 LaTeX 渲染为 KaTeX 输出。
 *
 * `throwOnError: false` 且渲染错误为红色文本：用户输入到一半的公式
 * （例如只写了 `\frac{1`）必须仍然可编辑，不能抛错中断整个编辑器。
 */
export function renderMathToHtml(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      errorColor: '#dc2626',
      // 信任自己的输入即可；关闭 \htmlClass 等可能注入 DOM 的扩展更保守
      trust: false,
      strict: false,
      output: 'html'
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `<span class="math-error" title="${escapeHtml(message)}">公式错误</span>`
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 是否有公式正处于源码编辑态。
 *
 * 用模块级标记而非比较 DOM：`stopEvent` 会在每次事件回调里被调用，
 * 走 DOM 查询是更贵的路径。
 */
let editorInputActive = false

export function isMathInputActive(): boolean {
  return editorInputActive
}

/**
 * 公式的 NodeView。
 *
 * 两个关键点：
 *  1. `dom` 用 contenteditable=false 的子元素承载渲染结果，避免 KaTeX 的
 *     大量 span 被 ProseMirror 当成可编辑内容
 *  2. 空公式或正在编辑时必须显示 LaTeX 源码，否则用户看不到自己在写什么
 */
export class MathNodeView implements NodeView {
  readonly dom: HTMLElement
  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly displayMode: boolean
  private rendered = ''

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    displayMode: boolean
  ) {
    this.view = view
    this.getPos = getPos
    this.displayMode = displayMode

    this.dom = document.createElement(displayMode ? 'div' : 'span')
    this.dom.className = displayMode ? 'math-node math-node--block' : 'math-node math-node--inline'
    this.dom.setAttribute('data-math-value', String(node.attrs.value))

    // 双击进入源码编辑：原子节点本身不可直接输入
    this.dom.addEventListener('dblclick', (event) => {
      event.preventDefault()
      this.editSource()
    })

    this.render(node)
  }

  private render(node: PMNode): void {
    const latex = String(node.attrs.value ?? '')
    this.rendered = latex

    if (latex.trim().length === 0) {
      this.dom.textContent = this.displayMode ? '空公式' : '空公式'
      this.dom.classList.add('is-empty')
      return
    }

    this.dom.classList.remove('is-empty')

    const holder = document.createElement('span')
    holder.className = 'math-render'
    // KaTeX 输出由库生成，不含用户可控的标签结构（trust: false 已关闭扩展）
    holder.innerHTML = renderMathToHtml(latex, this.displayMode)
    holder.setAttribute('contenteditable', 'false')

    this.dom.replaceChildren(holder)
    this.dom.setAttribute('data-math-value', latex)
  }

  /** 用原生输入框就地编辑 LaTeX 源码。 */
  private editSource(): void {
    const position = this.getPos()
    if (position === undefined) return

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'math-input'
    input.value = this.rendered

    const commit = (apply: boolean): void => {
      const value = input.value
      editorInputActive = false
      if (apply) {
        const node = this.view.state.schema.nodes.math_inline
        const blockNode = this.view.state.schema.nodes.math_block
        const replacement = (this.displayMode ? blockNode : node).create({ value })
        this.view.dispatch(this.view.state.tr.replaceWith(position, position + 1, replacement))
      }
      this.view.focus()
      this.render(this.view.state.doc.nodeAt(position) ?? this.currentNodeFallback())
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        commit(false)
      }
    })
    input.addEventListener('blur', () => commit(true))

    editorInputActive = true
    this.dom.replaceChildren(input)
    input.focus()
    input.select()
  }

  private currentNodeFallback(): PMNode {
    return this.view.state.schema.nodes.math_inline.create({ value: this.rendered })
  }

  update(node: PMNode): boolean {
    if (node.type.name !== (this.displayMode ? 'math_block' : 'math_inline')) return false
    if (String(node.attrs.value) !== this.rendered) this.render(node)
    return true
  }

  stopEvent(): boolean {
    // 编辑态下由输入框接管所有事件
    return editorInputActive
  }

  ignoreMutation(): boolean {
    return true
  }

  selectNode(): void {
    this.dom.classList.add('is-selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected')
  }
}

/* ------------------------------------------------------------------ *
 * Markdown 解析规格
 * ------------------------------------------------------------------ */

/** markdown-it 自定义 token 名。 */
export const MATH_INLINE_TOKEN = 'math_inline'

/** 块级公式占位符，抽取阶段生成、回填阶段消费。 */
export const BLOCK_MATH_PLACEHOLDER_PREFIX = 'TFMATHBLOCK'

/** 行内公式 token 在 schema 中的映射。 */
export const mathInlineParseSpec = {
  node: 'math_inline',
  getAttrs: (token: { content?: string }) => ({ value: token.content ?? '' })
}

