/**
 * 输入规则权威复现（不依赖 GUI）。
 *
 * 用途：把"逐字符键入 → 输入规则是否命中"这条链路放进真实 DOM 环境里跑，
 * 并逐步打印文档状态。应用内自检只能告诉终点对不对，
 * 这个脚本能看出**在哪一次按键上状态开始不对**。
 *
 * 用法：node scripts/probe-input-rules.mjs
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/* ---------- 1. 建立真实 DOM 环境 ---------- */
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true
})
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 起 globalThis.navigator 只有 getter，需用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true
})
globalThis.getSelection = dom.window.getSelection.bind(dom.window)
globalThis.Node = dom.window.Node
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Text = dom.window.Text
globalThis.Range = dom.window.Range
globalThis.Event = dom.window.Event
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.DOMParser = dom.window.DOMParser

/* ---------- 2. 打包编辑器模块（浏览器/ESM → CJS，内联 prosemirror） ---------- */
const workdir = await mkdtemp(join(tmpdir(), 'typeflow-probe-'))
const entry = join(workdir, 'entry.ts')
const outfile = join(workdir, 'bundle.cjs')

await build({
  stdin: {
    contents: `
      export { createMarkdownEditor, cursorToStart, getLastAutoInsertDiagnostics } from '${join(ROOT, 'src/renderer/editor/index.ts')}'
      export { documentToMarkdown } from '${join(ROOT, 'src/renderer/editor/markdown.ts')}'
      export { buildKeymap } from '${join(ROOT, 'src/renderer/editor/behavior.ts')}'
      export { schema } from '${join(ROOT, 'src/renderer/editor/schema.ts')}'
      export { createImageResolver, ImageNodeView, insertImageFiles } from '${join(ROOT, 'src/renderer/editor/image.ts')}'
      export { EditorState, TextSelection, NodeSelection } from 'prosemirror-state'
      export { history, closeHistory, undo, redo } from 'prosemirror-history'
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

const require_ = createRequire(import.meta.url)
const editorModule = require_(outfile)

/* ---------- 3. 逐字符键入并观察 ---------- */
const host = document.getElementById('host')
const editor = editorModule.createMarkdownEditor(host, {})
editorModule.cursorToStart(editor)

const TYPED = '**粗体**'
console.log(`逐字符键入: ${JSON.stringify(TYPED)}\n`)

editor.setMarkdown('')
editorModule.cursorToStart(editor)

for (let index = 0; index < TYPED.length; index += 1) {
  const character = TYPED[index]
  const before = editor.getMarkdown()
  const handled = editor.applyDefaultInput(character)

  if (!handled.ok) editor.insertText(character)

  const after = editor.getMarkdown()
  const selection = editor.state.selection
  console.log(
    `${String(index + 1).padStart(2)}. 键入 ${JSON.stringify(character)}  ` +
      `规则命中=${handled.ok ? 'Y' : 'N'}  ` +
      `文档 ${JSON.stringify(before)} → ${JSON.stringify(after)}  ` +
      `光标 ${selection.from}-${selection.to}  ` +
      `父偏移 ${selection.$from.parentOffset}`
  )
}

console.log('\n最终 markdown:', JSON.stringify(editor.getMarkdown()))
console.log('诊断:', JSON.stringify(editorModule.getLastAutoInsertDiagnostics()))

/* ---------- 4. 代码块高亮结构 ---------- */
// 染色被推迟到 DOM 同步之后，因此这里必须等一帧再检查
console.log('\n--- 代码块高亮 ---')
editor.setMarkdown('```ts\nconst answer: number = 42\n```')
await new Promise((resolve) => setTimeout(resolve, 0))

const codeEl = host.querySelector('.code-block__code')
const hljsSpans = host.querySelectorAll('.code-block__code [class^="hljs-"]')
console.log('code 元素存在:', codeEl !== null)
console.log('文本内容:', codeEl ? JSON.stringify(codeEl.textContent) : 'n/a')
console.log('hljs 着色 span 数量:', hljsSpans.length)

/* ---------- 5. Enter 键盘映射回归 ---------- */
// 通过实际键盘映射更新 EditorState，避免依赖 jsdom 不支持的光标几何测量。
const { schema, EditorState, TextSelection, NodeSelection, buildKeymap } = editorModule
const paragraph = (text = '') => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const quote = (...children) => schema.nodes.blockquote.create(null, children)
const doc = (...children) => schema.nodes.doc.create(null, children)
const item = (...children) => schema.nodes.list_item.create(null, children)
const keymapPlugin = buildKeymap(schema)

function keyboard(initialDoc, selection = TextSelection.atEnd(initialDoc)) {
  let state = EditorState.create({ doc: initialDoc, selection, plugins: [editorModule.history()] })
  const view = {
    get state() { return state },
    dispatch(transaction) { state = state.apply(transaction) }
  }
  return {
    get state() { return state },
    checkpoint() { view.dispatch(editorModule.closeHistory(state.tr)) },
    undo() { assert.equal(editorModule.undo(state, view.dispatch), true) },
    redo() { assert.equal(editorModule.redo(state, view.dispatch), true) },
    enter(shiftKey = false) {
      const event = new dom.window.KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, shiftKey
      })
      assert.equal(keymapPlugin.props.handleKeyDown(view, event), true, '回车应由键盘映射处理')
    }
  }
}

function expectDocument(keys, expected, depth) {
  assert.deepEqual(keys.state.doc.toJSON(), expected.toJSON())
  assert.equal(keys.state.selection.empty, true, '光标应保持折叠')
  assert.equal(keys.state.selection.$from.depth, depth, '光标应位于预期容器层级')
  assert.equal(keys.state.selection.$from.parent.type.name, 'paragraph')
  assert.equal(keys.state.selection.$from.parentOffset, 0, '光标应位于新段落开头')
}

console.log('\n--- Enter 键盘映射回归 ---')
try {
  const content = [paragraph('老铁，666'), paragraph('7777'), paragraph('1111')]
  const quoted = keyboard(doc(quote(...content)))
  quoted.enter()
  expectDocument(quoted, doc(quote(...content, paragraph())), 2)
  quoted.enter()
  expectDocument(quoted, doc(quote(...content), paragraph()), 1)
  assert.equal(quoted.state.selection.from, quoted.state.doc.content.size - 1)
  console.log('✓ 引用末尾首次回车续段，第二次回车退出，保留原内容并定位到下方')

  const emptyQuote = keyboard(doc(quote(paragraph())))
  emptyQuote.enter()
  expectDocument(emptyQuote, doc(paragraph()), 1)
  console.log('✓ 空引用直接回车退出')

  const followedDoc = doc(quote(paragraph('引用')), paragraph('后续正文'))
  const followed = keyboard(followedDoc, TextSelection.create(followedDoc, followedDoc.firstChild.nodeSize - 2))
  followed.enter()
  followed.enter()
  expectDocument(followed, doc(quote(paragraph('引用')), paragraph(), paragraph('后续正文')), 1)
  assert.equal(followed.state.selection.from, followed.state.doc.firstChild.nodeSize + 1)
  console.log('✓ 引用后已有正文时，在引用与正文之间退出')

  const nested = keyboard(doc(quote(quote(paragraph('内层引用')))))
  nested.enter()
  nested.enter()
  expectDocument(nested, doc(quote(quote(paragraph('内层引用')), paragraph())), 2)
  nested.enter()
  expectDocument(nested, doc(quote(quote(paragraph('内层引用'))), paragraph()), 1)
  console.log('✓ 嵌套引用逐层退出')

  const splitDoc = doc(quote(paragraph('前后')))
  const split = keyboard(splitDoc, TextSelection.create(splitDoc, 3))
  split.enter()
  expectDocument(split, doc(quote(paragraph('前'), paragraph('后'))), 2)
  console.log('✓ 引用文字中间回车仅分段，不退出引用')

  const soft = keyboard(doc(quote(paragraph('引用'))))
  soft.enter(true)
  assert.deepEqual(soft.state.doc.toJSON(), doc(quote(schema.nodes.paragraph.create(null, [
    schema.text('引用'), schema.nodes.hard_break.create()
  ]))).toJSON())
  assert.equal(soft.state.selection.$from.depth, 2)
  console.log('✓ Shift+Enter 保持引用内软换行')

  const plain = keyboard(doc(paragraph('正文')))
  plain.enter()
  expectDocument(plain, doc(paragraph('正文'), paragraph()), 1)
  const headingNode = schema.nodes.heading.create({ level: 2 }, schema.text('标题'))
  const heading = keyboard(doc(headingNode))
  heading.enter()
  expectDocument(heading, doc(headingNode, paragraph()), 1)
  console.log('✓ 正文正常分段，标题末尾回车转为正文')

  for (const listType of [schema.nodes.bullet_list, schema.nodes.ordered_list]) {
    const list = (...children) => listType.create(null, children)
    const keys = keyboard(doc(list(item(paragraph('列表项')))))
    keys.enter()
    expectDocument(keys, doc(list(item(paragraph('列表项')), item(paragraph()))), 3)
    keys.enter()
    expectDocument(keys, doc(list(item(paragraph('列表项'))), paragraph()), 1)
  }
  console.log('✓ 有序和无序列表首次回车续项，第二次回车退出')

  const codeNode = (text = '') => schema.nodes.code_block.create({ params: 'ts' }, text ? schema.text(text) : null)
  const codeBlock = codeNode('const n = 1')
  const code = keyboard(doc(codeBlock))
  code.enter()
  assert.deepEqual(code.state.doc.toJSON(), doc(codeNode('const n = 1\n')).toJSON())
  assert.equal(code.state.selection.$from.parent.type.name, 'code_block')
  code.checkpoint()
  code.enter()
  expectDocument(code, doc(codeBlock, paragraph()), 1)
  assert.equal(code.state.selection.from, code.state.doc.content.size - 1)
  code.undo()
  assert.deepEqual(code.state.doc.toJSON(), doc(codeNode('const n = 1\n')).toJSON())
  assert.equal(code.state.selection.$from.parent.type.name, 'code_block')
  code.redo()
  expectDocument(code, doc(codeBlock, paragraph()), 1)
  console.log('✓ 代码块末尾两次 Enter 退出，保留代码和语言，退出可撤销与重做')

  const codeFollowedDoc = doc(codeBlock, paragraph('后续正文'))
  const codeFollowed = keyboard(codeFollowedDoc, TextSelection.create(codeFollowedDoc, codeBlock.nodeSize - 1))
  codeFollowed.enter()
  codeFollowed.enter()
  expectDocument(codeFollowed, doc(codeBlock, paragraph(), paragraph('后续正文')), 1)
  assert.equal(codeFollowed.state.selection.from, codeBlock.nodeSize + 1)
  console.log('✓ 代码后已有正文时，在两者之间退出并定位')

  const nestedCode = keyboard(doc(quote(codeBlock)))
  nestedCode.enter()
  nestedCode.enter()
  expectDocument(nestedCode, doc(quote(codeBlock, paragraph())), 2)
  const listCode = keyboard(doc(schema.nodes.bullet_list.create(null, item(paragraph('列表'), codeBlock))))
  listCode.enter()
  listCode.enter()
  expectDocument(listCode, doc(schema.nodes.bullet_list.create(null, item(paragraph('列表'), codeBlock, paragraph()))), 3)
  console.log('✓ 嵌套代码退出后保留外层引用和列表结构')

  const middleDoc = doc(codeNode('第一行\n第二行'))
  const middleCode = keyboard(middleDoc, TextSelection.create(middleDoc, 4))
  middleCode.enter()
  middleCode.enter()
  assert.deepEqual(middleCode.state.doc.toJSON(), doc(codeNode('第一行\n\n\n第二行')).toJSON())
  assert.equal(middleCode.state.selection.$from.parent.type.name, 'code_block')
  console.log('✓ 代码中间连续 Enter 保持块内换行')

  const softCode = keyboard(doc(codeBlock))
  softCode.enter()
  softCode.enter(true)
  softCode.enter(true)
  assert.deepEqual(softCode.state.doc.toJSON(), doc(codeNode('const n = 1\n\n\n')).toJSON())
  assert.equal(softCode.state.selection.$from.parent.type.name, 'code_block')
  softCode.enter()
  expectDocument(softCode, doc(codeNode('const n = 1\n\n'), paragraph()), 1)
  console.log('✓ Shift+Enter 可保留代码空行，退出仅移除最后的空行')

  const whitespaceCode = keyboard(doc(codeNode('  const n = 1  \n  \t')))
  whitespaceCode.enter()
  expectDocument(whitespaceCode, doc(codeNode('  const n = 1  '), paragraph()), 1)
  console.log('✓ 末尾缩进空行可退出，非空代码行的空格保持不变')

  const preservedBlankLine = keyboard(doc(codeNode('const n = 1\n  \t\n')))
  preservedBlankLine.enter()
  expectDocument(preservedBlankLine, doc(codeNode('const n = 1\n  \t'), paragraph()), 1)
  console.log('✓ 退出仅清理最后一行，前一空行的缩进原样保留')

  const emptyCode = keyboard(doc(codeNode()))
  emptyCode.enter()
  assert.equal(emptyCode.state.selection.$from.parent.type.name, 'code_block')
  emptyCode.enter()
  expectDocument(emptyCode, doc(codeNode(), paragraph()), 1)
  console.log('✓ 空代码块也能通过两次 Enter 退出')

  const selectedDoc = doc(codeNode('ab\n'))
  const selectedCode = keyboard(selectedDoc, TextSelection.create(selectedDoc, 2, 4))
  selectedCode.enter()
  assert.deepEqual(selectedCode.state.doc.toJSON(), doc(codeNode('a\n')).toJSON())
  assert.equal(selectedCode.state.selection.$from.parent.type.name, 'code_block')
  console.log('✓ 非空选区按 Enter 只替换选中文字，不误退出代码块')

  const rule = schema.nodes.horizontal_rule.create()
  const ruleDoc = doc(rule)
  const near = keyboard(ruleDoc, NodeSelection.create(ruleDoc, 0))
  near.enter()
  expectDocument(near, doc(rule, paragraph()), 1)
  console.log('✓ 选中非文本块时，回车仍能在块后新建段落')

  /* ---------- 6. 图片订阅生命周期与异步边界 ---------- */
  console.log('\n--- 图片生命周期回归 ---')
  const { createImageResolver, ImageNodeView, insertImageFiles } = editorModule
  const pendingResolves = []
  const pendingWrites = []
  const previousApi = window.typeflow
  const views = []
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  window.typeflow = {
    assets: {
      resolve: (request) => new Promise((resolve) => pendingResolves.push({ request, resolve })),
      write: (request) => new Promise((resolve) => pendingWrites.push({ request, resolve }))
    }
  }
  try {
    const resolver = createImageResolver(() => '/文档 A')
    const imageNode = (src) => schema.nodes.image.create({ src })
    const mount = (src) => {
      const view = new ImageNodeView(imageNode(src), resolver)
      views.push(view)
      return view
    }
    const first = mount('assets/shared.jpg')
    const second = mount('assets/shared.jpg')
    assert.equal(pendingResolves.length, 1, '同图共享解析请求')
    pendingResolves.shift().resolve('/文档 A/assets/shared.jpg')
    await settle()
    for (const view of [first, second]) {
      assert.equal(decodeURI(view.dom.querySelector('img').src), 'file:///文档 A/assets/shared.jpg')
    }
    console.log('✓ 同一图片多个节点都接收解析结果')

    const oldImage = first.dom.querySelector('img')
    resolver.setBaseDirectory('/文档 B')
    assert.equal(pendingResolves.length, 1)
    assert.equal(pendingResolves[0].request.baseDirectory, '/文档 B')
    oldImage.dispatchEvent(new Event('error'))
    assert.equal(first.dom.classList.contains('is-pending'), true)
    assert.equal(first.dom.classList.contains('is-missing'), false)
    first.update(imageNode('assets/other.jpg'))
    pendingResolves.shift().resolve('/文档 B/assets/shared.jpg')
    await settle()
    assert.equal(first.dom.classList.contains('is-pending'), true)
    assert.equal(decodeURI(second.dom.querySelector('img').src), 'file:///文档 B/assets/shared.jpg')
    pendingResolves.shift().resolve('/文档 B/assets/other.jpg')
    await settle()
    assert.equal(decodeURI(first.dom.querySelector('img').src), 'file:///文档 B/assets/other.jpg')
    console.log('✓ 更换来源退订旧图片，旧 img 错误不覆盖新状态')

    first.destroy()
    second.destroy()
    resolver.setBaseDirectory('/文档 C')
    assert.equal(pendingResolves.length, 0, '销毁后不再触发解析')
    assert.equal(first.dom.childNodes.length, 0)
    assert.equal(second.dom.childNodes.length, 0)
    const remounted = mount('assets/shared.jpg')
    resolver.setBaseDirectory('/文档 D')
    assert.equal(pendingResolves.length, 2)
    pendingResolves.shift().resolve('/文档 C/assets/shared.jpg')
    await settle()
    assert.equal(remounted.dom.classList.contains('is-pending'), true)
    pendingResolves.shift().resolve('/文档 D/assets/shared.jpg')
    await settle()
    assert.equal(decodeURI(remounted.dom.querySelector('img').src), 'file:///文档 D/assets/shared.jpg')
    remounted.destroy()
    console.log('✓ 销毁释放订阅，重新挂载正常，旧目录异步结果被丢弃')

    let refreshCount = 0
    const onChange = () => { refreshCount += 1; resolver.get('assets/stable.jpg', onChange) }
    for (let i = 0; i < 20; i += 1) resolver.get('assets/stable.jpg', onChange)
    pendingResolves.shift().resolve('/文档 D/assets/stable.jpg')
    await settle()
    assert.equal(refreshCount, 1, '稳定回调不重复注册')
    resolver.setBaseDirectory('/文档 E')
    assert.equal(refreshCount, 2, '通知期间重新订阅不重复调用')
    resolver.unsubscribe('assets/stable.jpg', onChange)
    pendingResolves.shift().resolve('/文档 E/assets/stable.jpg')
    await settle()
    assert.equal(refreshCount, 2, '退订后不再接收异步结果')
    console.log('✓ 重复渲染不累积订阅，通知期间重新订阅不会循环')

    let imageState = EditorState.create({ doc: doc(paragraph('原文')) })
    const originalDoc = imageState.doc.toJSON()
    const insertionView = {
      get state() { return imageState },
      isDestroyed: false,
      dispatch(transaction) { imageState = imageState.apply(transaction) }
    }
    let current = true
    const bytes = new Uint8Array([1, 2, 3]).buffer
    const pendingInsert = insertImageFiles(insertionView, [{
      name: '图片.jpeg', type: 'image/jpeg', arrayBuffer: async () => bytes
    }], resolver, () => current)
    await settle()
    assert.equal(pendingWrites.length, 1)
    assert.ok(pendingWrites[0].request.filePath.startsWith('/文档 E/assets/'))
    current = false
    resolver.setBaseDirectory('/文档 F')
    pendingWrites.shift().resolve({ byteLength: bytes.byteLength })
    const result = await pendingInsert
    assert.deepEqual(result, { inserted: 0, failures: [] })
    assert.deepEqual(imageState.doc.toJSON(), originalDoc)
    console.log('✓ 写盘期间切换文档不向旧编辑器或新文档插入图片')
  } finally {
    for (const view of views) view.destroy()
    window.typeflow = previousApi
  }
} finally {
  editor.destroy()
  dom.window.close()
  await rm(workdir, { recursive: true, force: true })
}
