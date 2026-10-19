import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import type { AssetWriteResult } from '../../shared/ipc'
import { messages } from '../../shared/i18n'
import { toFileUrl } from '../file-url'

/**
 * 图片的编辑态渲染与本地资源解析。
 *
 * 两个必须解决的问题：
 *
 * 1. **markdown 里存相对路径，DOM 需要绝对路径。**
 *    `<img src="assets/a.png">` 是相对文档的，而渲染进程的页面源是
 *    dev server 或打包后的 index.html，两者目录不同，因此必须把相对路径
 *    解析成绝对路径再转成 `file://` URL，否则图片永远加载不出来。
 *
 * 2. **相对路径的基准是"当前文档所在目录"，而它会随标签切换而变。**
 *    因此解析器维护"当前基准目录"，切换标签时整体失效缓存并刷新。
 *    没有这一步会出现"A 文件的图片在 B 文件里显示出来"这种串图。
 */

interface ImageEntry {
  /** 解析出的绝对路径；null 表示文件不存在 */
  absolutePath: string | null
  status: 'pending' | 'resolved'
}

export interface ImageResolver {
  /** 文档基准目录变化时调用（切标签、另存为） */
  setBaseDirectory(directory: string | null): void
  /** 取得解析结果并订阅刷新；同一 NodeView 必须使用稳定的回调 */
  get(source: string, onChange: () => void): ImageEntry
  /** NodeView 更换来源或销毁时释放订阅 */
  unsubscribe(source: string, onChange: () => void): void
  /** 写入图片资源并返回可写进 markdown 的相对路径 */
  storeImage(bytes: ArrayBuffer, extension: string): Promise<string>
  /** 文档目录下资源子目录的名字（markdown 中出现的相对前缀） */
  readonly assetDirectoryName: string
}

const ASSET_DIRECTORY = 'assets'

/** MIME 类型 → 扩展名。白名单与主进程保持一致。 */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
}

export function extensionForMimeType(mimeType: string): string | null {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? null
}

/**
 * 生成文件名。
 *
 * 用"时间戳 + 随机后缀"而非原文件名：原文件名常含空格、中文、重名，
 * 直接落盘既容易冲突也会让 markdown 里的一堆转义变得难读。
 * 时间戳保证可读性（便于人工在 assets/ 里定位）。
 */
function buildAssetFileName(extension: string): string {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('')
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('')
  const random = Math.random().toString(36).slice(2, 6)
  return `image-${stamp}-${time}-${random}${extension}`
}

export function createImageResolver(getBaseDirectory: () => string | null): ImageResolver {
  const cache = new Map<string, ImageEntry>()
  // 同一图片可出现多次；稳定回调配合退订，避免刷新时累积闭包或保留已销毁节点。
  const listeners = new Map<string, Set<() => void>>()

  let baseDirectory: string | null = getBaseDirectory()
  let generation = 0

  function keyOf(source: string): string {
    return `${baseDirectory ?? ''}\u0000${source}`
  }

  function notify(source: string): void {
    // 遍历快照：渲染过程中可能注册、退订，不能遍历持续变化的集合。
    for (const listener of [...(listeners.get(source) ?? [])]) listener()
  }

  function resolveAsync(source: string, currentGeneration: number): void {
    const key = keyOf(source)

    void window.typeflow.assets
      .resolve({ target: source, baseDirectory })
      .then((absolutePath) => {
        // 基准目录已变（切了标签），这次结果作废
        if (currentGeneration !== generation) return
        cache.set(key, { absolutePath, status: 'resolved' })
        notify(source)
      })
      .catch(() => {
        if (currentGeneration !== generation) return
        cache.set(key, { absolutePath: null, status: 'resolved' })
        notify(source)
      })
  }

  return {
    assetDirectoryName: ASSET_DIRECTORY,

    setBaseDirectory(directory: string | null): void {
      if (directory === baseDirectory) return
      baseDirectory = directory
      // 代次递增让所有在途解析结果失效，避免旧结果写回新基准
      generation += 1
      cache.clear()
      // 复制一份再遍历：回调里可能重新注册
      for (const source of [...listeners.keys()]) notify(source)
    },

    get(source: string, onChange: () => void): ImageEntry {
      const key = keyOf(source)

      let subscribers = listeners.get(source)
      if (!subscribers) listeners.set(source, subscribers = new Set())
      subscribers.add(onChange)

      const cached = cache.get(key)
      if (cached) return cached

      const entry: ImageEntry = { absolutePath: null, status: 'pending' }
      cache.set(key, entry)
      resolveAsync(source, generation)
      return entry
    },

    unsubscribe(source: string, onChange: () => void): void {
      const subscribers = listeners.get(source)
      subscribers?.delete(onChange)
      if (subscribers?.size === 0) listeners.delete(source)
    },

    async storeImage(bytes: ArrayBuffer, extension: string): Promise<string> {
      // 必须有落点：未保存的文档没有目录，先让用户另存为
      if (!baseDirectory) {
        throw new Error(messages().error.imageNeedsSavedDocument)
      }

      const fileName = buildAssetFileName(extension)
      const absolutePath = `${baseDirectory}/${ASSET_DIRECTORY}/${fileName}`

      const result: AssetWriteResult = await window.typeflow.assets.write({
        filePath: absolutePath,
        bytes
      })
      void result

      // markdown 里记录相对路径：换机器、换目录都能继续工作
      return `${ASSET_DIRECTORY}/${fileName}`
    }
  }
}

/* ------------------------------------------------------------------ *
 * NodeView
 * ------------------------------------------------------------------ */

export class ImageNodeView implements NodeView {
  readonly dom: HTMLElement
  private readonly resolver: ImageResolver
  private source: string
  private destroyed = false
  private readonly onSourceChange = (): void => this.render()

  constructor(node: PMNode, resolver: ImageResolver) {
    this.resolver = resolver
    this.source = String(node.attrs.src ?? '')

    this.dom = document.createElement('span')
    this.dom.className = 'image-node'
    this.dom.setAttribute('contenteditable', 'false')

    this.render()
  }

  private render(): void {
    if (this.destroyed) return
    this.dom.replaceChildren()
    this.dom.classList.remove('is-pending', 'is-missing')
    this.dom.removeAttribute('title')

    if (this.source.trim().length === 0) {
      this.dom.classList.add('is-missing')
      this.dom.textContent = messages().error.assetContentEmpty
      return
    }

    const entry = this.resolver.get(this.source, this.onSourceChange)

    if (entry.status === 'pending') {
      this.dom.classList.add('is-pending')
      this.dom.textContent = `${messages().status.imageLoading} ${this.source}`
      return
    }

    if (entry.absolutePath === null) {
      // 文件缺失时显示路径而不是破图：用户能据此判断是文件丢了还是路径写错
      this.dom.classList.remove('is-pending')
      this.dom.classList.add('is-missing')
      this.dom.textContent = `${messages().error.imageMissing}：${this.source}`
      this.dom.title = messages().error.imageMissing
      return
    }

    this.dom.classList.remove('is-pending', 'is-missing')

    const image = document.createElement('img')
    image.src = toFileUrl(entry.absolutePath)
    image.alt = this.source
    image.draggable = false
    image.addEventListener('error', () => {
      if (this.destroyed || image.parentNode !== this.dom) return
      this.dom.classList.add('is-missing')
      this.dom.textContent = `${messages().error.imageCannotDisplay}：${this.source}`
    })

    this.dom.appendChild(image)
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'image') return false

    const nextSource = String(node.attrs.src ?? '')
    if (nextSource !== this.source) {
      this.resolver.unsubscribe(this.source, this.onSourceChange)
      this.source = nextSource
      this.render()
    }
    return true
  }

  /** 图片内部没有可编辑内容，所有事件交给自己处理。 */
  stopEvent(): boolean {
    return false
  }

  ignoreMutation(): boolean {
    return true
  }

  selectNode(): void {
    this.dom.classList.add('is-selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected')
  }

  destroy(): void {
    this.destroyed = true
    this.resolver.unsubscribe(this.source, this.onSourceChange)
    this.dom.replaceChildren()
  }
}

/* ------------------------------------------------------------------ *
 * 插入
 * ------------------------------------------------------------------ */

/** 供上层判断某次粘贴/拖入是否值得接管。 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') && extensionForMimeType(file.type) !== null
}

export interface ImageInsertResult {
  inserted: number
  failures: string[]
}

/**
 * 把图片文件写入资源目录并插入文档。
 *
 * 关键点：**读取字节必须走 arrayBuffer()，不能走 FileReader 的 dataURL**。
 * dataURL 会引入 base64 膨胀（体积 +33%）且需要在主进程再解码，
 * 直接传 ArrayBuffer 是最短且无损的路径。
 *
 * 多张图片时逐个插入：失败一张不会影响其余，且错误能精确报到具体文件名。
 */
export async function insertImageFiles(
  view: EditorView,
  files: readonly File[],
  resolver: ImageResolver,
  isCurrentDocument: () => boolean = () => true
): Promise<ImageInsertResult> {
  const images = files.filter(isImageFile)
  if (images.length === 0) return { inserted: 0, failures: [] }

  // 插入位置在循环中会随每次插入推进，因此单独维护
  let insertAt = view.state.selection.from
  let inserted = 0
  const failures: string[] = []

  for (const file of images) {
    if (view.isDestroyed || !isCurrentDocument()) break
    const extension = extensionForMimeType(file.type)
    if (!extension) {
      failures.push(`${file.name || '未命名'}：不支持的格式`)
      continue
    }

    try {
      const bytes = await file.arrayBuffer()
      // 读取和写盘期间可能切换标签或另存为；不能继续向旧内核或新文档插入。
      if (view.isDestroyed || !isCurrentDocument()) break
      const relativePath = await resolver.storeImage(bytes, extension)
      if (view.isDestroyed || !isCurrentDocument()) break

      const node = view.state.schema.nodes.image.create({
        src: relativePath,
        alt: file.name.replace(/\.[^.]*$/, '') || '图片',
        title: null
      })

      const transaction = view.state.tr.insert(insertAt, node)
      insertAt += node.nodeSize
      view.dispatch(transaction.scrollIntoView())
      inserted += 1
    } catch (error) {
      failures.push(`${file.name || '未命名'}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { inserted, failures }
}

export { ASSET_DIRECTORY }
export type { EditorView }
