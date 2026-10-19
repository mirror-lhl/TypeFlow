import { DOMSerializer, type Node as PMNode } from 'prosemirror-model'
import katex from 'katex'
import { schema } from '../editor/schema'
import { canonicalLanguage } from '../editor/code-languages'
import { messages } from '../../shared/i18n'

/**
 * 导出 HTML 生成。
 *
 * 目标是**自包含单文件**：换台机器、拷给别人、用浏览器打开都不缺东西。
 * 这带来两个必须专门处理的问题：
 *
 * 1. **图片必须内联为 data URL。** 导出结果通过 `data:` URL 加载进隐藏窗口打印，
 *    而 `data:` URL 的源是"不透明来源"，其中任何 `file://` 或相对路径资源都会被拦。
 *    内联既解决拦截，也让单文件真正可移植。
 *
 * 2. **公式不能用 KaTeX 的 HTML 输出。** KaTeX HTML 依赖 20 多个字体文件，
 *    内联它们会让导出体积增加约 1.5 MB，且相对路径在 `data:` 下同样失效。
 *    **MathML 输出不需要任何字体**，Chromium 原生渲染，正好适合导出场景。
 *    代价是排版精细度略低于 KaTeX HTML——这是导出可以接受的取舍。
 */

/* ------------------------------------------------------------------ *
 * 公式：导出用 MathML
 * ------------------------------------------------------------------ */

function renderMathForExport(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      output: 'mathml',
      throwOnError: false,
      strict: false,
      trust: false
    })
  } catch {
    // 渲染失败时保留 LaTeX 原文，导出的文档仍可读
    return `<code class="math-fallback">${escapeHtml(latex)}</code>`
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ *
 * 文档 → HTML
 * ------------------------------------------------------------------ */

/**
 * 自定义序列化器。
 *
 * 覆盖三类节点：
 *  - 公式：输出 MathML（见上）
 *  - 代码块：加上 `language-x` 类，便于导出后的样式与第三方高亮
 *  - 图片：先输出原样，稍后统一把相对路径替换为 data URL
 */
function buildSerializer(): DOMSerializer {
  const mathNode = (node: PMNode, display: boolean): HTMLElement => {
    const holder = document.createElement(display ? 'div' : 'span')
    holder.className = display ? 'math-block' : 'math-inline'
    holder.setAttribute('data-latex', String(node.attrs.value ?? ''))
    // DOMSerializer 接受真实 DOM 节点作为输出规格，因此这里可以预置 innerHTML
    holder.innerHTML = renderMathForExport(String(node.attrs.value ?? ''), display)
    return holder
  }

  return new DOMSerializer(
    {
      ...DOMSerializer.nodesFromSchema(schema),
      math_inline: (node) => mathNode(node, false),
      math_block: (node) => mathNode(node, true),
      code_block: (node) => {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        const language = String(node.attrs.params ?? '').trim()

        if (language.length > 0) {
          const canonical = canonicalLanguage(language)
          code.className = `language-${canonical}`
        }
        // textContent 而非 innerHTML：代码块内容必须原样输出，不参与 HTML 解析
        code.textContent = node.textContent
        pre.appendChild(code)
        return pre
      },
      image: (node) => {
        const image = document.createElement('img')
        // 相对路径先保留，由 inlineImages 统一替换
        image.setAttribute('data-src', String(node.attrs.src ?? ''))
        const alt = String(node.attrs.alt ?? '')
        if (alt.length > 0) image.alt = alt
        const title = node.attrs.title
        if (title) image.title = String(title)
        return image
      }
    },
    DOMSerializer.marksFromSchema(schema)
  )
}

export function documentToHtml(doc: PMNode): string {
  const container = document.createElement('div')
  container.appendChild(buildSerializer().serializeFragment(doc.content, { document }))
  return container.innerHTML
}

/* ------------------------------------------------------------------ *
 * 图片内联
 * ------------------------------------------------------------------ */

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

interface InlineAssetsApi {
  read(filePath: string): Promise<ArrayBuffer | null>
  resolve(request: {
    target: string
    baseDirectory: string | null
  }): Promise<string | null>
}

export interface InlineResult {
  html: string
  inlined: number
  missing: string[]
}

/**
 * 把 `data-src` 指向的图片内联为 data URL。
 *
 * 缺失的图片不会让导出失败：替换为可见的占位文字，
 * 这样用户能立刻知道哪张图没找到，而不是导出一个破图。
 */
export async function inlineImages(
  html: string,
  baseDirectory: string | null,
  assets: InlineAssetsApi
): Promise<InlineResult> {
  const container = document.createElement('div')
  container.innerHTML = html

  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-src]'))
  const missing: string[] = []
  let inlined = 0

  for (const image of images) {
    const source = image.getAttribute('data-src') ?? ''
    if (source.length === 0) {
      image.remove()
      continue
    }

    // 已经是 data URL 或远程地址时无需处理
    if (/^(data:|https?:)/i.test(source)) {
      image.src = source
      image.removeAttribute('data-src')
      inlined += 1
      continue
    }

    try {
      const absolute = await assets.resolve({ target: source, baseDirectory })
      if (!absolute) {
        replaceWithPlaceholder(image, source)
        missing.push(source)
        continue
      }

      const bytes = await assets.read(absolute)
      if (!bytes) {
        replaceWithPlaceholder(image, source)
        missing.push(source)
        continue
      }

      const extension = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
      const mime = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
      image.src = `data:${mime};base64,${toBase64(bytes)}`
      image.removeAttribute('data-src')
      inlined += 1
    } catch {
      replaceWithPlaceholder(image, source)
      missing.push(source)
    }
  }

  return { html: container.innerHTML, inlined, missing }
}

function replaceWithPlaceholder(image: HTMLImageElement, source: string): void {
  const placeholder = document.createElement('span')
  placeholder.className = 'image-missing'
  placeholder.textContent = `[${messages().error.imageMissing}: ${source}]`
  image.replaceWith(placeholder)
}

/**
 * ArrayBuffer → base64。
 *
 * 分块处理：`String.fromCharCode(...bytes)` 在大图上会因参数数量超限而抛错，
 * 导出文档里的图片动辄数 MB，必须分块。
 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/* ------------------------------------------------------------------ *
 * 完整 HTML 文档
 * ------------------------------------------------------------------ */

/**
 * 导出用的排版样式。
 *
 * 与编辑器样式分开维护：编辑器样式要考虑工具栏、光标、选区，
 * 而导出只关心静态排版与分页。共用一套会让两边都变复杂。
 *
 * 字体栈显式包含中文族：只写 `serif` 会落到无衬线系统字体，
 * 中文文档在纸质输出下的观感会明显更差。
 */
const EXPORT_STYLES = `
:root {
  --text: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --code-bg: #f7f7f8;
  --accent: #2563eb;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 32px 24px 64px;
  max-width: 820px;
  margin-inline: auto;
  color: var(--text);
  /* 中文优先的字体栈：PingFang / 微软雅黑 / 思源，最后回落到 serif */
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', sans-serif;
  font-size: 16px;
  line-height: 1.8;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  line-height: 1.35;
  margin: 1.4em 0 0.6em;
  /* 标题后不留孤行：避免标题出现在页底而正文翻页 */
  break-after: avoid;
}

h1 { font-size: 1.9em; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
h4, h5, h6 { font-size: 1.1em; }

p { margin: 0.8em 0; }

a { color: var(--accent); }

blockquote {
  margin: 1em 0;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

ul, ol { padding-left: 1.8em; }
li { margin: 0.25em 0; }

/* 代码块尽量不跨页，否则阅读体验很差 */
pre {
  margin: 1em 0;
  padding: 12px 14px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow-x: auto;
  break-inside: avoid;
}

code {
  font-family: 'SF Mono', Menlo, Consolas, 'Courier New', monospace;
  font-size: 0.9em;
}

p code, li code {
  padding: 1px 5px;
  background: var(--code-bg);
  border-radius: 4px;
}

pre code { background: none; padding: 0; font-size: 0.88em; line-height: 1.6; }

table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  /* 表格在跨页时容易错位，尽量整张保留 */
  break-inside: avoid;
}

th, td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}

th { background: var(--code-bg); font-weight: 600; }

img { max-width: 100%; height: auto; border-radius: 6px; }

hr { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }

/* 公式：MathML 由浏览器原生渲染，只需处理对齐与溢出 */
.math-inline { display: inline-block; }
.math-block {
  display: block;
  margin: 1em 0;
  text-align: center;
  overflow-x: auto;
}

/* 缺失的图片用可见占位，避免导出后出现破图 */
.image-missing {
  display: inline-block;
  padding: 2px 8px;
  border: 1px dashed var(--border);
  border-radius: 4px;
  color: var(--muted);
  font-size: 0.9em;
}

.math-fallback {
  color: #b91c1c;
  font-family: 'SF Mono', Menlo, monospace;
}

@page { margin: 16mm; }
`

export interface ExportDocumentOptions {
  title: string
  bodyHtml: string
}

export function buildExportHtml(options: ExportDocumentOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
${options.bodyHtml}
</body>
</html>`
}
