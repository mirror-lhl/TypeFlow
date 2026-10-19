import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorApi } from '../editor'

/**
 * 文档内文本查找。
 *
 * 为什么不用"在 markdown 字符串里 indexOf"这套（L1 的做法）：
 * 所见即所得模式下光标活在 ProseMirror 文档里，markdown 的字符偏移
 * **与文档位置没有对应关系**（`**` 是两个字符但零个文档位置，
 * 列表缩进、引用前缀同理）。因此必须遍历文档文本节点建立
 * "字符偏移 → 文档位置"的映射，否则高亮与跳转必然错位。
 */

export interface TextMatch {
  /** 文档内位置区间，可直接用于选区 */
  from: number
  to: number
}

interface IndexedText {
  /** 全文纯文本（不含标记符号） */
  text: string
  /** 每个字符对应的起始文档位置，长度与 text 相同 */
  positions: number[]
}
export function indexDocument(doc: PMNode): IndexedText {
  const chunks: string[] = []
  const positions: number[] = []

  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return true

    chunks.push(node.text)
    for (let index = 0; index < node.text.length; index += 1) {
      positions.push(position + index)
    }
    return true
  })

  return { text: chunks.join(''), positions }
}

/**
 * 查找所有匹配。
 *
 * 每次查询重新建立索引：文档规模在编辑器场景下有限，
 * 而增量维护索引需要处理所有事务类型，出错概率远高于收益。
 */
export function findTextMatches(
  doc: PMNode,
  query: string,
  limit = 5000
): { matches: TextMatch[]; text: string; positions: number[] } {
  if (query.length === 0) return { matches: [], text: '', positions: [] }

  const { text, positions } = indexDocument(doc)
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const matches: TextMatch[] = []

  let from = haystack.indexOf(needle)
  while (from !== -1 && matches.length < limit) {
    const end = from + needle.length
    matches.push({
      from: positions[from],
      // 末位字符的文档位置 +1 才是区间末端
      to: positions[end - 1] + 1
    })
    from = haystack.indexOf(needle, end)
  }

  return { matches, text, positions }
}

/**
 * 选中指定区间，并把视图滚到该处。
 *
 * `TextSelection.between` 会把选区吸附到最近的合法文本位置，
 * 因此即使区间端点落在标记边界上也不会抛错。
 *
 * `focus` 默认为 true（用户主动点击跳转时应当把焦点交给编辑区）。
 * **查找功能必须传 false**：它每输入一个字符就调用一次，
 * 若在这里抢走焦点，用户输入第二个字符时输入目标已经变成编辑器，
 * 表现为"只能输入一个字母"。
 */
export function selectRange(
  editor: EditorApi,
  match: TextMatch,
  options: { focus?: boolean } = {}
): boolean {
  const shouldFocus = options.focus ?? true

  try {
    const { state } = editor
    const anchor = Math.min(match.from, state.doc.content.size)
    const head = Math.min(match.to, state.doc.content.size)
    const selection = TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head))

    editor.view.dispatch(state.tr.setSelection(selection).scrollIntoView())
    if (shouldFocus) editor.view.focus()
    return true
  } catch {
    return false
  }
}

/**
 * 在源码模式的原生 textarea 里显示匹配位置。
 *
 * 同样**不调用 focus()**。非聚焦的 textarea 不会自动滚动，
 * 因此这里按行高手动换算滚动位置——否则匹配项在视口外时用户看不到。
 */
export function revealRangeInTextarea(textarea: HTMLTextAreaElement, match: TextMatch): void {
  textarea.setSelectionRange(match.from, match.to)

  const before = textarea.value.slice(0, match.from)
  const lineIndex = before.split('\n').length - 1
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 22
  const viewport = textarea.clientHeight || 0

  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - viewport / 3)
}

/**
 * 把 markdown 行号换算为可直接定位的位置。
 *
 * 用"第 N 行之前累积的字符数"近似，对源码模式精确；
 * 所见即所得模式下该偏移会落在包含该行的段落附近，效果是
 * "跳到大致位置"，对搜索结果的可用性足够——精确到字符需要
 * 建立 markdown 与文档的双向映射，属于后续级别的投入。
 */
export function lineToCharacterOffset(markdown: string, line: number): number {
  if (line <= 1) return 0
  let currentLine = 1
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) === 10) {
      currentLine += 1
      if (currentLine === line) return index + 1
    }
  }
  return markdown.length
}

/** 把字符偏移换算为文档位置；偏移超出文档时退化为文档末尾。 */
export function characterOffsetToPosition(editor: EditorApi, offset: number): number {
  const { text, positions } = indexDocument(editor.state.doc)
  if (positions.length === 0) return Math.min(1, editor.state.doc.content.size)
  const index = Math.max(0, Math.min(offset, text.length - 1))
  return positions[index] ?? Math.min(1, editor.state.doc.content.size)
}
