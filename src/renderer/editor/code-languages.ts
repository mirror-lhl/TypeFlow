import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * 代码语言注册与高亮计算。
 *
 * 从 NodeView 里抽出来独立成模块，是因为"语言"这件事有两个互不相关的使用者：
 *  - 代码块 NodeView 需要语言列表（渲染下拉框）
 *  - 高亮插件需要把代码转换成带类名的区间
 *
 * 原先它们都在 NodeView 里，于是高亮只能通过"改写 contentDOM"来落地——
 * 那正是后面一连串缺陷（选区被吞、装饰器被毁）的共同根因。
 */

/**
 * 显式注册语言而非引入 `highlight.js` 全量包。
 *
 * 全量包含约 190 种语言、体积数 MB；这里只覆盖实际会写进笔记的语言。
 *
 * 关键细节：只按**规范名**注册。
 * highlight.js 11 只认 `registerAliases` 声明的别名，把别名当语言名注册
 * 并不会让 `getLanguage('ts')` 命中——实测这正是"高亮完全没颜色"的原因。
 * 别名统一在 `CANONICAL` 里归一。
 */
const LANGUAGE_DEFINITIONS: Record<string, unknown> = {
  bash,
  cpp,
  css,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  html: xml,
  yaml
}

let registered = false

function ensureLanguages(): void {
  if (registered) return
  for (const [name, definition] of Object.entries(LANGUAGE_DEFINITIONS)) {
    try {
      hljs.registerLanguage(name, definition as never)
    } catch {
      // 注册失败不影响编辑，仅退化为无高亮
    }
  }
  registered = true
}

/** 界面展示用的语言列表。顺序固定，便于形成肌肉记忆。 */
export const LANGUAGE_OPTIONS = [
  'text',
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'java',
  'cpp',
  'css',
  'html',
  'json',
  'yaml',
  'bash',
  'sql',
  'markdown'
] as const

/** 别名归一到规范名，使 `js` 与 `javascript` 行为一致。 */
const CANONICAL: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  c: 'cpp',
  'c++': 'cpp',
  sh: 'bash',
  shell: 'bash',
  md: 'markdown',
  yml: 'yaml',
  xml: 'html'
}

export function canonicalLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  if (normalized.length === 0) return 'text'
  return CANONICAL[normalized] ?? normalized
}

export function isLanguageSupported(language: string): boolean {
  ensureLanguages()
  const canonical = canonicalLanguage(language)
  return canonical === 'text' || hljs.getLanguage(canonical) !== undefined
}

/** 代码文本内的一个着色区间（相对代码起点，单位为字符）。 */
export interface CodeHighlightRange {
  from: number
  to: number
  className: string
}

/**
 * 计算代码的着色区间。
 *
 * 返回的是**相对代码文本的字符区间**，而不是 HTML——
 * 这样调用方可以直接把它映射成编辑器里的装饰器，无需触碰 DOM。
 * （返回 HTML 再解析回区间是另一条路，但那样既要解析又要重建 DOM，
 * 正是我们要消除的做法。）
 */
export function computeHighlightRanges(code: string, language: string): CodeHighlightRange[] {
  ensureLanguages()

  const canonical = canonicalLanguage(language)
  if (canonical === 'text' || code.length === 0) return []
  if (!hljs.getLanguage(canonical)) return []

  let html: string
  try {
    // ignoreIllegals：用户写到一半的代码不应触发高亮器的内部报错
    html = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value
  } catch {
    // 高亮失败只是没有颜色，绝不能影响编辑
    return []
  }

  return parseRangesFromHtml(html, code.length)
}

/**
 * 把高亮输出的 HTML 解析成字符区间。
 *
 * 高亮结果是"文本 + 嵌套 span"的简单结构，按文档顺序遍历并累加字符数即可。
 * 用不可见的 `<template>` 承载：它不参与渲染，也不会触发样式计算。
 */
function parseRangesFromHtml(html: string, expectedLength: number): CodeHighlightRange[] {
  const template = document.createElement('template')
  template.innerHTML = html

  const ranges: CodeHighlightRange[] = []
  let offset = 0

  const walk = (node: Node, inherited: string): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? ''
        if (text.length > 0 && inherited.length > 0) {
          ranges.push({ from: offset, to: offset + text.length, className: inherited })
        }
        offset += text.length
        continue
      }

      if (child instanceof HTMLElement) {
        const own = inherited.length > 0 ? `${inherited} ${child.className}` : child.className
        walk(child, own)
      }
    }
  }

  walk(template.content, '')

  // 高亮结果理论上与原文等长；不等长时以原文为准，避免越界装饰
  return ranges
    .map((range) => ({ ...range, to: Math.min(range.to, expectedLength) }))
    .filter((range) => range.to > range.from)
}
