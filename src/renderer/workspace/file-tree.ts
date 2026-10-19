import type { FileTreeNode, WorkspaceTree } from '../../shared/ipc'
import { messages } from '../../shared/i18n'

/**
 * 工作区文件树。
 *
 * 交互取舍：
 *  - 展开状态与数据分离（`expanded` 是路径集合）：刷新树时保留用户展开的目录，
 *    否则每次 fs.watch 触发刷新都会把树折叠回去，体验上无法忍受
 *  - 重命名/新建用**内联输入行**而非 `window.prompt`：Electron 下 prompt 不可用，
 *    且内联输入不会打断上下文
 *  - 删除走原生确认框（由渲染层调用方负责），因为它是破坏性操作
 */

export interface FileTreeCallbacks {
  onOpenFile(filePath: string): void
  onCreateFile(parentDirectory: string, name: string): Promise<void>
  onCreateDirectory(parentDirectory: string, name: string): Promise<void>
  onRename(targetPath: string, name: string): Promise<void>
  onDelete(targetPath: string): Promise<void>
  onError(message: string): void
}

export interface FileTreeView {
  /** 语言切换后重绘自绘文案（空状态不在 data-i18n 标注体系里）。 */
  refreshLocaleText(): void
  render(tree: WorkspaceTree): void
  setActiveFile(filePath: string | null): void
  revealPath(filePath: string): void
  destroy(): void
}

type PendingAction =
  | { kind: 'create-file'; parentDirectory: string }
  | { kind: 'create-directory'; parentDirectory: string }
  | { kind: 'rename'; targetPath: string; isDirectory: boolean }

const SVG_NS = 'http://www.w3.org/2000/svg'

type TreeIconKind = 'folder' | 'folder-open' | 'file' | 'view'

/**
 * 树图标用 SVG 描边几何（24×24，渲染尺寸交给 CSS），不用字符：
 * 字符图标随字体变化宽度与基线不稳，且文件夹与文件仅靠字重区分太弱。
 */
const TREE_ICON_PATHS: Record<TreeIconKind, readonly string[]> = {
  folder: [
    'M3 6.6A2.6 2.6 0 0 1 5.6 4h2.9a2.6 2.6 0 0 1 2.03.98l.86 1.07a1 1 0 0 0 .78.37h6.23A2.6 2.6 0 0 1 21 9.02v8.38A2.6 2.6 0 0 1 18.4 20H5.6A2.6 2.6 0 0 1 3 17.4Z'
  ],
  'folder-open': [
    'M3 9.4V6.6A2.6 2.6 0 0 1 5.6 4h2.9a2.6 2.6 0 0 1 2.03.98l.86 1.07a1 1 0 0 0 .78.37h6.23A2.6 2.6 0 0 1 21 9.02v1.1',
    'M6.6 10.6h13.1a1.7 1.7 0 0 1 1.65 2.12l-1.32 5.2A2.6 2.6 0 0 1 17.51 20H3.9a1.7 1.7 0 0 1-1.65-2.12l1.32-5.2A2.6 2.6 0 0 1 6.09 10.6Z'
  ],
  file: [
    'M6.6 3.5h6.6a2 2 0 0 1 1.42.59l3.79 3.79a2 2 0 0 1 .59 1.42v9.6a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2v-13.4a2 2 0 0 1 2-2Z',
    'M13.4 3.7v4.4a1.2 1.2 0 0 0 1.2 1.2h4.2',
    'M8.6 13.2h6.8M8.6 16.6h4.6'
  ],
  // 只读查看对象（PDF / HTML / 图片）：文档轮廓里放一个"图片"符号，
  // 与文本文件的横线区分开——它打开后可编辑区不会出现光标
  view: [
    'M6.6 3.5h6.6a2 2 0 0 1 1.42.59l3.79 3.79a2 2 0 0 1 .59 1.42v9.6a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2v-13.4a2 2 0 0 1 2-2Z',
    'M13.4 3.7v4.4a1.2 1.2 0 0 0 1.2 1.2h4.2',
    'M8.5 16.9l2.4-2.8 1.6 1.9 1.4-1.6 1.9 2.5'
  ]
}

function buildIcon(kind: TreeIconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('tree-icon', `tree-icon--${kind}`)
  for (const d of TREE_ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/**
 * 该节点用哪个图标。
 *
 * 只读查看对象（PDF / HTML / 图片）用独立字形：它能打开，但打开后没有光标，
 * 与可编辑文本区分开比"都叫文件"更诚实。
 */
function iconKindFor(node: FileTreeNode, isExpanded: boolean): TreeIconKind {
  if (node.isDirectory) return isExpanded ? 'folder-open' : 'folder'
  if (node.isViewable && !node.isText) return 'view'
  return 'file'
}

export function createFileTreeView(
  host: HTMLElement,
  callbacks: FileTreeCallbacks
): FileTreeView {
  const expanded = new Set<string>()
  const list = document.createElement('div')
  list.className = 'tree-list'

  /**
   * 空状态。
   *
   * 文案必须与路径栏区分开：两者都写"未打开文件夹"时，
   * 面板里会同时出现两行一模一样的字，看起来像渲染重复的 bug。
   * 因此这里承担"告诉用户怎么开始"的职责，而不是重复陈述状态。
   */
  const emptyState = document.createElement('div')
  emptyState.className = 'tree-empty'

  const emptyTitle = document.createElement('span')
  const emptyHint = document.createElement('span')
  emptyHint.className = 'tree-empty__hint'
  emptyState.append(emptyTitle, emptyHint)

  const applyEmptyText = (): void => {
    const t = messages().panel
    emptyTitle.textContent = t.noWorkspace
    emptyHint.textContent = t.noWorkspaceHint
  }
  applyEmptyText()

  host.replaceChildren(list, emptyState)

  let root: FileTreeNode | null = null
  let activeFile: string | null = null
  let pending: PendingAction | null = null
  /** 待处理输入行是否已就地插入（未插入时回退到列表末尾）。 */
  let pendingPlaced = false

  function render(): void {
    emptyState.hidden = root !== null
    // 每次重绘都重置：就地放置发生在 renderNode 内部
    pendingPlaced = false
    list.replaceChildren()

    if (!root) return

    const fragment = document.createDocumentFragment()
    for (const child of root.children ?? []) {
      renderNode(child, 0, fragment)
    }

    /**
     * 待处理输入行由 `renderNode` 就地插入——新建行落在**目标文件夹的子项之后**，
     * 重命名行落在目标项之后。
     *
     * 这里只做兜底：若锚点没被渲染出来（例如目标文件夹恰好被折叠、
     * 或节点在刷新后已不存在），仍把输入行放到末尾，
     * 否则用户点了"新建"却看不到任何反应。
     */
    list.replaceChildren(fragment)

    if (pending && !pendingPlaced) {
      list.appendChild(buildPendingRow(pending, 0))
    }
  }

  function renderNode(node: FileTreeNode, depth: number, parent: Node): void {
    const isExpanded = expanded.has(node.path)

    const row = document.createElement('div')
    row.className = 'tree-row'
    // 缩进通过 CSS 变量表达：单处设置，避免 depth 相关的样式散落在选择器里
    row.style.setProperty('--tree-depth', String(depth))
    if (!node.isDirectory && node.path === activeFile) row.classList.add('is-active')
    // 置灰只留给"打不开"的文件：只读查看对象（PDF / HTML / 图片）能打开，
    // 只是不能编辑，靠图标形态区分而不是靠变灰
    if (!node.isDirectory && !node.isText && !node.isViewable) row.classList.add('is-muted')

    const label = document.createElement('button')
    label.type = 'button'
    label.className = 'tree-label'
    label.title = node.path

    const name = document.createElement('span')
    name.className = 'tree-label__name'
    name.textContent = node.name
    label.append(buildIcon(iconKindFor(node, isExpanded)), name)

    // 展开状态由文件夹图标的开口/闭合形态表达，不再另设展开三角：
    // 9px 的三角字符渲染出来只是一个黑点，反而像脏像素
    if (node.isDirectory) {
      label.addEventListener('click', () => toggleDirectory(node.path))
    } else {
      label.addEventListener('click', () => callbacks.onOpenFile(node.path))
    }

    row.append(label, buildRowActions(node))
    parent.appendChild(row)

    /**
     * 重命名：输入行紧跟在被重命名的项之后。
     *
     * 原先所有待处理行都被追加到**整棵树末尾**，于是给中段文件夹新建文件时，
     * 输入行出现在列表最下方（往往还在视口之外），用户看不到任何反应。
     */
    if (pending?.kind === 'rename' && pending.targetPath === node.path) {
      parent.appendChild(buildPendingRow(pending, depth))
      pendingPlaced = true
      return
    }

    if (node.isDirectory && isExpanded) {
      for (const child of node.children ?? []) renderNode(child, depth + 1, parent)

      /**
       * 新建：输入行落在**该文件夹子项之后**，缩进比文件夹本身深一级。
       *
       * 这正是用户的预期位置——"在当前文件夹的最下面"。
       */
      if (
        pending &&
        pending.kind !== 'rename' &&
        pending.parentDirectory === node.path
      ) {
        parent.appendChild(buildPendingRow(pending, depth + 1))
        pendingPlaced = true
      }
    }
  }

  function buildRowActions(node: FileTreeNode): HTMLElement {
    const actions = document.createElement('span')
    actions.className = 'tree-actions'

    const makeButton = (label: string, title: string, handler: () => void): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tree-action'
      button.textContent = label
      button.title = title
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        handler()
      })
      return button
    }

    if (node.isDirectory) {
      actions.append(
        makeButton('+', '在此新建文件', () => {
          expanded.add(node.path)
          pending = { kind: 'create-file', parentDirectory: node.path }
          render()
        }),
        makeButton('⊞', '在此新建文件夹', () => {
          expanded.add(node.path)
          pending = { kind: 'create-directory', parentDirectory: node.path }
          render()
        })
      )
    }

    actions.append(
      makeButton('✎', '重命名', () => {
        pending = { kind: 'rename', targetPath: node.path, isDirectory: node.isDirectory }
        render()
      }),
      makeButton('✕', '删除', () => void callbacks.onDelete(node.path))
    )

    return actions
  }

  function buildPendingRow(action: PendingAction, depth: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tree-row tree-row--pending'
    // 与普通行共用同一套缩进机制，否则新建行会贴着最左侧，看不出属于哪个文件夹
    row.style.setProperty('--tree-depth', String(depth))

    const label = document.createElement('span')
    label.className = 'tree-pending-label'
    label.textContent =
      action.kind === 'rename' ? '重命名为' : action.kind === 'create-file' ? '新建文件' : '新建文件夹'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'tree-input'
    if (action.kind === 'rename') {
      input.value = action.targetPath.split(/[\\/]/).pop() ?? ''
    } else {
      input.value =
        action.kind === 'create-file'
          ? messages().panel.newFileName
          : messages().panel.newFolderName
    }

    const commit = async (): Promise<void> => {
      const name = input.value.trim()
      if (name.length === 0) {
        pending = null
        render()
        return
      }
      // 含路径分隔符的名字会写到预期之外的位置，直接拒绝
      if (name.includes('/') || name.includes('\\')) {
        callbacks.onError('名称不能包含路径分隔符')
        return
      }

      pending = null
      try {
        if (action.kind === 'create-file') {
          await callbacks.onCreateFile(action.parentDirectory, name)
        } else if (action.kind === 'create-directory') {
          await callbacks.onCreateDirectory(action.parentDirectory, name)
        } else {
          await callbacks.onRename(action.targetPath, name)
        }
      } catch (error) {
        callbacks.onError(error instanceof Error ? error.message : String(error))
      }
      render()
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void commit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        pending = null
        render()
      }
    })
    // 失焦即取消：避免输入行悬挂在树上造成误解
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (pending === action) {
          pending = null
          render()
        }
      }, 120)
    })

    row.append(label, input)
    queueMicrotask(() => {
      input.focus()
      input.select()
      /**
       * 必须主动滚入视口。
       *
       * 目标文件夹可能位于列表下方（文件树通常比侧栏高），
       * 只插入而不滚动，用户仍然看不到输入行——与"点了没反应"无异。
       * 用 `block: 'nearest'` 以最小幅度滚动，避免整棵树跳动。
       */
      row.scrollIntoView({ block: 'nearest' })
    })
    return row
  }

  function toggleDirectory(path: string): void {
    if (expanded.has(path)) expanded.delete(path)
    else expanded.add(path)
    render()
  }

  /**
   * 展开目标文件的所有祖先目录，使其在树中可见。
   *
   * 用"从文件路径逐级向上、遇到根目录为止"的方式计算祖先，
   * 而不是按路径段下标切片——后者依赖根目录名恰好出现在路径中，
   * 根名与实际目录名不一致时会算错。
   */
  function revealPath(filePath: string): void {
    if (!root) return

    const rootPath = root.path.replace(/[\\/]+$/, '')
    let cursor = filePath.replace(/[\\/]+$/, '')

    // 最多向上展开 64 层，防御异常输入造成的死循环
    for (let guard = 0; guard < 64; guard += 1) {
      const separatorIndex = Math.max(cursor.lastIndexOf('/'), cursor.lastIndexOf('\\'))
      if (separatorIndex <= 0) break

      cursor = cursor.slice(0, separatorIndex)
      if (cursor.length < rootPath.length) break

      expanded.add(cursor)
      if (cursor === rootPath) break
    }

    render()
  }

  return {
    /** 语言切换后重绘自绘文案（空状态不在 data-i18n 标注体系里）。 */
    refreshLocaleText(): void {
      applyEmptyText()
    },
    render(tree: WorkspaceTree): void {
      // 语言可能在运行中切换，空状态文案需随之更新
      applyEmptyText()
      root = tree.root
      // 首次加载默认展开根目录，避免用户面对一棵完全折叠的树
      if (expanded.size === 0) expanded.add(tree.root.path)
      render()
    },
    setActiveFile(filePath: string | null): void {
      if (activeFile === filePath) return
      activeFile = filePath
      render()
    },
    revealPath,
    destroy(): void {
      host.replaceChildren()
    }
  }
}
