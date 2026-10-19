import { Schema, type MarkSpec, type NodeSpec, type Schema as SchemaType } from 'prosemirror-model'
import { schema as baseSchema } from 'prosemirror-markdown'
import { mathBlockSpec, mathInlineSpec } from './math'
import { tableNodeSpecs } from './table'

/**
 * TypeFlow 文档 schema。
 *
 * 设计原则：**在 prosemirror-markdown 的默认 schema 上做加法，而不是重写。**
 * 默认 schema 已经正确处理了几个极易做错的点，直接复用可以省下数百行易错代码：
 *
 *  - `list_item` 的 `tight` 属性：区分紧凑列表（`- a`）与松散列表（`- a\n\n- b`），
 *    没有它就无法无损往返
 *  - `ordered_list` 的 `start` 属性：避免 `3. c` 被改写成 `1. c`
 *  - `code_block` 的 `text*` 内容：代码原文存在文档模型里，复制/撤销/序列化天然正确
 *  - `link` 的 markdown 序列化与标题转义
 *
 * 因此本文件只补充两件事：`strikethrough` 标记，以及对外暴露的便利构造器。
 */

/**
 * 无序列表。
 *
 * 默认 schema 的 `bullet_list` 只有 `tight` 属性，序列化时标记固定输出 `*`。
 * 这会让 `- item` 在保存后变成 `* item`——语义不变却制造整文件 diff。
 * 因此新增 `bullet` 属性记住用户实际使用的标记字符，保证往返逐字一致。
 */
export const bulletListSpec: NodeSpec = {
  ...(baseSchema.spec.nodes.get('bullet_list') as NodeSpec),
  attrs: {
    tight: { default: false },
    bullet: { default: '-' }
  },
  toDOM(node) {
    return ['ul', { 'data-bullet': node.attrs.bullet }, 0]
  }
}

/** GFM 删除线。CommonMark 没有它，但 Typora 与 GitHub 都支持，属于预期能力。 */
export const strikethroughSpec: MarkSpec = {
  parseDOM: [
    { tag: 's' },
    { tag: 'del' },
    { tag: 'strike' },
    {
      style: 'text-decoration',
      getAttrs: (value: string) => (value === 'line-through' ? null : false)
    }
  ],
  toDOM() {
    return ['s', 0]
  }
}

/**
 * 最终 schema。
 *
 * 组成：默认节点/标记 + 无序列表标记风格 + 删除线 + 数学公式。
 *
 * 关于公式的位置：
 *  - `math_inline` 是 `inline` 组的原子节点，自动进入所有文本块的 inline 内容
 *  - `math_block` 是**块级**节点，与段落平级。把块级节点塞进段落 content
 *    会违反 ProseMirror 的嵌套规则（textblock 只能含 inline），
 *    因此这里只把它加入 doc 的 content，不碰段落/标题的 content 表达式
 */
export const schema: SchemaType = new Schema({
  nodes: baseSchema.spec.nodes
    .update('bullet_list', bulletListSpec)
    .update('doc', {
      ...(baseSchema.spec.nodes.get('doc') as NodeSpec),
      content: 'block+'
    })
    .addToEnd('math_inline', mathInlineSpec)
    .addToEnd('math_block', mathBlockSpec)
    // 表格：tableNodes 生成的 4 个节点必须全部加入，缺一个都会导致构造失败
    .addToEnd('table', tableNodeSpecs.table)
    .addToEnd('table_row', tableNodeSpecs.table_row)
    .addToEnd('table_cell', tableNodeSpecs.table_cell)
    .addToEnd('table_header', tableNodeSpecs.table_header),
  marks: baseSchema.spec.marks.addToEnd('strikethrough', strikethroughSpec)
})

/* ------------------------------------------------------------------ *
 * 节点与标记类型的安全访问器
 *
 * schema 里 nodeType 可能为 undefined（TypeScript 无法表达"按名字取一定存在"），
 * 逐个断言会把 undefined 检查散落到各处。集中在这里断言一次，
 * 越早失败越好——schema 缺节点属于编程错误，不是运行时异常。
 * ------------------------------------------------------------------ */

function requireNode(name: string) {
  const type = schema.nodes[name]
  if (!type) throw new Error(`schema 缺少节点类型: ${name}`)
  return type
}

function requireMark(name: string) {
  const type = schema.marks[name]
  if (!type) throw new Error(`schema 缺少标记类型: ${name}`)
  return type
}

export const nodes = {
  doc: requireNode('doc'),
  paragraph: requireNode('paragraph'),
  heading: requireNode('heading'),
  blockquote: requireNode('blockquote'),
  bullet_list: requireNode('bullet_list'),
  ordered_list: requireNode('ordered_list'),
  list_item: requireNode('list_item'),
  code_block: requireNode('code_block'),
  horizontal_rule: requireNode('horizontal_rule'),
  hard_break: requireNode('hard_break'),
  image: requireNode('image'),
  math_inline: requireNode('math_inline'),
  math_block: requireNode('math_block'),
  table: requireNode('table'),
  table_row: requireNode('table_row'),
  table_cell: requireNode('table_cell'),
  table_header: requireNode('table_header'),
  text: requireNode('text')
}

export const marks = {
  em: requireMark('em'),
  strong: requireMark('strong'),
  code: requireMark('code'),
  link: requireMark('link'),
  strikethrough: requireMark('strikethrough')
}

/** 标题最大层级，与 Markdown `######` 对齐。 */
export const MAX_HEADING_LEVEL = 6
