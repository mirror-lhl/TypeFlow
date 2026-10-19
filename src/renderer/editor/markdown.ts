import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  type ParseSpec
} from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'
// prosemirror-markdown 不转出 Fragment，必须从 prosemirror-model 直接引入
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { schema } from './schema'
import { BLOCK_MATH_PLACEHOLDER_PREFIX, MATH_INLINE_TOKEN, mathInlineParseSpec } from './math'
import {
  ALIGN_ATTR,
  escapeCellContent,
  parseTableAt,
  serializeTable,
  type ColumnAlignment,
  type ParsedTable
} from './table'

/**
 * Markdown ↔ ProseMirror 文档的转换层。
 *
 * 为什么扩展默认解析器/序列化器而不是自己写：
 * 默认实现已经处理了 markdown 里最容易出错的部分——嵌套列表缩进、松散/紧凑列表、
 * 有序列表起始序号、代码块围栏、链接标题转义、以及"何时需要反斜杠转义"。
 * 自己重写几乎没有收益，却会引入大量难以发现的往返偏差。
 *
 * 本文件修正的偏差逐条注明原因，共同目标是：
 * **用户没改内容时，保存不得产生 diff。**
 */

/**
 * 标记的 markdown 序列化规格。
 *
 * prosemirror-markdown 未导出该类型，因此按需声明最小结构，
 * 避免用 `any` 丢掉类型检查。
 */
interface MarkSerializerSpecLike {
  open: string | ((state: MarkdownSerializerState, mark: Mark, parent: PMNode, index: number) => string)
  close: string | ((state: MarkdownSerializerState, mark: Mark, parent: PMNode, index: number) => string)
  mixable?: boolean
  expelEnclosingWhitespace?: boolean
  escape?: boolean
}

/* ------------------------------------------------------------------ *
 * Tokenizer
 * ------------------------------------------------------------------ */

/**
 * 修正 1：必须显式启用 GFM 删除线。
 *
 * 默认 tokenizer 是 `commonmark` preset，**不识别 `~~text~~`**——实测它会把
 * 整行当成普通段落文本（连 `s_open` token 都不产生）。后果很隐蔽：
 * 解析成纯文本后，序列化器再把 `~` 转义，于是 `~~删除~~` 变成 `\~\~删除\~\~`。
 */
/** 表格占位符前缀，抽取阶段生成、回填阶段消费。 */
const TABLE_PLACEHOLDER_PREFIX = 'TFTABLEBLOCK'

const tokenizer = MarkdownIt('commonmark', { html: false }).enable('strikethrough')

/**
 * 行内公式规则：`$...$`。
 *
 * 交给 markdown-it 而非自行扫描，因为它已正确处理"在代码块/行内代码内不解析"、
 * 反斜杠转义、以及 token 边界这些容易做错的部分。
 *
 * 刻意拒绝的几种情况：
 *  - `$$` 开头：属于块级公式，不应被拆成行内公式
 *  - 紧跟空格：`$ x$` 通常是货币或笔误
 *  - 跨行：行内公式跨行会让段落结构难以预测
 *  - 结尾 `$` 后接数字：`$5 和 $10` 是金额而非公式
 */
tokenizer.inline.ruler.before('escape', MATH_INLINE_TOKEN, (state, silent) => {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false

  const next = state.src.charCodeAt(start + 1)
  if (next === 0x24) return false
  if (next === 0x20 || next === 0x09 || next === 0x0a || Number.isNaN(next)) return false

  let cursor = start + 1
  while (cursor < state.posMax) {
    const code = state.src.charCodeAt(cursor)
    if (code === 0x0a) return false
    if (code === 0x5c /* \ */) {
      cursor += 2
      continue
    }
    if (code === 0x24) break
    cursor += 1
  }

  if (cursor >= state.posMax || cursor === start + 1) return false

  const after = state.src.charCodeAt(cursor + 1)
  if (!Number.isNaN(after) && after >= 0x30 && after <= 0x39) return false

  const content = state.src.slice(start + 1, cursor)
  if (content.trim().length === 0) return false

  if (!silent) {
    const token = state.push(MATH_INLINE_TOKEN, 'math', 0)
    token.content = content
    token.markup = '$'
  }

  state.pos = cursor + 1
  return true
})

/* ------------------------------------------------------------------ *
 * 块级公式：抽取 → 占位 → 回填
 * ------------------------------------------------------------------ */

/**
 * 抽出 `$$` 独立成行的块级公式，替换为占位段落。
 *
 * 为什么不用 markdown-it 的 block 规则：那需要处理围栏冲突、缩进、嵌套引用
 * 一整套边界。抽取法只依赖"整行 `$$`"这一条明确约定，行为可预测。
 *
 * 代码围栏内的 `$$` 会被跳过——它是代码，不是公式。
 */
function extractBlockMath(markdown: string): { text: string; values: string[] } {
  const lines = markdown.split('\n')
  const output: string[] = []
  const values: string[] = []
  let inFence = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      output.push(line)
      continue
    }

    if (!inFence && trimmed === '$$') {
      const body: string[] = []
      let cursor = index + 1
      while (cursor < lines.length && lines[cursor].trim() !== '$$') {
        body.push(lines[cursor])
        cursor += 1
      }

      if (cursor < lines.length) {
        // 首尾纯空行不属于公式内容，去掉以免每次往返都累积空行
        while (body.length > 0 && body[0].trim() === '') body.shift()
        while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()

        values.push(body.join('\n'))
        output.push(`${BLOCK_MATH_PLACEHOLDER_PREFIX}${values.length - 1}END`)
        index = cursor
        continue
      }
    }

    output.push(line)
  }

  return { text: output.join('\n'), values }
}

/**
 * 把占位段落还原为 math_block 节点。
 *
 * 实现要点：ProseMirror 没有"按位置替换子节点"的公开 API，
 * 正确做法是**自底向上重建**——每层重新组装 Fragment 后 `node.copy(...)`。
 * 自底向上保证子层先稳定，父层拿到的子节点引用才是最新的。
 *
 * 替换点用**节点对象身份**（Map<Node, Node>）而非位置来匹配：
 * 重建过程中位置会变，而对象引用稳定，因此不会出现"改一处影响另一处"。
 */
function restoreBlockMath(doc: PMNode, values: readonly string[]): PMNode {
  if (values.length === 0) return doc

  const pattern = new RegExp(`^${BLOCK_MATH_PLACEHOLDER_PREFIX}(\\d+)END$`)
  const replacements = new Map<PMNode, PMNode>()

  doc.descendants((node) => {
    if (node.type !== schema.nodes.paragraph) return true

    const match = pattern.exec(node.textContent)
    if (!match) return true

    const value = values[Number(match[1])]
    if (value === undefined) return true

    replacements.set(node, schema.nodes.math_block.create({ value }))
    return true
  })

  if (replacements.size === 0) return doc

  function rebuild(node: PMNode): PMNode {
    const direct = replacements.get(node)
    if (direct) return direct

    if (node.isText || node.childCount === 0) return node

    let changed = false
    const children: PMNode[] = []
    node.forEach((child) => {
      const rebuilt = rebuild(child)
      if (rebuilt !== child) changed = true
      children.push(rebuilt)
    })

    return changed ? node.copy(Fragment.fromArray(children)) : node
  }

  return rebuild(doc)
}

/* ------------------------------------------------------------------ *
 * 表格：抽取 → 占位 → 回填
 * ------------------------------------------------------------------ */

/**
 * 抽出管道表并替换为占位段落。
 *
 * 与块级公式同样的策略，但多一道处理：**占位前后补空行**。
 * 管道表常紧贴上一段文字（`说明：\n| a | b |`），若直接替换，
 * markdown-it 会把占位段落当成上一段的延续，表格位置就错了。
 */
function extractTables(markdown: string): { text: string; tables: ParsedTable[] } {
  const lines = markdown.split('\n')
  const output: string[] = []
  const tables: ParsedTable[] = []
  let inFence = false
  let index = 0

  while (index < lines.length) {
    const trimmed = lines[index].trim()

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      output.push(lines[index])
      index += 1
      continue
    }

    if (!inFence) {
      const parsed = parseTableAt(lines, index)
      if (parsed) {
        const slot = tables.length
        tables.push(parsed.table)
        // 前后各留一个空行，确保占位符自成一段
        if (output.length > 0 && output[output.length - 1].trim() !== '') output.push('')
        output.push(`${TABLE_PLACEHOLDER_PREFIX}${slot}END`)
        output.push('')
        index = parsed.end
        continue
      }
    }

    output.push(lines[index])
    index += 1
  }

  return { text: output.join('\n'), tables }
}

/**
 * 把占位段落还原为 table 节点。
 *
 * 单元格内容用 `parseInline` 复用同一套解析逻辑，因此单元格里的
 * 加粗、行内代码、公式都能正确解析——自己写一套内联解析必然与内核产生分歧。
 */
function restoreTables(doc: PMNode, tables: readonly ParsedTable[]): PMNode {
  if (tables.length === 0) return doc

  const pattern = new RegExp(`^${TABLE_PLACEHOLDER_PREFIX}(\\d+)END$`)
  const replacements = new Map<PMNode, PMNode>()

  doc.descendants((node) => {
    if (node.type !== schema.nodes.paragraph) return true

    const match = pattern.exec(node.textContent)
    if (!match) return true

    const table = tables[Number(match[1])]
    if (!table) return true

    try {
      replacements.set(node, buildTableNode(table))
    } catch {
      // 构造失败时保留占位符文本，便于用户看到问题而不是内容无声消失
    }
    return true
  })

  if (replacements.size === 0) return doc

  function rebuild(node: PMNode): PMNode {
    const direct = replacements.get(node)
    if (direct) return direct
    if (node.isText || node.childCount === 0) return node

    let changed = false
    const children: PMNode[] = []
    node.forEach((child) => {
      const rebuilt = rebuild(child)
      if (rebuilt !== child) changed = true
      children.push(rebuilt)
    })

    return changed ? node.copy(Fragment.fromArray(children)) : node
  }

  return rebuild(doc)
}

/** 把解析出的表格数据构造为 ProseMirror 节点树。 */
function buildTableNode(table: ParsedTable): PMNode {
  const columnCount = Math.max(table.header.length, table.alignments.length, 1)

  const cellNode = (text: string, isHeader: boolean, column: number): Record<string, unknown> => {
    const inline = parseInlineContent(text)
    const alignment = table.alignments[column] ?? 'default'
    return {
      type: isHeader ? 'table_header' : 'table_cell',
      // 对齐必须落到节点属性上，否则序列化时无从还原（会静默丢失）
      attrs: { align: alignment === 'default' ? null : alignment },
      content: [{ type: 'paragraph', content: inline }]
    }
  }

  const rows: Record<string, unknown>[] = []

  // 加表头条件：markdown 表格必有表头行
  rows.push({
    type: 'table_row',
    content: Array.from({ length: columnCount }, (_unused, column) =>
      cellNode(table.header[column] ?? '', true, column)
    )
  })

  for (const row of table.rows) {
    rows.push({
      type: 'table_row',
      content: Array.from({ length: columnCount }, (_unused, column) =>
        cellNode(row[column] ?? '', false, column)
      )
    })
  }

  const built = schema.nodeFromJSON({ type: 'table', content: rows })
  built.check()
  return built
}

/**
 * 解析单元格内联内容，返回 JSON 形态的 inline 节点数组。
 *
 * 复用主解析器而不是自己处理：单元格里的加粗、行内代码、公式
 * 必须与正文行为完全一致，另写一套内联解析必然产生分歧。
 */
function parseInlineContent(text: string): Record<string, unknown>[] {
  // 还原转义的管道符：转义只在表格行列层面有意义
  const unescaped = text.replace(/\\\|/g, '|')
  if (unescaped.trim().length === 0) return []

  /**
   * 复用主解析器解析单元格内联内容。
   *
   * `MarkdownParser` 只暴露 `parse`（块级），没有内联解析入口，
   * 因此这里用一个不可见哨兵字符作前缀：` ` 后跟内容会被解析成一个普通段落，
   * 该段落的子节点就是我们要的 inline 内容。
   *
   * 为什么加前缀：若直接解析 `**粗体**`，它可能被识别为块级结构（如分隔线 `---`、
   * 标题 `# x`），拿到的就不是段落了。哨兵保证始终是段落。
   *
   * 为什么不用自写的内联解析：那会与主解析器产生分歧，
   * 单元格里的公式、删除线等自定义 token 将无法正确工作。
   *
   * 哨兵字符的选择：必须用**私用区**字符而非 `\u0000`。
   * markdown 序列化器会把 `\u0000` 替换为 U+FFFD（替换字符），
   * 一旦剥离不彻底就会变成输出里的乱码（实测出现过 `| �列 A |`）。
   */
  const sentinel = '\uE000'
  const parsed = markdownParser.parse(`${sentinel}${unescaped}`)
  const firstBlock = parsed.firstChild

  if (!firstBlock || firstBlock.type !== schema.nodes.paragraph) {
    return [{ type: 'text', text: unescaped }]
  }

  const nodes: Record<string, unknown>[] = []
  firstBlock.forEach((child) => {
    // 哨兵是首个文本节点的开头，需要剥掉
    if (child.isText && child.text) {
      const text = child.text.startsWith(sentinel) ? child.text.slice(sentinel.length) : child.text
      if (text.length === 0) return
      const json = child.toJSON() as Record<string, unknown>
      json.text = text
      nodes.push(json)
      return
    }
    nodes.push(child.toJSON() as Record<string, unknown>)
  })

  return nodes.length > 0 ? nodes : [{ type: 'text', text: unescaped }]
}

/* ------------------------------------------------------------------ *
 * Markdown → 文档
 * ------------------------------------------------------------------ */

/**
 * 修正 2：代码块的语言标签。
 *
 * 默认解析规格 `{ block: 'code_block', noCloseToken: true }` **完全忽略围栏信息**，
 * 于是 ` ```ts ` 保存后退化为裸 ` ``` `，语言信息丢失。
 */
const codeBlockParseSpec: ParseSpec = {
  block: 'code_block',
  noCloseToken: true,
  getAttrs: (token) => ({ params: (token.info ?? '').trim() })
}

/**
 * 修正 3：无序列表需同时保留**标记风格**与**松紧度**。
 *
 * 默认规格用 `listIsTight` 判断松紧（依据 list_item 之间的段落 token 是否 hidden）。
 * 覆写时若只返回 `bullet`，`tight` 会退回默认 false，
 * 于是紧凑列表 `- a\n- b` 被保存成 `- a\n\n- b`。
 */
function listIsTight(tokens: { type: string; hidden: boolean }[], from: number): boolean {
  for (let index = from + 1; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'list_item_open') return tokens[index].hidden
  }
  return false
}

const bulletListParseSpec: ParseSpec = {
  block: 'bullet_list',
  getAttrs: (_token, tokens, index) => ({
    bullet: tokens[index].markup || '-',
    tight: listIsTight(tokens, index)
  })
}

const extraParseSpec: Record<string, ParseSpec> = {
  s: { mark: 'strikethrough' },
  code_block: codeBlockParseSpec,
  bullet_list: bulletListParseSpec,
  [MATH_INLINE_TOKEN]: mathInlineParseSpec as unknown as ParseSpec
}

const markdownParser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  ...extraParseSpec
})

/* ------------------------------------------------------------------ *
 * 文档 → Markdown
 * ------------------------------------------------------------------ */

/** GFM 删除线：`~~text~~`。`escape: false` 防止波浪号被转义成 `\~`。 */
const strikethroughSerializer: MarkSerializerSpecLike = {
  open: '~~',
  close: '~~',
  escape: false
}

/** 无序列表：使用节点记住的标记字符，避免 `-` 被改写成 `*`。 */
const bulletListSerializer = (state: MarkdownSerializerState, node: PMNode): void => {
  const bullet = (node.attrs.bullet as string) || '-'
  state.renderList(node, '  ', () => `${bullet} `)
}

/** 修正 4：代码块围栏后缀显式 trim，避免多余空格写进围栏。 */
const codeBlockSerializer = (state: MarkdownSerializerState, node: PMNode): void => {
  const backticks = node.textContent.match(/`{3,}/gm)
  const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : '```'
  const language = ((node.attrs.params as string) ?? '').trim()

  state.write(`${fence}${language}\n`)
  state.text(node.textContent, false)
  state.write('\n')
  state.write(fence)
  state.closeBlock(node)
}

/**
 * 行内公式节点：`$latex$`。
 *
 * 用 `state.text(..., false)` 而非 `state.write`：`write` 会按 markdown 规则
 * 转义 `_`/`*`/`\`，而 LaTeX 里这些符号极常见（`x_1`、`a*b`），
 * 转义后会污染公式源码。
 */
const mathInlineNodeSerializer = (state: MarkdownSerializerState, node: PMNode): void => {
  state.write('$')
  state.text(String(node.attrs.value ?? ''), false)
  state.write('$')
}

/** 块级公式：`$$` 独立成行，内容原样输出（LaTeX 里 `_` `*` 很常见，不能转义）。 */
const mathBlockSerializer = (state: MarkdownSerializerState, node: PMNode): void => {
  state.write('$$\n')
  state.text(String(node.attrs.value ?? ''), false)
  state.write('\n$$')
  state.closeBlock(node)
}

/**
 * 渲染单元格内容为 markdown 片段，保留行内标记。
 *
 * 做法是**递归手工渲染**而不是复用 `state.renderInline`：
 * `state.renderInline` 会写入顶层的序列化输出流（表格之外的位置），
 * 而单元格需要先渲染成字符串再送入 `serializeTable` 拼装。
 *
 * 覆盖范围：文本（含 marks）、hard_break、以及无子节点的原子节点
 * （公式、图片）。表格单元格不允许块级内容，因此无需处理块级节点。
 */
function renderCellMarkdown(cell: PMNode): string {
  let output = ''

  cell.forEach((block) => {
    block.forEach((inline) => {
      output += renderInlineNode(inline)
    })
  })

  return output.replace(/\n+/g, ' ')
}

/** 单个内联节点 → markdown 片段。 */
function renderInlineNode(node: PMNode): string {
  if (node.isText) {
    let text = node.text ?? ''
    // 先按标记包裹，再做最小转义：转义要避开标记符号本身
    for (const mark of node.marks) {
      switch (mark.type.name) {
        case 'strong':
          text = `**${text}**`
          break
        case 'em':
          text = `*${text}*`
          break
        case 'code':
          // 行内代码内的反引号需加长围栏
          text = text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
          break
        case 'strikethrough':
          text = `~~${text}~~`
          break
        case 'link': {
          const href = String(mark.attrs.href ?? '')
          const title = mark.attrs.title ? ` "${String(mark.attrs.title)}"` : ''
          text = `[${text}](${href}${title})`
          break
        }
        default:
          break
      }
    }
    return text
  }

  switch (node.type.name) {
    case 'hard_break':
      return ' '
    case 'math_inline':
      return `$${String(node.attrs.value ?? '')}$`
    case 'image': {
      const alt = String(node.attrs.alt ?? '')
      const src = String(node.attrs.src ?? '')
      const title = node.attrs.title ? ` "${String(node.attrs.title)}"` : ''
      return `![${alt}](${src}${title})`
    }
    default:
      return node.textContent
  }
}

/**
 * 表格序列化：节点树 → 管道表文本。
 *
 * 单元格内的段落文本按行拼接（单元格内多段落用空格连接），
 * 并对管道符转义，否则会与列分隔符冲突导致列数错乱。
 */
const tableSerializer = (state: MarkdownSerializerState, node: PMNode): void => {
  const rows: string[][] = []
  const headerRow: string[] = []

  /**
   * 用**行下标**判断表头，不能用 `rows.length === 0`。
   *
   * 后者是错的：`rows` 只在处理非首行时才增长，于是**每一行都满足
   * `rows.length === 0`**，全部被追加进 `headerRow`——
   * 一个 2 行 × 5 列的表格会被写成单行 10 个单元格，
   * 解析回来就变成 1 行 × 10 列，行结构彻底丢失。
   *
   * 这个错误很隐蔽：单行表格的表现恰好"正常"（只有一行，本来就该是表头），
   * 因此只对单行表格做的往返测试无法发现它。
   */
  let rowIndex = 0

  node.forEach((rowNode) => {
    const cells: string[] = []
    rowNode.forEach((cellNode) => {
      // 必须渲染单元格的**内部 markdown**（保留加粗/代码/公式），
      // 不能用 textBetween —— 那只返回纯文本，标记会静默丢失
      const rendered = renderCellMarkdown(cellNode)
      cells.push(escapeCellContent(rendered))
    })

    if (rowIndex === 0) headerRow.push(...cells)
    else rows.push(cells)

    rowIndex += 1
  })

  /**
   * 对齐从**表头单元格的属性**读取，不再硬编码 'default'。
   *
   * 表头一定存在（markdown 管道表的第一行即表头），
   * 且同一列的所有单元格共享同一对齐，因此读第一行即可。
   */
  const alignments: ColumnAlignment[] = []
  node.firstChild?.forEach((cellNode) => {
    const align = cellNode.attrs[ALIGN_ATTR] as string | null
    alignments.push(
      align === 'left' || align === 'center' || align === 'right' ? align : 'default'
    )
  })

  state.write(serializeTable({ header: headerRow, alignments, rows }))
  state.closeBlock(node)
}

const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list: bulletListSerializer,
    code_block: codeBlockSerializer,
    math_inline: mathInlineNodeSerializer,
    math_block: mathBlockSerializer,
    table: tableSerializer
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: strikethroughSerializer
  }
)

/**
 * 序列化选项。
 *
 * `tightLists: true` 让单层列表输出紧凑形式，与手写 markdown 习惯一致。
 * 真正的松紧由节点 `tight` 属性决定，此项只影响兜底行为。
 */
const SERIALIZE_OPTIONS = { tightLists: true } as const

export function documentToMarkdown(doc: PMNode): string {
  return markdownSerializer.serialize(doc, SERIALIZE_OPTIONS)
}

export function markdownToDocument(markdown: string): PMNode {
  // 先抽表格再抽块级公式：表格可能包含 `$$`（作为单元格内容），
  // 顺序反过来会把表格内的 `$$` 误抽成块级公式
  const tables = extractTables(markdown)
  const math = extractBlockMath(tables.text)
  const parsed = markdownParser.parse(math.text)
  const restoredTables = restoreTables(parsed, tables.tables)
  const restored = restoreBlockMath(restoredTables, math.values)

  // 空文档需要一个可放光标的块节点
  if (restored.content.size === 0) {
    return schema.nodes.doc.create(null, [schema.nodes.paragraph.create()])
  }
  return restored
}

/**
 * 往返稳定性检测。
 *
 * markdown → 文档 → markdown 在少数写法下并非恒等（冗余空行、行尾空格、
 * 非规范标记风格）。这本身不是错误，但用户"什么都没改"却让文件产生 diff
 * 会污染版本历史，因此需要能识别并提示。
 */
export function isRoundTripStable(markdown: string): boolean {
  try {
    return documentToMarkdown(markdownToDocument(markdown)) === markdown
  } catch {
    return false
  }
}
