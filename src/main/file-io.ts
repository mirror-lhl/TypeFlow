import { dialog, ipcMain } from 'electron'
import { readFile, writeFile, rename, stat, mkdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type {
  DocumentWriteResult,
  FileEncoding,
  LineEnding,
  LoadedDocument,
  OpenDocumentResult,
  SaveAsResult,
  WriteDocumentRequest
} from '../shared/ipc'
import { addRecentFile, getPreferences, rememberDirectory } from './preferences'
import { assertReadAccess, ensureWriteAccess, rememberBookmark } from './mas-access'
import { defaultSaveDirectory, resolveActiveWindow, setCurrentFilePath } from './window-state'
import { messages } from '../shared/i18n'
import {
  MARKDOWN_EXTENSIONS,
  OPENABLE_EXTENSIONS,
  TEXT_EXTENSIONS,
  VIEW_EXTENSIONS,
  bareExtensions,
  isDocumentPath,
  isOpenablePath
} from '../shared/document-types'

/** 单文件体积上限，避免 L0 阶段被超大文件拖死；L1+ 会替换为分片/流式策略。 */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM_UTF16LE = Buffer.from([0xff, 0xfe])

/** 从磁盘字节中剔除 BOM，并把编码信息一并返回，保证保存时能原样回写。 */
function stripBom(buffer: Buffer): { body: Buffer; encoding: FileEncoding | null } {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) {
    return { body: buffer.subarray(3), encoding: 'utf8-bom' }
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return { body: buffer.subarray(2), encoding: 'utf16le' }
  }
  return { body: buffer, encoding: null }
}

/** 探测换行风格；取首个换行符，避免全文扫描。 */
function detectLineEnding(text: string): LineEnding {
  const index = text.indexOf('\n')
  if (index > 0 && text.charCodeAt(index - 1) === 13) return 'crlf'
  return 'lf'
}

/**
 * 无 BOM 时的编码判定。
 * 先用 fatal UTF-8 严格解码：通过即 UTF-8；抛错则回退 GBK，
 * 这是中文 Windows 遗留 Markdown 文档最常见的真实场景。
 */
function decodeWithoutBom(buffer: Buffer): {
  content: string
  encoding: FileEncoding
  guessed: boolean
} {
  try {
    const strict = new TextDecoder('utf-8', { fatal: true })
    return { content: strict.decode(buffer), encoding: 'utf8', guessed: false }
  } catch {
    try {
      const gbk = new TextDecoder('gbk')
      return { content: gbk.decode(buffer), encoding: 'gbk', guessed: true }
    } catch {
      // 运行环境不支持 gbk（极小概率）时退化为宽松 UTF-8，绝不丢字节
      return { content: buffer.toString('utf8'), encoding: 'utf8', guessed: true }
    }
  }
}

function decodeDocument(buffer: Buffer, normalizeEol: boolean): LoadedDocument {
  const { body, encoding: bomEncoding } = stripBom(buffer)

  let content: string
  let encoding: FileEncoding
  let guessed = false

  if (bomEncoding === 'utf16le') {
    content = body.toString('utf16le')
    encoding = 'utf16le'
  } else if (bomEncoding === 'utf8-bom') {
    // 显式去 BOM：Node 的 toString('utf8') 不会自动剥离，留着会污染文档首行
    content = body.subarray(0, 0).toString('utf8') + body.toString('utf8')
    encoding = 'utf8-bom'
  } else {
    const decoded = decodeWithoutBom(body)
    content = decoded.content
    encoding = decoded.encoding
    guessed = decoded.guessed
  }

  const eol = detectLineEnding(content)
  if (normalizeEol) content = content.replace(/\r\n/g, '\n')

  return {
    content,
    eol,
    encoding,
    byteLength: buffer.byteLength,
    encodingGuessed: guessed
  }
}

/**
 * 按目标编码回写（含 BOM 还原）。
 *
 * GBK 是只读能力：Node 没有内置 GBK 编码器。若文档含非 latin1 字符，
 * 强行按 GBK 回写会不可逆损坏中文，因此这里显式升级为 UTF-8 并把
 * 实际编码回传渲染层告知用户，绝不静默丢数据。
 */
function encodeForWrite(
  content: string,
  requested: FileEncoding
): { data: Buffer; applied: FileEncoding } {
  switch (requested) {
    case 'utf16le':
      return { data: Buffer.concat([BOM_UTF16LE, Buffer.from(content, 'utf16le')]), applied: 'utf16le' }
    case 'utf8-bom':
      return { data: Buffer.concat([BOM_UTF8, Buffer.from(content, 'utf8')]), applied: 'utf8-bom' }
    case 'gbk': {
      const asciiOnly = /^[\u0000-\u00ff]*$/.test(content)
      if (asciiOnly) {
        return { data: Buffer.from(content, 'latin1'), applied: 'gbk' }
      }
      return { data: Buffer.from(content, 'utf8'), applied: 'utf8' }
    }
    case 'utf8':
    default:
      return { data: Buffer.from(content, 'utf8'), applied: 'utf8' }
  }
}

/** CRLF 还原：只在需要时替换，避免对 LF 文档做无谓全文复制。 */
function applyLineEnding(content: string, eol: LineEnding): string {
  if (eol === 'lf') return content
  return content.replace(/\r?\n/g, '\r\n')
}

/** 沙箱下文件书签只覆盖文件本身，同目录建临时文件会被拒；权限错误时降级为直接覆盖写。 */
function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/**
 * 原子写入：先写同目录临时文件再 rename。
 * 崩溃或断电时最多丢失本次编辑，不会留下半截文档。
 * rename 在少数文件系统（跨设备、网络盘）上会失败，此时降级为直接覆盖写。
 */
async function writeAtomic(filePath: string, data: Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = join(dirname(filePath), `.typeflow-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporary, data)
  } catch (error) {
    if (!isPermissionError(error)) throw error
    console.warn('[typeflow] 沙箱禁止同目录临时文件，降级为直接覆盖写')
    await writeFile(filePath, data)
    return
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    console.warn('[typeflow] rename 失败，降级为直接覆盖写:', error)
    await writeFile(filePath, data)
  }
}

async function readDocument(filePath: string, normalizeEol = false): Promise<LoadedDocument> {
  const info = await stat(filePath)
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `${messages().error.documentTooLarge}（${(info.size / 1024 / 1024).toFixed(1)} MB / ${
        MAX_DOCUMENT_BYTES / 1024 / 1024
      } MB）`
    )
  }
  const buffer = await readFile(filePath)
  return decodeDocument(buffer, normalizeEol)
}

export function registerFileHandlers(): void {
  ipcMain.handle(CHANNELS.fileRead, async (_event, filePath: string, normalizeEol?: boolean) => {
    assertReadAccess(filePath)
    const document = await readDocument(filePath, normalizeEol ?? false)
    await addRecentFile(filePath)
    setCurrentFilePath(filePath)
    return document
  })

  ipcMain.handle(
    CHANNELS.fileWrite,
    async (_event, request: WriteDocumentRequest): Promise<DocumentWriteResult> => {
      await ensureWriteAccess(request.filePath)
      const payload = applyLineEnding(request.content, request.eol)
      const { data, applied } = encodeForWrite(payload, request.encoding)
      await writeAtomic(request.filePath, data)

      await addRecentFile(request.filePath)
      await rememberDirectory(dirname(request.filePath))
      setCurrentFilePath(request.filePath)

      return { byteLength: data.byteLength, encoding: applied }
    }
  )

  ipcMain.handle(CHANNELS.fileOpenDialog, async (): Promise<OpenDocumentResult> => {
    const window = resolveActiveWindow()
    const preferences = await getPreferences()

    const t = messages().dialog
    const result = await dialog.showOpenDialog(window as Electron.BrowserWindow, {
      title: t.openDocument,
      defaultPath: preferences.lastDirectory ?? undefined,
      properties: ['openFile'],
      securityScopedBookmarks: true,
      filters: [
        { name: t.openableFilter, extensions: bareExtensions(OPENABLE_EXTENSIONS) },
        { name: t.markdownFilter, extensions: bareExtensions(MARKDOWN_EXTENSIONS) },
        { name: t.textFilter, extensions: bareExtensions(TEXT_EXTENSIONS) },
        { name: t.viewFilter, extensions: bareExtensions(VIEW_EXTENSIONS) },
        { name: t.allFiles, extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null, document: null }
    }

    const filePath = result.filePaths[0]
    // 只读查看对象（PDF / HTML / 图片）不做文本解码：PDF 字节按 UTF-8 解码
    // 只会得到一堆替换字符，还白读一遍大文件。渲染层按扩展名选查看器。
    const document = isDocumentPath(filePath) ? await readDocument(filePath, false) : null

    if (isOpenablePath(filePath)) {
      await rememberBookmark(filePath, result.bookmarks?.[0], false)
      await addRecentFile(filePath)
      await rememberDirectory(dirname(filePath))
      setCurrentFilePath(filePath)
    }
    return { canceled: false, filePath, document }
  })

  ipcMain.handle(
    CHANNELS.fileSaveAsDialog,
    async (
      _event,
      options: { defaultPath?: string; suggestedName?: string }
    ): Promise<SaveAsResult> => {
      const window = resolveActiveWindow()
      const preferences = await getPreferences()

      // 优先级：显式传入 > 当前文件同目录 > 上次访问目录 > 用户文档目录
      const baseDirectory = defaultSaveDirectory() || preferences.lastDirectory || ''
      const fallbackName = options.suggestedName?.trim() || '未命名.md'
      const defaultPath =
        options.defaultPath ?? (baseDirectory ? join(baseDirectory, fallbackName) : fallbackName)

      const t = messages().dialog
      const result = await dialog.showSaveDialog(window as Electron.BrowserWindow, {
        title: t.saveAs,
        defaultPath,
        securityScopedBookmarks: true,
        filters: [
          { name: t.markdownFilter, extensions: bareExtensions(MARKDOWN_EXTENSIONS) },
          { name: t.textFilter, extensions: bareExtensions(TEXT_EXTENSIONS) },
          { name: t.allFiles, extensions: ['*'] }
        ]
      })

      if (result.canceled || !result.filePath) return { canceled: true, filePath: null }

      // 未写扩展名时补 .md，避免产出无后缀文件
      const filePath = extname(result.filePath) ? result.filePath : `${result.filePath}.md`
      await rememberBookmark(filePath, result.bookmark, false)
      await rememberDirectory(dirname(filePath))
      return { canceled: false, filePath }
    }
  )
}
