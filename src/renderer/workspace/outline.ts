import type { Node as PMNode } from 'prosemirror-model'
import { nodes } from '../editor/schema'
import { markdownToDocument } from '../editor/markdown'
import { messages } from '../../shared/i18n'

/**
 * 文档大纲。
 *
 * 复用 L1 已充分验证的 `markdownToDocument`，而不是另写一套 markdown 行解析——
 * 第二套解析逻辑必然与内核产生分歧（缩进规则、代码块围栏嵌套等），
 * 最终表现为"大纲条目与文档内容对不上"，且极难排查。
 */

export interface OutlineItem {
  level: number
  text: string
  /** 文档内位置（ProseMirror 坐标），可直接用于定位光标 */
  position: number
  /** 从标题文本生成的稳定锚点 id */
  id: string
}

const MAX_TITLE_LENGTH = 120

function collectHeadings(doc: PMNode): OutlineItem[] {
  const items: OutlineItem[] = []
  let sequence = 0

  doc.descendants((node, position) => {
    if (node.type !== nodes.heading) return true

    sequence += 1
    const text = node.textContent.trim()
    items.push({
      level: node.attrs.level as number,
      text: text.length > 0 ? text.slice(0, MAX_TITLE_LENGTH) : messages().panel.emptyHeading,
      // +1 进入标题节点内部，用于放置光标
      position: position + 1,
      id: `outline-${sequence}`
    })
    return true
  })

  return items
}

export function buildOutline(markdown: string): OutlineItem[] {
  try {
    return collectHeadings(markdownToDocument(markdown))
  } catch {
    // 解析失败时返回空大纲而不是抛错：大纲是辅助视图，不该阻断编辑
    return []
  }
}

export interface OutlineView {
  /** 语言切换后刷新自绘文案（空状态不在 data-i18n 标注体系里） */
  refreshLocaleText(): void
  render(items: OutlineItem[], activeIndex: number | null): void
  setActiveIndex(index: number | null): void
  destroy(): void
}

export function createOutlineView(
  host: HTMLElement,
  onSelect: (item: OutlineItem) => void
): OutlineView {
  let items: OutlineItem[] = []
  let activeIndex: number | null = null

  const emptyState = document.createElement('p')
  emptyState.className = 'panel-empty'
  emptyState.textContent = messages().panel.noHeadings

  /**
   * 语言切换后刷新自绘文案。
   *
   * 空状态在模块初始化时取一次 `messages()`，之后语言变了也不会更新；
   * 它不在 `data-i18n` 标注体系里（由模块自绘），必须显式重取。
   */
  const refreshLocaleText = (): void => {
    emptyState.textContent = messages().panel.noHeadings
  }

  const list = document.createElement('div')
  list.className = 'outline-list'

  host.replaceChildren(list, emptyState)

  function paintActive(): void {
    const buttons = list.querySelectorAll<HTMLButtonElement>('.outline-item')
    buttons.forEach((button, index) => {
      button.classList.toggle('is-active', index === activeIndex)
    })
  }

  function render(nextItems: OutlineItem[], nextActiveIndex: number | null): void {
    items = nextItems
    activeIndex = nextActiveIndex
    emptyState.hidden = items.length > 0

    // 用缩进表达层级而非嵌套 div：标题层级可能跳级（h1 直接到 h3），
    // 嵌套结构在这种输入下会产生视觉断层
    const fragment = document.createDocumentFragment()
    for (const [index, item] of items.entries()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `outline-item outline-item--l${Math.min(item.level, 6)}`
      button.style.setProperty('--outline-depth', String(Math.max(0, item.level - 1)))
      button.textContent = item.text
      button.title = item.text
      button.addEventListener('click', () => onSelect(item))
      if (index === activeIndex) button.classList.add('is-active')
      fragment.appendChild(button)
    }
    list.replaceChildren(fragment)
  }

  return {
    refreshLocaleText,
    render,
    setActiveIndex(index: number | null): void {
      activeIndex = index
      paintActive()
    },
    destroy(): void {
      host.replaceChildren()
    }
  }
}

/**
 * 根据光标位置推断当前所处的标题条目。
 *
 * 取"位置不大于光标的最后一个标题"：这正是用户直觉上的"我在哪一节"。
 */
export function activeOutlineIndex(items: OutlineItem[], cursorPosition: number): number | null {
  let result: number | null = null
  for (const [index, item] of items.entries()) {
    if (item.position <= cursorPosition) result = index
    else break
  }
  return result
}
