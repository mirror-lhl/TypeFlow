import {
  CellSelection,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  columnResizing,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  selectedRect,
  tableEditing,
  toggleHeaderRow
} from 'prosemirror-tables'
import { keymap } from 'prosemirror-keymap'
import type { Command, Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { schema } from './schema'

/**
 * 表格编辑能力。
 *
 * 复用 prosemirror-tables 的命令而非自写：增删行列要正确处理
 * `colspan`/`rowspan`、合并单元格边界、表头切换这些情况，
 * 自写几乎必然在这类边界上出错。
 *
 * 本文件只负责三件事：装配插件、提供键盘映射、导出一组可被工具栏与自检调用的命令。
 */

/**
 * 表格插件集合。
 *
 * `tableEditing` 提供单元格选择与方向键导航；
 * `columnResizing` 提供列宽拖拽（列宽存在 `colwidth` 属性里，
 * 不写入 markdown——管道表本身无法表达列宽，往返时自然丢弃）。
 */
export function buildTablePlugins(): Plugin[] {
  return [tableEditing(), columnResizing({ handleWidth: 4, cellMinWidth: 40 })]
}

/**
 * 表格键盘映射。
 *
 * Tab / Shift-Tab 在单元格间移动是表格编辑的基本预期；
 * `goToNextCell` 在最后一格按 Tab 会自动追加一行，
 * 这正是"填表时一路 Tab 到底"的手感。
 */
export function buildTableKeymap(): Plugin {
  return keymap({
    Tab: goToNextCell(1),
    'Shift-Tab': goToNextCell(-1)
  })
}

/* ------------------------------------------------------------------ *
 * 工具栏 / 自检用命令
 * ------------------------------------------------------------------ */

/** 仅在表格内可用的命令包装：避免菜单项在普通段落上误触发。 */
function whenInTable(command: Command): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) return false
    return command(state, dispatch, view)
  }
}

/**
 * 在光标处插入一张 3×2 的表格。
 *
 * 首行用 `table_header`，与 markdown 管道表"必有表头行"的约定一致——
 * 否则存盘后会凭空多出一行表头。
 */
export const insertTable: Command = (state, dispatch) => {
  const { $from } = state.selection

  // 表格必须作为块的直接子节点，不能嵌在段落里
  let depth = $from.depth
  while (depth > 0 && !$from.node(depth).isBlock) depth -= 1
  const insertAt = depth === 0 ? $from.pos : $from.after(depth)

  const columnCount = 3
  const headerCells = Array.from({ length: columnCount }, () => ({
    type: 'table_header',
    content: [{ type: 'paragraph' }]
  }))
  const bodyCells = Array.from({ length: columnCount }, () => ({
    type: 'table_cell',
    content: [{ type: 'paragraph' }]
  }))

  let table
  try {
    table = schema.nodeFromJSON({
      type: 'table',
      content: [
        { type: 'table_row', content: headerCells },
        { type: 'table_row', content: bodyCells }
      ]
    })
    table.check()
  } catch {
    return false
  }

  if (dispatch) {
    const transaction = state.tr.insert(insertAt, table)
    // 插入后把光标放进第一个单元格，用户可以立刻开始输入
    const firstCellStart = insertAt + 2
    transaction.setSelection(
      CellSelection.create(transaction.doc, firstCellStart, firstCellStart)
    )
    dispatch(transaction.scrollIntoView())
  }
  return true
}

/** 表格内当前行列信息，供工具栏展示与自检断言。 */
export function tableContext(state: import('prosemirror-state').EditorState): {
  inTable: boolean
  rows: number
  columns: number
  isHeaderRow: boolean
} {
  if (!isInTable(state)) return { inTable: false, rows: 0, columns: 0, isHeaderRow: false }

  try {
    const rect = selectedRect(state)
    return {
      inTable: true,
      rows: rect.map.height,
      columns: rect.map.width,
      isHeaderRow: rect.top === 0
    }
  } catch {
    return { inTable: true, rows: 0, columns: 0, isHeaderRow: false }
  }
}

/** 导出给工具栏使用的一组表格命令。 */
export const tableCommands = {
  insert: insertTable,
  addRowBefore: whenInTable(addRowBefore),
  addRowAfter: whenInTable(addRowAfter),
  addColumnBefore: whenInTable(addColumnBefore),
  addColumnAfter: whenInTable(addColumnAfter),
  deleteRow: whenInTable(deleteRow),
  deleteColumn: whenInTable(deleteColumn),
  deleteTable: whenInTable(deleteTable),
  toggleHeaderRow: whenInTable(toggleHeaderRow)
} as const

/** 当前是否处于表格内——工具栏据此切换按钮状态。 */
export function isSelectionInTable(view: EditorView): boolean {
  return isInTable(view.state)
}
