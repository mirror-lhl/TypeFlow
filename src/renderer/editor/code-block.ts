import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import * as prosemirrorState from 'prosemirror-state'
import { LANGUAGE_OPTIONS, canonicalLanguage } from './code-languages'

/**
 * 代码块 NodeView。
 *
 * **职责边界：只管语言下拉框，绝不触碰 `contentDOM`。**
 *
 * 这是本项目付出三个缺陷代价后确立的约束（详见 code-highlight.ts 的说明）：
 * 只要 NodeView 改写 `contentDOM` 的子节点，就会同时破坏
 * DOM 选区、行内装饰器与输入法组合态。语法高亮因此改由装饰器完成，
 * NodeView 只负责渲染头部（语言选择）。
 *
 * 结果：`contentDOM` 创建一次之后终身不变，ProseMirror 完全掌控其内容。
 */

export class CodeBlockNodeView implements NodeView {
  readonly dom: HTMLElement
  /** ProseMirror 会把代码文本写进这里；本类不做任何子节点替换。 */
  readonly contentDOM: HTMLElement

  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly languageSelect: HTMLSelectElement
  /** 头部（语言下拉框）容器。只有它需要自己处理事件。 */
  private readonly header: HTMLElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.className = 'code-block'

    const header = document.createElement('div')
    header.className = 'code-block__header'
    this.header = header

    this.languageSelect = document.createElement('select')
    this.languageSelect.className = 'code-block__language'
    for (const option of LANGUAGE_OPTIONS) {
      const element = document.createElement('option')
      element.value = option
      element.textContent = option
      this.languageSelect.appendChild(element)
    }
    this.languageSelect.addEventListener('change', () => this.commitLanguage())

    header.appendChild(this.languageSelect)

    /**
     * `contentDOM` 是 `<code>`，位于 `<pre>` 内以获得等宽与保留空白。
     *
     * 不能用 `<pre>` 本身当 contentDOM：滚动与内边距样式需要作用在外层 `<pre>`，
     * 而 ProseMirror 只把文本写进 contentDOM，两者职责分开更清晰。
     */
    const pre = document.createElement('pre')
    this.contentDOM = document.createElement('code')
    this.contentDOM.className = 'code-block__code'
    pre.appendChild(this.contentDOM)

    this.dom.append(header, pre)

    this.syncLanguage(node)
  }

  /** 把节点的语言属性同步到下拉框，不改动任何内容 DOM。 */
  private syncLanguage(node: PMNode): void {
    const canonical = canonicalLanguage(String(node.attrs.params ?? ''))
    this.languageSelect.value = LANGUAGE_OPTIONS.includes(
      canonical as (typeof LANGUAGE_OPTIONS)[number]
    )
      ? canonical
      : 'text'
  }

  /**
   * 语言变更写回节点属性，使 markdown 围栏信息同步。
   *
   * **必须把焦点还给编辑区。** 下拉框在 header 里，而 `stopEvent` 有意让 header
   * 自行处理事件（下拉框需要原生行为），于是选完语言后焦点会停留在 `<select>` 上。
   * 此后所有按键（包括退格）都被下拉框吃掉——用户看到的现象是
   * "在代码块里按退格没反应"。
   */
  private commitLanguage(): void {
    const position = this.getPos()
    if (position === undefined) return

    const node = this.view.state.doc.nodeAt(position)
    if (!node) return

    const params = this.languageSelect.value === 'text' ? '' : this.languageSelect.value
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, params })
    )

    this.focusContent(position)
  }

  /**
   * 把编辑焦点移回代码块内容。
   *
   * 用文本选区而非节点选区：节点选中的是整块，
   * 用户再按退格会删掉整个代码块，而不是一个字符。
   */
  private focusContent(blockPosition: number): void {
    try {
      const { state } = this.view
      const block = state.doc.nodeAt(blockPosition)
      if (!block) return

      const target = Math.min(blockPosition + 1 + block.content.size, state.doc.content.size)
      this.view.dispatch(
        state.tr
          .setSelection(prosemirrorState.TextSelection.near(state.doc.resolve(target)))
          .scrollIntoView()
      )
    } catch {
      // 定位失败只是光标没回来，不该影响语言属性的写入
    }
    this.view.focus()
  }

  /** 内容 DOM 由 ProseMirror 全权管理，本类只同步下拉框。 */
  update(node: PMNode): boolean {
    if (node.type.name !== 'code_block') return false
    this.syncLanguage(node)
    return true
  }

  /** 头部（下拉框）的变化与文档无关，忽略；内容 DOM 的变化交给 ProseMirror。 */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node)
  }

  /**
   * 只有头部需要自己处理事件（下拉框依赖原生行为）。
   *
   * 原先写成"`dom` 内、`contentDOM` 外一律拦截"，范围过宽：
   * 点击 `<pre>` 的留白区域也被拦下，**ProseMirror 因此收不到事件，
   * 无法在那里放置间隙光标**——用户表现为"光标出不了代码块"。
   *
   * 收窄到只拦截头部即可：其余区域（`<pre>`、`<code>`）全部交还 ProseMirror。
   */
  stopEvent(event: Event): boolean {
    return this.header.contains(event.target as Node)
  }
}
