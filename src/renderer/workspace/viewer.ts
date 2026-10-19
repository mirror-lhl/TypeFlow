import type { RenderTask } from 'pdfjs-dist'
import type { ViewerKind } from '../../shared/document-types'
import { messages } from '../../shared/i18n'
import { directoryOf, toFileUrl } from '../file-url'
import { sanitizeHtmlDocument } from './html-sanitize'

/**
 * 只读查看器：PDF、HTML、图片。
 *
 * 三条硬约束，都来自"不能影响原有安全基线"：
 *  1. **不放宽 CSP**。PDF 用 pdf.js 的主线程 fake worker，于是既不需要
 *     `worker-src`，也不需要在运行期去取 worker 脚本文件；
 *     HTML 净化后挂进 shadow root，被查看文档的样式出不了那棵子树。
 *  2. **不使用 innerHTML**。HTML 走"解析 + 白名单重建"，
 *     图片与 PDF 页面分别落在 `<img>` 与 `<canvas>` 上。
 *  3. **不提供编辑入口**。查看器只渲染；保存、模式切换、格式按钮由会话层
 *     一并禁用，因此不存在"看了一半被序列化回写"的路径。
 */

const api = window.typeflow

export interface ViewerRequest {
  filePath: string
  kind: ViewerKind
  /** 仅 HTML 需要：由调用方按文档编码读好的原文 */
  html?: string
}

export interface ViewerOutcome {
  /** 状态栏补充信息，如 "12 页" */
  detail: string | null
  /** 安全处理提示，null 表示无需提示 */
  notice: string | null
  /** 失败原因；非 null 表示没能显示出来 */
  error: string | null
}

export interface ViewerView {
  show(request: ViewerRequest): Promise<ViewerOutcome>
  /** 离开查看会话时释放资源（PDF 文档、IntersectionObserver） */
  clear(): void
}

const EMPTY_OUTCOME: ViewerOutcome = { detail: null, notice: null, error: null }

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

const PDF_HORIZONTAL_PADDING = 32
const PDF_MIN_SCALE = 0.2
const PDF_MAX_SCALE = 3
/** 高分屏按设备像素比渲染，否则文字发虚；上限 2 是为了控制显存。 */
const PDF_MAX_DPR = 2
/** 提前渲染视口外这一段，滚动时不至于看到空白页。 */
const PDF_PRERENDER_MARGIN = '600px 0px'

type PdfJsModule = typeof import('pdfjs-dist')

let pdfJsPromise: Promise<PdfJsModule> | null = null

/**
 * 载入 pdf.js，并把 worker 挂成主线程 fake worker。
 *
 * `pdf.mjs` 在 `globalThis.pdfjsWorker.WorkerMessageHandler` 存在时直接用它，
 * 不再 `new Worker(...)`。这一步换来两件事：不需要 CSP 的 `worker-src`，
 * 也不需要把 worker 脚本当运行期资源去取（`file://` 下取不到）。
 *
 * 用 **legacy** 构建而不是默认构建：默认构建直接调用
 * `Uint8Array.prototype.toHex` / `toBase64`（算文档指纹、内嵌图片 data URL），
 * 这两个方法要到 Chromium 140 才有，而本项目锁在 Electron 33（Chromium 130），
 * 打开任何 PDF 都会抛 `hashOriginal.toHex is not a function`。
 * legacy 构建自带 core-js 垫片，API 与类型完全一致（其 .d.mts 就是 `export * from "pdfjs-dist"`）。
 *
 * 动态导入而非静态导入：worker 有 2.3 MB，只有真的打开 PDF 时才该付这个代价。
 */
function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
      ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
      return import('pdfjs-dist/legacy/build/pdf.mjs')
    })()
  }
  return pdfJsPromise
}

let wasmUrlPromise: Promise<string> | null = null

/**
 * 纯 JS 图像解码器（JPEG2000 / JBIG2）所在目录。
 *
 * `useWasm: false` 时 pdf.js 并不是"放弃这两种图像"，而是改走
 * `import(`${wasmUrl}openjpeg_nowasm_fallback.js`)`。这个目录必须由我们给出：
 * 不给的话 URL 是 `null`，动态 import 必然失败，解码器为 null，图像整块丢失。
 */
function pdfWasmUrl(): Promise<string> {
  if (!wasmUrlPromise) wasmUrlPromise = api.viewer.pdfWasmUrl()
  return wasmUrlPromise
}

/**
 * pdf.js 索取 cMap / 标准字体时的回源实现。
 *
 * 默认实现是 `fetch(cMapUrl + name)`，但渲染层由 `file://` 加载，
 * 本地 fetch 既被 CSP `connect-src 'self'` 挡住、也不被 Chromium 的 file
 * 访问策略允许。改由主进程按名读取（白名单目录 + 单段文件名）。
 *
 * 少了 cMap 的后果不是"字体不好看"，而是使用预定义编码的中文 PDF 整页失败，
 * 因此这条通道是 PDF 查看能力的必要组成，不是可选优化。
 */
class IpcBinaryDataFactory {
  readonly cMapUrl = null
  readonly standardFontDataUrl = null
  readonly wasmUrl = null

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const root =
      kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'standard_fonts' : null
    if (root === null) throw new Error(`未支持的 PDF 资源类型：${kind}`)

    const bytes = await api.viewer.readPdfResource(`${root}/${filename}`)
    if (!bytes) throw new Error(`缺少 PDF 资源：${root}/${filename}`)
    return new Uint8Array(bytes)
  }
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

/**
 * shadow root 里的兜底样式。
 *
 * 被查看文档自带的 `<style>` 排在这之后，因此它想覆盖什么都能覆盖；
 * 这里只保证"文档没写样式时也是可读的"。颜色用 CSS 变量——
 * 自定义属性会穿透 shadow 边界继承进来，于是明暗主题自动跟随。
 */
const BASE_HTML_CSS = `
.viewer-html__body {
  box-sizing: border-box;
  max-width: 60em;
  margin: 0 auto;
  padding: 24px 28px 40vh;
  font: 15px/1.75 var(--font-ui);
  color: var(--text);
  background: var(--bg);
  overflow-wrap: anywhere;
}
.viewer-html__body img { max-width: 100%; height: auto; }
.viewer-html__body pre { white-space: pre-wrap; }
.viewer-html__body table { border-collapse: collapse; max-width: 100%; }
.viewer-html__body td, .viewer-html__body th { border: 1px solid var(--border); padding: 4px 8px; }
.viewer-html__body a { color: var(--accent); }
.viewer-html__body hr { border: none; border-top: 1px solid var(--border); }
`

function renderHtml(host: HTMLElement, request: ViewerRequest): ViewerOutcome {
  const html = request.html
  if (typeof html !== 'string') {
    return { ...EMPTY_OUTCOME, error: messages().error.viewerFailed }
  }

  const container = document.createElement('div')
  container.className = 'viewer-html'
  host.appendChild(container)

  const sanitized = sanitizeHtmlDocument(html, directoryOf(request.filePath))
  const shadow = container.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = `${BASE_HTML_CSS}\n${sanitized.headStyles.join('\n')}`
  shadow.append(style, sanitized.fragment)

  // 外链交给系统浏览器：窗口自身禁止导航，链接点了没反应只会让人困惑
  container.addEventListener('click', (event) => {
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (/^https:\/\//i.test(href)) void api.shell.openExternal(href)
  })

  const dropped = sanitized.droppedElements
  if (dropped.length === 0 && sanitized.blockedReferences === 0) {
    return { ...EMPTY_OUTCOME }
  }
  const notice =
    dropped.length > 0
      ? `${messages().status.viewerSanitized}：${dropped.join(', ')}`
      : messages().status.viewerSanitized
  return { ...EMPTY_OUTCOME, notice }
}

/* ------------------------------------------------------------------ *
 * 图片
 * ------------------------------------------------------------------ */

function renderImage(host: HTMLElement, request: ViewerRequest): Promise<ViewerOutcome> {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    container.className = 'viewer-image'
    host.appendChild(container)

    const image = document.createElement('img')
    image.alt = request.filePath
    // 通过 `<img>` 加载的 SVG 不执行脚本、也不发起外部请求，是它最安全的展示方式
    image.src = toFileUrl(request.filePath)
    image.addEventListener('load', () => {
      resolve({
        ...EMPTY_OUTCOME,
        detail: `${image.naturalWidth} × ${image.naturalHeight}`
      })
    })
    image.addEventListener('error', () => {
      resolve({ ...EMPTY_OUTCOME, error: messages().error.imageCannotDisplay })
    })
    container.appendChild(image)
  })
}

/* ------------------------------------------------------------------ *
 * 查看器本体
 * ------------------------------------------------------------------ */

interface RenderHandle {
  dispose(): void
}

export function createViewer(host: HTMLElement): ViewerView {
  let generation = 0
  let handle: RenderHandle | null = null

  function release(): void {
    handle?.dispose()
    handle = null
    host.replaceChildren()
  }

  /**
   * 逐页按需渲染 PDF。
   *
   * 一次渲染全部页面在大文件上会直接卡死界面（几百个 canvas 同时栅格化），
   * 因此先按首页尺寸铺出等高占位块，再由 IntersectionObserver 触发真正
   * 进入视口的那几页。占位高度在页面渲染时校正——页面尺寸不一致的 PDF
   * 滚动时会有一次轻微跳动，这是"不卡死"换来的代价。
   */
  async function renderPdf(request: ViewerRequest, stale: () => boolean): Promise<ViewerOutcome> {
    const bytes = await api.assets.read(request.filePath)
    if (stale()) return EMPTY_OUTCOME
    // 资源通道有 32 MB 上限；超限与读失败都返回 null，这里只能给出同一个结论
    if (!bytes) throw new Error(messages().error.documentTooLarge)

    const pdfjs = await loadPdfJs()
    if (stale()) return EMPTY_OUTCOME
    const wasmUrl = await pdfWasmUrl()
    if (stale()) return EMPTY_OUTCOME

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      BinaryDataFactory: IpcBinaryDataFactory,
      // 关掉 wasm：`WebAssembly.instantiate` 需要 CSP 的 `wasm-unsafe-eval`，
      // 与"不放宽安全基线"冲突。代价是 JPEG2000 / JBIG2 改走纯 JS 解码器
      // （慢，但可用，前提是 wasmUrl 指向那两个 fallback 文件），
      // Type 4 后算函数退回内置解释器，ICC 色彩管理不生效。
      // PDF 内嵌 JavaScript 本来也不会被执行——查看器不渲染注释层，
      // pdf.js 只列出 JS 动作，不主动运行。
      useWasm: false,
      wasmUrl,
      isOffscreenCanvasSupported: false,
      verbosity: 0
    })
    const pdf = await loadingTask.promise
    if (stale()) {
      await loadingTask.destroy().catch(() => undefined)
      return EMPTY_OUTCOME
    }

    const scroll = document.createElement('div')
    scroll.className = 'viewer-pdf'
    host.appendChild(scroll)

    const pageCount = pdf.numPages
    const firstPage = await pdf.getPage(1)
    if (stale()) {
      await loadingTask.destroy().catch(() => undefined)
      return EMPTY_OUTCOME
    }

    const baseViewport = firstPage.getViewport({ scale: 1 })
    const cssWidth = Math.max(host.clientWidth - PDF_HORIZONTAL_PADDING * 2, 240)
    const scale = Math.min(Math.max(cssWidth / baseViewport.width, PDF_MIN_SCALE), PDF_MAX_SCALE)
    const cssHeight = Math.round(baseViewport.height * scale)

    const tasks = new Set<RenderTask>()
    const rendered = new Set<number>()

    async function paintPage(pageNumber: number, placeholder: HTMLElement): Promise<void> {
      try {
        const page = await pdf.getPage(pageNumber)
        if (stale()) return

        const dpr = Math.min(window.devicePixelRatio || 1, PDF_MAX_DPR)
        const viewport = page.getViewport({ scale: scale * dpr })
        const width = Math.round(viewport.width / dpr)
        const height = Math.round(viewport.height / dpr)

        const canvas = document.createElement('canvas')
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`

        placeholder.style.width = `${width}px`
        placeholder.style.height = `${height}px`
        placeholder.replaceChildren(canvas)

        // 6.x 起推荐直接交 canvas，上下文由 pdf.js 自己取
        const task = page.render({ canvas, viewport })
        tasks.add(task)
        try {
          await task.promise
        } finally {
          tasks.delete(task)
        }
      } catch {
        // 取消渲染与销毁文档都会让这里 reject，那不是错误
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const placeholder = entry.target as HTMLElement
          observer.unobserve(placeholder)
          const pageNumber = Number(placeholder.dataset.page)
          if (!Number.isInteger(pageNumber) || rendered.has(pageNumber)) continue
          rendered.add(pageNumber)
          void paintPage(pageNumber, placeholder)
        }
      },
      // root 留空即按文档视口判定，祖先的 overflow 裁剪会被一并计入，
      // 因此不必假设"谁是滚动容器"
      { rootMargin: PDF_PRERENDER_MARGIN }
    )

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const placeholder = document.createElement('div')
      placeholder.className = 'viewer-pdf__page'
      placeholder.dataset.page = String(pageNumber)
      placeholder.style.width = `${Math.round(cssWidth)}px`
      placeholder.style.height = `${cssHeight}px`
      scroll.appendChild(placeholder)
      observer.observe(placeholder)
    }

    handle = {
      dispose(): void {
        observer.disconnect()
        for (const task of tasks) task.cancel()
        tasks.clear()
        void loadingTask.destroy().catch(() => undefined)
      }
    }

    return { ...EMPTY_OUTCOME, detail: `${pageCount} ${messages().status.viewerPages}` }
  }

  return {
    async show(request: ViewerRequest): Promise<ViewerOutcome> {
      const token = (generation += 1)
      const stale = (): boolean => token !== generation

      release()

      if (request.kind === 'html') return renderHtml(host, request)
      if (request.kind === 'image') return renderImage(host, request)

      try {
        const outcome = await renderPdf(request, stale)
        if (stale()) {
          release()
          return EMPTY_OUTCOME
        }
        return outcome
      } catch (error) {
        release()
        if (stale()) return EMPTY_OUTCOME
        return {
          ...EMPTY_OUTCOME,
          error: `${messages().error.viewerFailed}：${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }
    },

    clear(): void {
      generation += 1
      release()
    }
  }
}
