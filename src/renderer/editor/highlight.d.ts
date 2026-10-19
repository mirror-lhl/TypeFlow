/**
 * highlight.js 子路径模块的类型声明。
 *
 * 官方类型只覆盖 `highlight.js`（全量包）的入口，
 * 而本项目按需引入 `highlight.js/lib/core` 与单语言模块以控制体积，
 * 这些路径在 11.x 中尚无类型。这里只声明实际用到的形状，
 * 避免用 `any` 或关闭 noImplicitAny 来绕过。
 */
declare module 'highlight.js/lib/core' {
  interface HighlightResult {
    value: string
    language?: string
    relevance: number
  }

  interface HighlightOptions {
    language: string
    ignoreIllegals?: boolean
  }

  interface HighlightJs {
    registerLanguage(name: string, language: unknown): void
    getLanguage(name: string): unknown | undefined
    highlight(code: string, options: HighlightOptions): HighlightResult
    highlightAuto(code: string): HighlightResult
  }

  const hljs: HighlightJs
  export default hljs
}

declare module 'highlight.js/lib/languages/*' {
  const language: unknown
  export default language
}
