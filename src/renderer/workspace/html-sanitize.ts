import { toFileUrl } from '../file-url'

/**
 * 只读 HTML 查看器的净化层。
 *
 * 为什么不用 iframe：`sandbox` 不带 `allow-same-origin` 时文档源是 opaque，
 * 同目录的 CSS 与图片全都加载不出来；带上 `allow-same-origin` 又等于把
 * `file://` 父页面的源交给被查看的文档——那比不做隔离更糟。
 * 而且两条路都要放宽 CSP 的 `frame-src`。
 *
 * 因此这里走"解析 + 白名单重建"：`DOMParser` 产出的是**惰性文档**
 * （没有浏览上下文，脚本不执行、资源不加载），再按白名单把需要的节点
 * 逐个 `createElement` 重建到查看器里。全程不使用 `innerHTML`。
 *
 * 重建结果挂到 shadow root，被查看文档自带的 `<style>` 只作用于那棵子树，
 * 无法改写 TypeFlow 自身的界面。
 */

/**
 * 整棵子树丢弃的元素。
 *
 * 与"不在白名单里"的区别在于：未知元素只脱掉标签、保留内容，
 * 而这里列出的元素**内容本身**就是风险（脚本正文、框架源、表单控件、
 * 可携带 `<script>` 的 SVG/MathML），必须连子节点一起扔。
 */
const DROPPED_SUBTREES = new Set([
  'script',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'param',
  'portal',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'fieldset',
  'svg',
  'math',
  'canvas',
  'video',
  'audio',
  'source',
  'track'
])

/** 允许重建的元素。表外元素脱掉标签、保留子内容。 */
const ALLOWED_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr'
])

/**
 * 允许保留的属性。
 *
 * `on*` 事件属性天然不在表内；URL 类属性还要再过一次协议校验。
 * `srcset` 有意排除：它是一组带候选协议的 URL 列表，
 * 逐个解析的收益远低于漏掉一个候选的风险。
 */
const ALLOWED_ATTRIBUTES = new Set([
  'abbr',
  'align',
  'alt',
  'border',
  'cellpadding',
  'cellspacing',
  'class',
  'colspan',
  'datetime',
  'dir',
  'height',
  'href',
  'id',
  'lang',
  'media',
  'open',
  'rel',
  'reversed',
  'rowspan',
  'scope',
  'span',
  'src',
  'start',
  'style',
  'title',
  'type',
  'valign',
  'width'
])

const URL_ATTRIBUTES = new Set(['src', 'href'])

/**
 * 内联 style 里能造成实际危害的写法。
 *
 * CSP 已经挡住了 `url()` 的外联加载，这里再挡一次那些"不靠网络也能作恶"的：
 * `expression()`、IE 的 `behavior:`、以及任何试图塞进标记符号的写法。
 */
const DANGEROUS_STYLE = /javascript\s*:|expression\s*\(|behavior\s*:|@import|<|\\/i

export interface SanitizedHtml {
  /** 已重建的正文，可直接挂进 shadow root */
  fragment: DocumentFragment
  /** `<head>` 里的样式文本，按出现顺序；正文内的 `<style>` 已在 fragment 中 */
  headStyles: string[]
  /** 被丢弃的元素名（去重排序），供提示与自检使用 */
  droppedElements: string[]
  /** 因协议不合法而被丢掉的引用数量 */
  blockedReferences: number
}

interface Context {
  baseUrl: string
  dropped: Set<string>
  blockedReferences: number
}

/**
 * 解析并重建一份 HTML 文档。
 *
 * `baseDirectory` 是被查看文件所在目录，相对引用（图片、样式表里不管）
 * 按它解析成本地 `file://` URL。
 */
export function sanitizeHtmlDocument(source: string, baseDirectory: string | null): SanitizedHtml {
  const parsed = new DOMParser().parseFromString(source, 'text/html')
  const context: Context = {
    baseUrl: baseDirectory === null ? '' : `${toFileUrl(baseDirectory)}/`,
    dropped: new Set(),
    blockedReferences: 0
  }

  // head 里的样式要单独收：重建只从 body 开始，否则 <title>/<meta> 会漏进正文
  const headStyles: string[] = []
  for (const node of Array.from(parsed.head?.children ?? [])) {
    if (node.localName === 'style') headStyles.push(node.textContent ?? '')
  }

  const fragment = document.createDocumentFragment()
  const wrapper = document.createElement('div')
  wrapper.className = 'viewer-html__body'
  fragment.appendChild(wrapper)
  rebuildChildren(parsed.body, wrapper, context)

  return {
    fragment,
    headStyles,
    droppedElements: [...context.dropped].sort(),
    blockedReferences: context.blockedReferences
  }
}

function rebuildChildren(sourceParent: Element, target: Element, context: Context): void {
  for (const child of Array.from(sourceParent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.nodeValue ?? ''))
      continue
    }
    // 注释与 CDATA 一律丢弃：条件注释能被解析成标记，留着没有收益
    if (child.nodeType !== Node.ELEMENT_NODE) continue

    const element = child as Element
    const name = element.localName.toLowerCase()

    if (DROPPED_SUBTREES.has(name)) {
      context.dropped.add(name)
      continue
    }

    if (!ALLOWED_ELEMENTS.has(name)) {
      context.dropped.add(name)
      rebuildChildren(element, target, context)
      continue
    }

    // 名字来自白名单，createElement 不可能造出 script 之类的元素
    const created = document.createElement(name)
    copyAttributes(element, created, context)

    if (name === 'style') {
      // textContent 而非 innerHTML：样式正文只作为文本写入，不参与解析
      created.textContent = element.textContent ?? ''
    } else {
      rebuildChildren(element, created, context)
    }

    target.appendChild(created)
  }
}

function copyAttributes(source: Element, target: HTMLElement, context: Context): void {
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name.toLowerCase()
    if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name)) continue

    const value = attribute.value
    if (URL_ATTRIBUTES.has(name)) {
      const resolved = resolveReference(name, value, context)
      if (resolved === null) {
        context.blockedReferences += 1
        continue
      }
      target.setAttribute(name, resolved)
      continue
    }
    if (name === 'style') {
      if (DANGEROUS_STYLE.test(value)) {
        context.blockedReferences += 1
        continue
      }
      target.setAttribute(name, value)
      continue
    }
    target.setAttribute(name, value)
  }
}

/**
 * 解析一个 URL 属性值。返回 null 表示丢弃。
 *
 * `href` 放行 http/https：查看技术文档时点外链是正常需求，
 * 主进程的 `shell.openExternal` 也只接受 https，链接不会把窗口带走。
 * `src` 只放行本地与 data:image——远程图片本来就被 CSP 的 `img-src` 挡掉，
 * 与其显示一个破图占位，不如让它退化成 alt 文本。
 */
function resolveReference(attribute: string, raw: string, context: Context): string | null {
  const value = raw.trim()
  if (value.length === 0) return null

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase()
  if (scheme === 'data') {
    return attribute === 'src' && /^data:image\//i.test(value) ? value : null
  }
  if (scheme !== undefined) {
    if (attribute === 'href' && (scheme === 'http' || scheme === 'https')) return value
    // file:、mailto:、javascript: 等一律按下面的相对解析处理或丢弃
    if (scheme !== 'file') return null
  }

  if (context.baseUrl.length === 0) return null
  try {
    const resolved = new URL(value, context.baseUrl)
    return resolved.protocol === 'file:' ? resolved.href : null
  } catch {
    return null
  }
}
