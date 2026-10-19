/**
 * 本地绝对路径 → `file://` URL。
 *
 * 渲染层自身由 `file://` 加载，CSP 的 `img-src` 已放行 `file:`，
 * 因此编辑器内嵌图片、图片查看器与被查看 HTML 引用的本地资源都靠它加载。
 *
 * 逐段编码而不是整串编码：路径分隔符必须原样保留，
 * 而空格、中文、`#`、`?` 这些会改变 URL 结构的字符必须转义。
 */
export function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${prefixed.split('/').map(encodeURIComponent).join('/')}`
}

/** 取路径的父目录；没有分隔符时返回 null。 */
export function directoryOf(absolutePath: string): string | null {
  const normalized = absolutePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : null
}
