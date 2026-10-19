import {
  InputRule,
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  ellipsis,
  emDash
} from 'prosemirror-inputrules'
import {
  chainCommands,
  toggleMark,
  setBlockType,
  exitCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
  newlineInCode,
  selectParentNode
} from 'prosemirror-commands'
import { wrapInList, splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list'
import { keymap } from 'prosemirror-keymap'
import { undo, redo } from 'prosemirror-history'
import { TextSelection, type Command, type EditorState } from 'prosemirror-state'
import type { MarkType, Schema } from 'prosemirror-model'
import { MAX_HEADING_LEVEL, marks, nodes } from './schema'

/**
 * 编辑行为：输入规则（markdown 即时转换）+ 键盘映射。
 *
 * 这是"所见即所得"体验的核心——用户敲 `## ` 应立刻得到二级标题，
 * 而不是先看到两个井号再手动转换。
 */

/* ------------------------------------------------------------------ *
 * 输入规则
 * ------------------------------------------------------------------ */

/** 最近一次标记规则未生效的结构化原因，供自检回传（渲染层 console 不可见于终端）。 */
export interface MarkRuleDiagnostics {
  pattern: string
  captured: string
  match0: string
  start: number
  end: number
  innerStart: number
  innerEnd: number
  docSize: number
  reason: string
}

let lastMarkRuleDiagnostics: MarkRuleDiagnostics | null = null

export function getLastMarkRuleDiagnostics(): MarkRuleDiagnostics | null {
  return lastMarkRuleDiagnostics
}

/**
 * 行内标记输入规则。
 *
 * 关键点是**标记区间的计算**：正则里为处理边界可能带前导字符
 * （如 `(?:^|[^*])\*([^*\n]+)\*$`），捕获组并非从 `start` 开始。
 * 因此不能直接用 `start`/`end`，而要从"整个匹配串的末尾"往回推——
 * 从 `end` 推算天然与替换后的位置对齐，而用 `start + 偏移` 会因
 * 前方的 delete 造成位置平移而越界。
 */
function markInputRule(pattern: RegExp, markType: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    if (!state.selection.empty) return null

    const captured = match[1]
    if (!captured) return null

    /**
     * 计算内层文本的起始偏移。
     *
     * 正则里的前导部分**本身也常常是捕获组**（如 `(?:^|[^*])\*([^*\n]+)\*$`
     * 中 match[2] 才是内容），因此偏移量等于"内容捕获组之前所有捕获组长度之和"。
     * 曾错误地用 `match[0].length - captured.length`（等价于假设前导只有标记符号），
     * 导致内层区间整体左偏一个字——区间末端落在文本之外，addMark 于是越界崩溃。
     *
     * 这里把"最后一个捕获组"视为内容：上述所有规则都满足该结构。
     */
    let contentGroup = -1
    for (let group = match.length - 1; group >= 1; group -= 1) {
      if (match[group] !== undefined) {
        contentGroup = group
        break
      }
    }
    if (contentGroup < 1) return null

    let offsetInMatch = 0
    for (let group = 1; group < contentGroup; group += 1) {
      offsetInMatch += match[group]?.length ?? 0
    }

    const innerStart = start + offsetInMatch
    const innerEnd = innerStart + captured.length

    // 必须落在同一个文本块内，且区间确实覆盖文本
    const $start = state.doc.resolve(innerStart)
    const $end = state.doc.resolve(innerEnd)

    if ($start.parent !== $end.parent || !isMarkableRange(state.doc, innerStart, innerEnd)) {
      lastMarkRuleDiagnostics = {
        pattern: pattern.source,
        captured,
        match0: match[0],
        start,
        end,
        innerStart,
        innerEnd,
        docSize: state.doc.content.size,
        reason: $start.parent !== $end.parent ? 'cross-block' : 'not-markable'
      }
      return null
    }

    lastMarkRuleDiagnostics = null
    const mark = markType.create()
    return state.tr
      .delete(start, end)
      .insertText(captured, start)
      .addMark(innerStart, innerEnd, mark)
  })
}

/**
 * 区间是否可被标记。
 *
 * 用 `textBetween` 而非遍历节点：这里只需确认区间**覆盖到实际文本**。
 * 区间端点落在块边界或空节点上时没有文本可标记，此时必须放弃，
 * 否则 addMark 会在文档内部抛出难以定位的错误。
 * （早先用 nodesBetween 判断，但该遍历对纯文本区间的回调行为与预期不同，
 * 导致合法区间被误判为不可标记，规则静默失效。）
 */
function isMarkableRange(doc: import('prosemirror-model').Node, from: number, to: number): boolean {
  if (to <= from) return false
  if (from < 0 || to > doc.content.size) return false
  return doc.textBetween(from, to, null, '\ufffc').length > 0
}

export function buildInputRules(schema: Schema): ReturnType<typeof inputRules> {
  const rules = [
    // 标题：`# ` ~ `###### `
    textblockTypeInputRule(
      new RegExp(`^(#{1,${MAX_HEADING_LEVEL}})\\s$`),
      schema.nodes.heading,
      (match) => ({ level: match[1].length })
    ),

    // 引用：`> `
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),

    // 无序列表：`- ` / `* ` / `+ `
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),

    // 有序列表：`1. `；回调保证只有序号连续时才续接同一列表
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (match) => ({ order: Number(match[1]) }),
      (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1])
    ),

    // 代码块围栏
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    textblockTypeInputRule(/^~~~$/, schema.nodes.code_block),

    // 分隔线
    textblockTypeInputRule(/^(?:---|\*\*\*|___)$/, schema.nodes.horizontal_rule),

    // 行内标记
    markInputRule(/\*\*([^*]+)\*\*$/, marks.strong),
    markInputRule(/__([^_]+)__$/, marks.strong),
    markInputRule(/(?:^|[^*])\*([^*\n]+)\*$/, marks.em),
    markInputRule(/(?:^|[^_])_([^_\n]+)_$/, marks.em),
    markInputRule(/`([^`]+)`$/, marks.code),
    markInputRule(/~~([^~]+)~~$/, marks.strikethrough)
  ]

  // 智能替换：省略号与破折号。
  // 刻意不启用弯引号：写中文技术文档时把 " 替换成 “ ” 会干扰代码与英文引用。
  rules.push(ellipsis, emDash)

  return inputRules({ rules })
}

/* ------------------------------------------------------------------ *
 * 块级命令
 * ------------------------------------------------------------------ */

export const toggleBulletList: Command = wrapInList(nodes.bullet_list)
export const toggleOrderedList: Command = wrapInList(nodes.ordered_list)

/** 标题：同级再触发一次则还原为正文（Typora 同款手感）。 */
export function toggleHeading(level: number): Command {
  return (state, dispatch, view) => {
    const parent = state.selection.$from.parent
    const alreadyAtLevel = parent.type === nodes.heading && parent.attrs.level === level

    if (alreadyAtLevel) return setBlockType(nodes.paragraph)(state, dispatch, view)
    return setBlockType(nodes.heading, { level })(state, dispatch, view)
  }
}

/** 引用块：已在其中则退出，否则包裹。 */
export const toggleBlockquote: Command = (state, dispatch, view) => {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === nodes.blockquote) {
      return liftEmptyBlock(state, dispatch, view)
    }
  }
  return wrapInList(nodes.blockquote)(state, dispatch, view)
}

/* ------------------------------------------------------------------ *
 * 键盘映射
 * ------------------------------------------------------------------ */

/** 代码块末尾空行再次回车时退出；仅移除用于退出的最后一个换行及其缩进。 */
const exitCodeOnEmptyLastLine: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== nodes.code_block) return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  const text = $from.parent.textContent
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline < 0 || !/^[ \t]*$/.test(text.slice(lastNewline + 1))) return false

  // 由官方命令检查父容器并创建正文，再在同一事务中清理空行；选区随删除自动映射。
  return exitCode(state, dispatch ? (transaction) => {
    transaction.delete($from.start() + lastNewline, $from.pos)
    dispatch(transaction)
  } : undefined, view)
}

/**
 * Enter 的行为链，按 markdown 语义逐级退化：
 *   代码末尾空行退出 → 代码块换行 → 列表续项 → 逃出代码块 → 就近建段 → 空块退出容器 → 普通分块
 *
 * 顺序不能随意调换：代码块的退出与换行必须先于普通分块，避免代码块被分裂。
 * 与 ProseMirror 的 baseKeymap 一致，`liftEmptyBlock` 必须先于 `splitBlock`，
 * 否则引用末尾的空段落会再次分裂，连续回车无法退出引用。
 */
function buildEnterCommand(schema: Schema): Command {
  return chainCommands(
    exitCodeOnEmptyLastLine,
    newlineInCode,
    splitListItem(schema.nodes.list_item),
    exitCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock
  )
}

/**
 * 在代码块**末尾**按 ↓ 或 ⌘Enter 时，在其后补一个空段落。
 *
 * 为什么需要它：代码块是文档最后一块时，块后没有任何可落脚的位置——
 * 单次回车只会在代码块内换行，默认方向键也移不出去，需要提供快捷退出手势。
 * 这是把代码块放在文末时的死路。
 *
 * 只在"光标在该块最末 + 该块之后没有其它块"时接管，
 * 其余情况返回 false，交还给默认的方向键/回车行为。
 */
const exitCodeBlockAtEnd: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty) return false

  const parent = $from.parent
  if (parent.type !== nodes.code_block) return false
  if ($from.parentOffset !== parent.content.size) return false

  const afterBlock = $from.after($from.depth)
  // 后面还有块时不该接管：光标本来就能移过去
  if (afterBlock < state.doc.content.size) return false

  const paragraph = nodes.paragraph.create()
  if (dispatch) {
    const transaction = state.tr.insert(afterBlock, paragraph)
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(afterBlock + 1)))
    transaction.scrollIntoView()
    dispatch(transaction)
  }
  return true
}

/**
 * Backspace 在"块首"的退化行为。
 *
 * 处理两类容器：
 *
 * 1. **标题**：块首退格还原为正文，这是"从标题回到正文"最自然的操作。
 *
 * 2. **空代码块**：块首退格退出代码块，还原为正文。
 *    这是进入代码块后的标准退出手势——用户在代码块里按回车换行，
 *    想出来时只会按退格，若此时无反应就形成了死路。
 *    （非空代码块不在此处理：那会丢掉已有内容。块首且存在前一块时，
 *     交给 baseKeymap 的 joinBackward 合并，那是正确且符合预期的行为。）
 *
 * 引用块内的空段落由 `liftEmptyBlock` 处理，这里不插手以免争抢。
 */
const backspaceToParagraph: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false

  const parent = $from.parent

  if (parent.type === nodes.code_block) {
    // 只认空块：有内容的代码块块首退格不能改变块类型
    if (parent.content.size > 0) return false
    return setBlockType(nodes.paragraph)(state, dispatch, view)
  }

  if (parent.type !== nodes.heading) return false
  return setBlockType(nodes.paragraph)(state, dispatch, view)
}

export function buildKeymap(schema: Schema): ReturnType<typeof keymap> {
  const { hard_break: hardBreak } = schema.nodes

  const softBreak: Command = (state, dispatch) => {
    if (!hardBreak) return false
    if (dispatch) dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView())
    return true
  }

  const bindings: Record<string, Command> = {
    Enter: buildEnterCommand(schema),
    'Shift-Enter': chainCommands(newlineInCode, softBreak),

    // 退出代码块的两种手势：⌘Enter（Typora 同款）与在末尾按 ↓
    'Mod-Enter': exitCodeBlockAtEnd,
    ArrowDown: exitCodeBlockAtEnd,

    'Mod-z': undo,
    'Mod-Shift-z': redo,
    'Mod-y': redo,

    // 行内标记：Mod-e 用 code（Mod-` 在多数键盘布局不可靠）
    'Mod-b': toggleMark(marks.strong),
    'Mod-i': toggleMark(marks.em),
    'Mod-e': toggleMark(marks.code),
    'Mod-Shift-x': toggleMark(marks.strikethrough),

    // 列表缩进
    Tab: sinkListItem(schema.nodes.list_item),
    'Shift-Tab': liftListItem(schema.nodes.list_item),
    'Mod-]': sinkListItem(schema.nodes.list_item),
    'Mod-[': liftListItem(schema.nodes.list_item),

    Backspace: backspaceToParagraph,
    'Mod-a': selectParentNode
  }

  // 标题：Mod-Alt-1..6（Mod-1 与系统标签页切换冲突，故加 Alt）
  for (let level = 1; level <= MAX_HEADING_LEVEL; level += 1) {
    bindings[`Mod-Alt-${level}`] = toggleHeading(level)
  }
  bindings['Mod-0'] = setBlockType(nodes.paragraph)

  return keymap(bindings)
}

/* ------------------------------------------------------------------ *
 * 状态查询（供工具栏高亮）
 * ------------------------------------------------------------------ */

export const inlineCommands = {
  bold: toggleMark(marks.strong),
  italic: toggleMark(marks.em),
  code: toggleMark(marks.code),
  strikethrough: toggleMark(marks.strikethrough)
} as const

export function isMarkActive(state: EditorState, markName: string): boolean {
  const markType = state.schema.marks[markName]
  if (!markType) return false

  const { from, to, empty, $from } = state.selection
  if (empty) return Boolean(markType.isInSet(state.storedMarks ?? $from.marks()))
  return state.doc.rangeHasMark(from, to, markType)
}

export type BlockKind = 'paragraph' | 'heading' | 'code_block' | 'blockquote' | 'list'

/** 光标所处块类型。标题需看直接父节点（blockquote 内部也可能有标题）。 */
export function activeBlockKind(state: EditorState): BlockKind {
  const { $from } = state.selection
  const parent = $from.parent

  if (parent.type === nodes.heading) return 'heading'
  if (parent.type === nodes.code_block) return 'code_block'

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const type = $from.node(depth).type
    if (type === nodes.blockquote) return 'blockquote'
    if (type === nodes.bullet_list || type === nodes.ordered_list) return 'list'
  }
  return 'paragraph'
}

export function activeHeadingLevel(state: EditorState): number | null {
  const parent = state.selection.$from.parent
  return parent.type === nodes.heading ? (parent.attrs.level as number) : null
}

export function isInList(state: EditorState): boolean {
  const kind = activeBlockKind(state)
  return kind === 'list'
}
