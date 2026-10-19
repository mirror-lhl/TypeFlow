/**
 * 代码块回退键复现。
 *
 * 背景：代码块内的**单字符删除不由 ProseMirror 的命令处理**——
 * 键映射返回 false 后交给浏览器原生 contenteditable 删除，
 * 然后由 DOM 观察器把变化同步回文档模型。
 *
 * 因此问题几乎一定出在"从 DOM 变化读回文档"这一段，
 * 而代码块的 NodeView 恰好重写了 `ignoreMutation`（高亮染色的需要）。
 *
 * 本脚本直接模拟浏览器删掉一个字符（改 DOM 文本节点），
 * 然后看文档模型是否同步——这能决定性地区分
 * "键被吞了" 与 "DOM 变化被忽略了"。
 *
 * 用法：node scripts/probe-code-backspace.mjs
 */
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/* ---------- 真实 DOM 环境 ---------- */
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true
})
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true
})
globalThis.getSelection = dom.window.getSelection.bind(dom.window)
// ProseMirror 的 DOMObserver 用 getComputedStyle 判断"纯样式变化"，
// 缺少它会让 flush() 直接抛错，从而静默丢弃所有 DOM 变化
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.DOMParser = dom.window.DOMParser
for (const name of [
  'Node',
  'Element',
  'HTMLElement',
  'Text',
  'Range',
  'Event',
  'KeyboardEvent',
  'InputEvent',
  'MutationObserver',
  'DOMParser',
  'requestAnimationFrame',
  'cancelAnimationFrame'
]) {
  if (dom.window[name] !== undefined) globalThis[name] = dom.window[name]
}

/* ---------- 打包编辑器 ---------- */
const workdir = await mkdtemp(join(tmpdir(), 'typeflow-bs-'))
const outfile = join(workdir, 'bundle.cjs')
await build({
  stdin: {
    contents: `
      export { createMarkdownEditor, cursorToStart } from '${join(ROOT, 'src/renderer/editor/index.ts')}'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile,
  logLevel: 'error'
})
const mod = createRequire(import.meta.url)(outfile)

const host = document.getElementById('host')
const editor = mod.createMarkdownEditor(host, {})

const waitFrame = () => new Promise((r) => setTimeout(() => r(undefined), 20))

/* ---------- 场景 1：DOM 原生删除是否能同步回文档 ---------- */
console.log('=== 场景 1：DOM 原生删除一个字符 ===')
editor.setMarkdown('```java\n1111\n```')
await waitFrame()
await waitFrame()

const before = editor.getMarkdown()
console.log('初始 markdown:', JSON.stringify(before))

const codeEl = host.querySelector('.code-block__code')
console.log('code 元素:', codeEl ? '存在' : '缺失')
console.log('code innerHTML:', JSON.stringify(codeEl?.innerHTML ?? ''))

/**
 * 模拟浏览器删除最后一个字符。
 *
 * 浏览器会直接改文本节点的 data（characterData 变化），
 * 若被删空还会移除包裹它的 span（childList 变化）。
 * 这里两种都触发，尽量贴近真实行为。
 */
function simulateBrowserDeleteLastChar() {
  const textNodes = []
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 && (child.data ?? '').length > 0) textNodes.push(child)
      else walk(child)
    }
  }
  walk(codeEl)

  const last = textNodes[textNodes.length - 1]
  if (!last) {
    console.log('  ✗ 没有可删除的文本节点')
    return
  }

  last.data = last.data.slice(0, -1)
  console.log(`  已把文本节点 "${last.data + 'x'}" 改为 "${last.data}"`)

  if (last.data.length === 0) last.parentNode?.removeChild(last)
}

simulateBrowserDeleteLastChar()
await waitFrame()
await waitFrame()
await waitFrame()

const afterDom = editor.getMarkdown()
console.log('DOM 删除后 markdown:', JSON.stringify(afterDom))
console.log(
  afterDom !== before
    ? '  ✓ 文档模型已同步（DOM 观察正常）'
    : '  ✗ 文档模型未变化 → DOM 变化被忽略了'
)

/* ---------- 场景 2：键映射是否吞掉 Backspace ---------- */
console.log('\n=== 场景 2：Backspace 键映射行为 ===')

editor.setMarkdown('```java\n1111\n```')
await waitFrame()

// 把光标放到代码块内容末尾
const state = editor.state
const codeBlockEnd = (() => {
  let found = 0
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') found = pos + node.nodeSize - 1
    return true
  })
  return found
})()

editor.view.dispatch(
  state.tr.setSelection(
    (require_prosemirrorState().TextSelection).near(state.doc.resolve(codeBlockEnd))
  )
)
await waitFrame()

const { TextSelection } = require_prosemirrorState()
void TextSelection

const keyEvent = new dom.window.KeyboardEvent('keydown', {
  key: 'Backspace',
  code: 'Backspace',
  keyCode: 8,
  bubbles: true,
  cancelable: true
})

const handled = editor.view.someProp('handleKeyDown', (handler) =>
  handler(editor.view, keyEvent)
)

console.log('handleKeyDown 返回:', handled)
console.log('defaultPrevented:', keyEvent.defaultPrevented)
console.log(
  handled
    ? '  → ProseMirror 接管了 Backspace（浏览器不会原生删除）'
    : '  → 未接管，交由浏览器原生删除（符合单字符删除的预期路径）'
)

await rm(workdir, { recursive: true, force: true })

function require_prosemirrorState() {
  return createRequire(import.meta.url)(
    resolve(ROOT, 'node_modules/prosemirror-state/dist/index.cjs')
  )
}
