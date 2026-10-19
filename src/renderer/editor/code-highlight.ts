import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { computeHighlightRanges } from './code-languages'

/**
 * 代码块语法高亮（装饰器实现）。
 *
 * ## 为什么用装饰器而不是改写 NodeView 的 contentDOM
 *
 * 早期实现是让代码块 NodeView 重建 `contentDOM` 的子节点，把文本换成
 * 带 `hljs-*` 类名的 span。这个做法与 ProseMirror 的两套机制直接冲突，
 * 并且先后造成了三个缺陷：
 *
 * | 冲突对象 | 症状 |
 * |---|---|
 * | DOM 选区 | 承载选区的节点被销毁 → 选区被折叠并被观察器反向覆盖 state |
 * | 行内装饰器 | 装饰器 span 一并被销毁，且 `ignoreMutation`让 ProseMirror 不重绘 |
 * | 光标/IME | 每次重排都可能让输入法组合态中断 |
 *
 * 三个缺陷的根因是同一个：**NodeView 不该改写自己的 contentDOM**。
 * 装饰器由 ProseMirror 渲染在文本节点上，与选区、IME、其它装饰器天然共存，
 * 因此改用装饰器后这一整类问题消失。
 *
 * ## 性能
 *
 * 高亮是纯计算，每次文档变化都全量重算在大文档上会拖慢输入。
 * 因此用**按代码内容缓存**：内容与语言未变的代码块直接复用上次结果。
 * 缓存用 FIFO 淘汰并设上限，避免长时间编辑后无限增长。
 */

export const codeHighlightKey = new PluginKey<DecorationSet>('typeflow-code-highlight')

/** 缓存上限。超过后按插入顺序淘汰最早的条目。 */
const CACHE_LIMIT = 300

const rangeCache = new Map<string, ReturnType<typeof computeHighlightRanges>>()

function cachedRanges(code: string, language: string) {
  const key = `${language}\u0000${code}`

  const hit = rangeCache.get(key)
  if (hit) {
    // 重新插入以维持"最近使用"的顺序
    rangeCache.delete(key)
    rangeCache.set(key, hit)
    return hit
  }

  const ranges = computeHighlightRanges(code, language)
  rangeCache.set(key, ranges)

  if (rangeCache.size > CACHE_LIMIT) {
    const oldest = rangeCache.keys().next().value
    if (oldest !== undefined) rangeCache.delete(oldest)
  }

  return ranges
}

/**
 * 为文档中所有代码块构造装饰器。
 *
 * 位置换算：代码块节点从 `pos` 开始，其内容从 `pos + 1` 开始
 * （`pos` 处是节点本身，`pos + 1` 进入内容）。高亮区间是相对代码文本的
 * 字符偏移，因此要加上 `pos + 1`。
 */
function buildDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []

  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true

    const code = node.textContent
    if (code.length === 0) return true

    const language = String(node.attrs.params ?? '').trim()
    const contentStart = pos + 1

    for (const range of cachedRanges(code, language)) {
      decorations.push(
        Decoration.inline(contentStart + range.from, contentStart + range.to, {
          class: range.className
        })
      )
    }

    return true
  })

  return DecorationSet.create(doc, decorations)
}

export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,

    state: {
      init: (_config, state) => buildDecorations(state.doc),

      apply(transaction, previous) {
        // 文档没变就沿用旧装饰器——避免每次选区变化都重算全部高亮
        if (!transaction.docChanged) return previous
        return buildDecorations(transaction.doc)
      }
    },

    props: {
      decorations(state) {
        return codeHighlightKey.getState(state) ?? null
      }
    }
  })
}

/** 供自检确认缓存行为（内容未变时不应重新计算）。 */
export function codeHighlightCacheSize(): number {
  return rangeCache.size
}
