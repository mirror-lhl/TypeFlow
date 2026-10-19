/**
 * 可打开的文件类型清单：可编辑的文档（Markdown / 纯文本）与只读的查看对象
 * （PDF / HTML / 图片）。
 *
 * 这份清单被主进程（目录树标记、搜索范围、文件对话框过滤器）与渲染层
 * （打开前的类型校验、纯文本会话判定、选择查看器）共用。此前各处各写一份，
 * 于是出现"打开对话框已经能选 .txt，工作区里的 .txt 却打不开"——
 * 清单只留一处才不会再次漂移。
 */

/** Markdown 家族扩展名（含点，小写）。 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdx']

/** 纯文本扩展名（含点，小写）。 */
export const TEXT_EXTENSIONS = ['.txt']

/** 全部可编辑文档扩展名（含点，小写）。 */
export const DOCUMENT_EXTENSIONS = [...MARKDOWN_EXTENSIONS, ...TEXT_EXTENSIONS]

const DOCUMENT_EXTENSION_SET = new Set(DOCUMENT_EXTENSIONS)

export const PDF_EXTENSIONS = ['.pdf']

export const HTML_EXTENSIONS = ['.html', '.htm']

/**
 * 图片扩展名（含点，小写）。
 *
 * 含 `.svg`：SVG 能携带脚本，但**通过 `<img>` 加载的 SVG 不执行脚本、
 * 也不发起外部请求**（浏览器规范行为），因此图片查看器恰好是它最安全的展示方式。
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
  '.ico',
  '.svg'
]

/** 只读查看对象的扩展名。 */
export const VIEW_EXTENSIONS = [...PDF_EXTENSIONS, ...HTML_EXTENSIONS, ...IMAGE_EXTENSIONS]

const VIEWER_KIND_BY_EXTENSION = new Map<string, ViewerKind>([
  ...PDF_EXTENSIONS.map((extension) => [extension, 'pdf'] as const),
  ...HTML_EXTENSIONS.map((extension) => [extension, 'html'] as const),
  ...IMAGE_EXTENSIONS.map((extension) => [extension, 'image'] as const)
])

/** 目录树里不置灰、可以被打开的全部扩展名。 */
export const OPENABLE_EXTENSIONS = [...DOCUMENT_EXTENSIONS, ...VIEW_EXTENSIONS]

/** 只读查看器的种类，决定用哪套渲染方式。 */
export type ViewerKind = 'pdf' | 'html' | 'image'

/** 去掉点号，供 Electron 文件对话框的 `extensions` 字段使用。 */
export function bareExtensions(extensions: readonly string[]): string[] {
  return extensions.map((extension) => extension.slice(1))
}

/**
 * 取小写扩展名。
 *
 * 渲染层没有 `node:path`，因此自行实现：只看最后一段路径，
 * 避免把 `notes.d/file` 里的点误当成扩展名。
 * `dot <= 0` 覆盖"无扩展名"与"以点开头的隐藏文件"（如 `.md`），与 `extname` 一致。
 */
function extensionOf(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** 是否能作为文档打开（Markdown 或纯文本）。 */
export function isDocumentPath(filePath: string): boolean {
  return DOCUMENT_EXTENSION_SET.has(extensionOf(filePath))
}

/**
 * 是否为纯文本文档。
 *
 * 纯文本**不能**走所见即所得内核：内核保存时会按 Markdown 规范化内容，
 * `*` 变成 `\*`、`a[0]` 变成 `a\[0\]`、单换行被并进同一段、`1)` 被改写成 `1.`。
 * 对 Markdown 那是"整理源码"，对纯文本就是改坏用户的文件。
 * 因此纯文本会话被钉在源码模式，保存时逐字回写。
 */
export function isPlainTextPath(filePath: string | null): boolean {
  return filePath !== null && TEXT_EXTENSIONS.includes(extensionOf(filePath))
}

/**
 * 该路径应当用哪种只读查看器渲染；不是查看对象时返回 null。
 *
 * 用"返回种类"而不是三个 `isXxxPath`：调用方真正需要的是选哪套渲染，
 * 布尔判定会把 `switch` 散落到每个调用点，新增一种查看器就要改一圈。
 */
export function viewerKindOf(filePath: string | null): ViewerKind | null {
  if (filePath === null) return null
  return VIEWER_KIND_BY_EXTENSION.get(extensionOf(filePath)) ?? null
}

/** 是否为只读查看对象（PDF / HTML / 图片）。 */
export function isViewablePath(filePath: string): boolean {
  return viewerKindOf(filePath) !== null
}

/** 是否能被打开——可编辑文档或只读查看对象。 */
export function isOpenablePath(filePath: string): boolean {
  return isDocumentPath(filePath) || isViewablePath(filePath)
}
