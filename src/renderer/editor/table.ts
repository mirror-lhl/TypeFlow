import type { NodeSpec } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

/**
 * 表格 schema 与 markdown 管道表转换。
 *
 * 两个关键决策：
 *
 * 1. **单元格内容用普通 `paragraph`，不用 `table_cell` 内嵌 `paragraph` 的自定义结构。**
 *    prosemirror-tables 的默认 `tableNodes` 就是这么定义的，直接复用可以避免
 *    与它的命令（增删行列、Tab 导航）发生结构冲突。
 *
 * 2. **markdown 管道表用"抽取/回填"而非 markdown-it 规则。**
 *    管道表的对齐行（`|:---|:--:|`）在 markdown-it 的 core 阶段才被识别，
 *    而 prosemirror-markdown 只消费 token 流，拿不到原始对齐信息。
 *    与块级公式同样的处理方式（见 markdown.ts）。
 */

/**
 * 表格节点规格。
 *
 * 用 `tableNodes` 而非自写：它已经把 `colspan`/`rowspan`/`colwidth` 这些
 * 后续必然需要的能力、以及正确的 `content` 表达式都定义好了。
 * 自写省不了几行，却会在接入表格命令时处处不兼容。
 */
/** 单元格对齐属性名。存 `'left' | 'center' | 'right' | null`。 */
export const ALIGN_ATTR = 'align'

export const tableNodeSpecs: Record<string, NodeSpec> = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph',
  /**
   * `align` 必须存在 schema 里。
   *
   * 此前 `cellAttributes` 是空的——对齐信息在解析阶段被读出来，
   * 却无处存放，序列化时只能硬编码成 `---`。
   * 结果是**数据丢失**：含 `:---:` 的表格打开再保存，对齐标记就没了。
   */
  cellAttributes: {
    [ALIGN_ATTR]: { default: null }
  }
})

/**
 * 让单元格把 align 渲染成行内样式。
 *
 * `tableNodes` 生成的 `toDOM` 只输出 `['td', 0]`，属性不会自动落到 DOM 上，
 * 因此这里包一层。保留 colspan/rowspan 等已有属性，避免覆盖默认行为。
 */
for (const name of ['table_cell', 'table_header'] as const) {
  const spec = tableNodeSpecs[name]
  const tag = name === 'table_header' ? 'th' : 'td'

  spec.toDOM = (node) => {
    const attributes: Record<string, string> = {}

    for (const attribute of ['colspan', 'rowspan', 'colwidth']) {
      const value = node.attrs[attribute]
      if (value === null || value === undefined) continue
      if (attribute === 'colwidth') continue
      attributes[attribute] = String(value)
    }

    const align = node.attrs[ALIGN_ATTR] as string | null
    if (align) attributes.style = `text-align: ${align}`

    return [tag, attributes, 0]
  }
}

/** 汇总所有表格节点名，便于上层判断与遍历。 */
export const TABLE_NODE_NAMES = Object.keys(tableNodeSpecs)

/**
 * 单元格是否为表头。
 *
 * prosemirror-tables 用节点类型区分（`table_header` vs `table_cell`），
 * 而 markdown 用"是不是第一行"区分。转换时需要双向映射。
 */
export function isHeaderCellType(name: string): boolean {
  return name === 'table_header'
}

/** 单元格对齐方式。markdown 用 `:---` / `:--:` / `---:` 表达。 */
export type ColumnAlignment = 'left' | 'center' | 'right' | 'default'

export const ALIGNMENT_MARKERS: Record<ColumnAlignment, string> = {
  left: ':---',
  center: ':--:',
  right: '---:',
  default: '---'
}

export function alignmentMarker(alignment: ColumnAlignment, width: number): string {
  const base = ALIGNMENT_MARKERS[alignment]
  if (base.length >= width) return base
  // 补足到列宽，使源文件里的表格在等宽字体下对齐
  return alignment === 'center'
    ? `:${'-'.repeat(width - 2)}:`
    : alignment === 'left'
      ? `:${'-'.repeat(width - 1)}`
      : alignment === 'right'
        ? `${'-'.repeat(width - 1)}:`
        : '-'.repeat(width)
}

/** 从对齐标记解析对齐方式。 */
export function parseAlignment(marker: string): ColumnAlignment {
  const trimmed = marker.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return 'default'
}

/* ------------------------------------------------------------------ *
 * Markdown 管道表解析 / 序列化
 * ------------------------------------------------------------------ */

export interface ParsedTable {
  /** 首行为表头 */
  header: string[]
  alignments: ColumnAlignment[]
  rows: string[][]
}

/**
 * 判断一行是否为表格分隔行（`| --- | :--: |`）。
 *
 * 必须严格匹配：只有短横线与冒号是合法字符，且至少三个短横线。
 * 放宽这个判断会把普通文本误吞成表格。
 */
export function isDelimiterRow(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  if (!trimmed.includes('-')) return false

  const cells = splitTableRow(trimmed)
  if (cells.length === 0) return false

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

/**
 * 拆分管道表的一行。
 *
 * 处理两种容易做错的情况：
 *  - 首尾的 `|` 是可选的，且不代表空单元格
 *  - `\|` 是转义的管道符，不能作为分隔符
 */
export function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let escaped = false

  for (const character of trimmed) {
    if (escaped) {
      // 转义管道还原为普通字符，但保留反斜杠以便往返时再转义回去
      current += character === '|' ? '\\|' : `\\${character}`
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }

  if (escaped) current += '\\'
  cells.push(current.trim())
  return cells
}

/** 单元格内容中的管道符必须转义，否则会与列分隔符冲突。 */
export function escapeCellContent(text: string): string {
  return text.replace(/(?<!\\)\|/g, '\\|').replace(/\n+/g, ' ')
}

/** 从 markdown 行数组中解析出连续表格；返回 null 表示当前位置不是表格。 */
export function parseTableAt(lines: string[], start: number): { table: ParsedTable; end: number } | null {
  if (start + 1 >= lines.length) return null

  const headerLine = lines[start]
  const delimiterLine = lines[start + 1]

  if (!headerLine.includes('|')) return null
  if (!isDelimiterRow(delimiterLine)) return null

  const header = splitTableRow(headerLine)
  const alignments = splitTableRow(delimiterLine).map(parseAlignment)
  if (header.length === 0) return null

  const rows: string[][] = []
  let cursor = start + 2

  while (cursor < lines.length) {
    const line = lines[cursor]
    // 空行或不再含管道符即表格结束
    if (line.trim().length === 0 || !line.includes('|')) break
    // 分隔行不会连续出现；出现说明是另一张表
    if (isDelimiterRow(line)) break

    rows.push(splitTableRow(line))
    cursor += 1
  }

  return { table: { header, alignments, rows }, end: cursor }
}

/**
 * 序列化为 markdown 管道表。
 *
 * 列宽按内容取最大值，使源文件在等宽字体下自然对齐——
 * 这是 Typora 等编辑器的既有习惯，用户会按对齐状态阅读源文件。
 */
export function serializeTable(table: ParsedTable): string {
  const columnCount = Math.max(
    table.header.length,
    ...table.rows.map((row) => row.length),
    table.alignments.length
  )

  const normalized = {
    header: padRow(table.header, columnCount),
    rows: table.rows.map((row) => padRow(row, columnCount)),
    alignments: padAlignments(table.alignments, columnCount)
  }

  const widths: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    const candidates = [
      normalized.header[column].length,
      ...normalized.rows.map((row) => row[column].length),
      ALIGNMENT_MARKERS[normalized.alignments[column]].length
    ]
    widths.push(Math.max(...candidates, 3))
  }

  const renderRow = (cells: string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`

  const lines = [
    renderRow(normalized.header),
    `| ${normalized.alignments
      .map((alignment, index) => alignmentMarker(alignment, widths[index]))
      .join(' | ')} |`,
    ...normalized.rows.map(renderRow)
  ]

  return lines.join('\n')
}

function padRow(row: string[], columnCount: number): string[] {
  const padded = [...row]
  while (padded.length < columnCount) padded.push('')
  return padded.slice(0, columnCount)
}

function padAlignments(alignments: ColumnAlignment[], columnCount: number): ColumnAlignment[] {
  const padded = [...alignments]
  while (padded.length < columnCount) padded.push('default')
  return padded.slice(0, columnCount)
}
