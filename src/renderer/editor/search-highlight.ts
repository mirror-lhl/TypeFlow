import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

/**
 * 查找高亮。
 *
 * 为什么不用"设置选区"来显示匹配项——
 * ProseMirror 的 `selectionToDOM` 开头有这么一道守卫：
 *
 * ```js
 * function editorOwnsSelection(view) {
 *   return view.editable ? view.hasFocus() : ...
 * }
 * ```
 *
 * 查找框持有焦点时 `view.hasFocus()` 为 false，于是 **ProseMirror 拒绝把选区
 * 写入 DOM**，既没有高亮也不会滚动到匹配处。这是它的设计约束，不是能绕开的 bug：
 * 焦点同时只能在一处，而要支持"边输入边看结果"就必须让焦点留在输入框。
 *
 * 因此改用**装饰器**：装饰器是纯渲染层面的标注，与焦点、选区完全无关，
 * 天然不受该守卫影响。这也是成熟编辑器的通用做法。
 *
 * 附带的好处：可以同时高亮**所有**匹配项，并把当前项区分出来，
 * 而选区只能表达一个位置。
 */

export interface HighlightRange {
  from: number
  to: number
}

export interface SearchHighlightState {
  /** 查找框的全部匹配区间（文档位置） */
  matches: readonly HighlightRange[]
  /** 当前匹配项下标；-1 表示无 */
  currentIndex: number
  /**
   * "跳转到此处"的标记。
   *
   * 与查找匹配分开表达：两者的语义与生命周期不同——
   * 查找匹配随查找框关闭而清除，定位标记则源于一次性的跳转动作
   * （例如点击工作区搜索结果），需要在跳转后持续可见。
   *
   * 用装饰器而非 DOM 选区来表现它，原因见文件头：
   * 选区在"视图未聚焦"与"NodeView 重建 DOM"两种情况下都会被吞掉，
   * 装饰器与这两者都无关。
   */
  locator: HighlightRange | null
}

export const searchHighlightKey = new PluginKey<SearchHighlightState>('typeflow-search-highlight')

const EMPTY: SearchHighlightState = { matches: [], currentIndex: -1, locator: null }

export function searchHighlightPlugin(): Plugin<SearchHighlightState> {
  return new Plugin<SearchHighlightState>({
    key: searchHighlightKey,

    state: {
      init: () => EMPTY,

      apply(transaction, previous) {
        const next = transaction.getMeta(searchHighlightKey) as
          | Partial<SearchHighlightState>
          | undefined

        // 局部更新：调用方只传自己关心的字段，其余保持
        if (next) return { ...previous, ...next }

        /**
         * 文档被编辑时立即清空高亮。
         *
         * 匹配区间是按旧文档位置算出来的，文档一变这些位置就失效了——
         * 继续渲染会画出错位的高亮，比不高亮更糟。
         * 查找方会在下一次输入时重新计算。
         */
        if (transaction.docChanged) return EMPTY

        return previous
      }
    },

    props: {
      decorations(state) {
        const value = searchHighlightKey.getState(state)
        if (!value) return null
        if (value.matches.length === 0 && value.locator === null) return null

        return buildDecorations(state.doc, value)
      }
    }
  })
}

/**
 * 构造装饰器集合。
 *
 * 位置必须夹在文档范围内：匹配区间是按 markdown 偏移换算来的，
 * 文档规模变化时可能越界，而 `Decoration.inline` 收到非法区间会抛错。
 */
function buildDecorations(doc: PMNode, value: SearchHighlightState): DecorationSet | null {
  const limit = doc.content.size
  const decorations: Decoration[] = []

  for (const [index, match] of value.matches.entries()) {
    const from = Math.max(0, Math.min(match.from, limit))
    const to = Math.max(from, Math.min(match.to, limit))
    if (to <= from) continue

    decorations.push(
      Decoration.inline(from, to, {
        class: index === value.currentIndex ? 'search-hit search-hit--current' : 'search-hit'
      })
    )
  }

  if (value.locator) {
    const from = Math.max(0, Math.min(value.locator.from, limit))
    const to = Math.max(from, Math.min(value.locator.to, limit))
    if (to > from) {
      decorations.push(Decoration.inline(from, to, { class: 'search-locator' }))
    }
  }

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : null
}

/* ------------------------------------------------------------------ *
 * 滚动
 * ------------------------------------------------------------------ */

/**
 * 把指定文档位置滚动到视口中。
 *
 * 不用 `tr.scrollIntoView()`：那条路径依赖 DOM 选区已被写入
 * （见文件头的说明），而我们在查找场景下无法写入选区。
 *
 * 改用 `coordsAtPos` 直接取坐标——它基于 DOM 布局计算，
 * 与"谁是焦点"无关，因此在这里是可靠的。
 */
/** 最近一次滚动的诊断信息，供自检定位问题（渲染层 console 不可见于终端）。 */
export interface ScrollDiagnostics {
  coordsTop: number | null
  scrollerClass: string | null
  scrollHeight: number
  clientHeight: number
  offset: number
  appliedScrollTop: number
  error: string | null
}

let lastScrollDiagnostics: ScrollDiagnostics | null = null

export function getLastScrollDiagnostics(): ScrollDiagnostics | null {
  return lastScrollDiagnostics
}

export function scrollPositionIntoView(view: EditorView, position: number): void {
  try {
    const clamped = Math.max(0, Math.min(position, view.state.doc.content.size))
    const coords = view.coordsAtPos(clamped)
    const scroller = findScrollContainer(view.dom)

    if (!scroller) {
      lastScrollDiagnostics = {
        coordsTop: coords.top,
        scrollerClass: null,
        scrollHeight: 0,
        clientHeight: 0,
        offset: 0,
        appliedScrollTop: 0,
        error: '未找到可滚动祖先'
      }
      return
    }

    const scrollerRect = scroller.getBoundingClientRect()
    // 目标在滚动内容中的绝对偏移
    const offset = coords.top - scrollerRect.top + scroller.scrollTop
    // 放在视口上方三分之一处：比居中更容易看到上下文
    const applied = Math.max(0, offset - scroller.clientHeight / 3)
    scroller.scrollTop = applied

    lastScrollDiagnostics = {
      coordsTop: coords.top,
      scrollerClass: scroller.className,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      offset,
      appliedScrollTop: applied,
      error: null
    }
  } catch (error) {
    lastScrollDiagnostics = {
      coordsTop: null,
      scrollerClass: null,
      scrollHeight: 0,
      clientHeight: 0,
      offset: 0,
      appliedScrollTop: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 向上找真正可滚动的祖先。
 *
 * 不写死 `.wysiwyg-host`：滚动容器属于布局细节，
 * 硬编码会在布局调整后静默失效（滚动没反应，但没有任何报错）。
 */
function findScrollContainer(from: HTMLElement): HTMLElement | null {
  let cursor: HTMLElement | null = from.parentElement

  while (cursor) {
    const overflowY = getComputedStyle(cursor).overflowY
    const scrollable = overflowY === 'auto' || overflowY === 'scroll'
    if (scrollable && cursor.scrollHeight > cursor.clientHeight + 1) return cursor
    cursor = cursor.parentElement
  }

  return null
}
