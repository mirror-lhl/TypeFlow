import { ipcMain } from 'electron'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { CHANNELS } from './ipc-channels'
import type { AssetWriteRequest, AssetWriteResult, ResolvePathRequest } from '../shared/ipc'
import { hasAccess, requestDirectoryAccess } from './mas-access'
import { messages } from '../shared/i18n'

/**
 * 二进制资源（图片）通道。
 *
 * 与 `file-io` 的文本通道分开：那条通道围绕"编码 + 换行风格"设计，
 * 用它传二进制必然经历一次无法保证无损的编码往返。
 *
 * 渲染层虽然已由 preload 白名单限制，但图片落点仍在这里做一次收敛：
 * 只允许写入 `assets/` 这类以点号或字母开头的常规目录，拒绝路径穿越。
 */

/** 单张图片上限。超过这个尺寸基本是误操作，且会让文档体积失控。 */
const MAX_ASSET_BYTES = 32 * 1024 * 1024

const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.avif'
])

/**
 * 校验资源写入路径。
 *
 * 规则：必须在请求给定的父目录之内，且扩展名在白名单内。
 * 不做"必须在工作区内"的限制——用户完全可以编辑工作区外的独立文件，
 * 其图片资源理应写在那个文件旁边。
 */
function assertSafeAssetPath(filePath: string): void {
  if (!isAbsolute(filePath)) throw new Error(messages().error.assetPathMustBeAbsolute)

  const extension = extname(filePath).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`${messages().error.unsupportedImageFormat}：${extension || '(none)'}`)
  }

  // 拒绝路径穿越：检查**未规范化**的原始路径段。
  // resolve() 会消掉 `..`，规范化之后再查是查不到的
  if (filePath.split(/[\\/]/).includes('..')) {
    throw new Error(messages().error.assetPathInvalid)
  }
}

export function registerAssetHandlers(): void {
  /**
   * 读取资源字节。
   *
   * 返回 `ArrayBuffer` 而非 Buffer：`Buffer` 经 IPC 会被序列化成
   * `{type:'Buffer',data:[...]}` 这种 Node 私有形态，渲染层拿不到干净的二进制。
   *
   * 有意不校验扩展名：读取不改变任何状态，且导出时需要读任意本地资源。
   */
  ipcMain.handle(CHANNELS.assetsRead, async (_event, filePath: string): Promise<ArrayBuffer | null> => {
    if (!isAbsolute(filePath)) return null
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null
      const buffer = await readFile(filePath)
      // 复制成独立的 ArrayBuffer，避免暴露 Buffer 的共享内存池
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    } catch {
      return null
    }
  })

  ipcMain.handle(
    CHANNELS.assetsWrite,
    async (_event, request: AssetWriteRequest): Promise<AssetWriteResult> => {
      assertSafeAssetPath(request.filePath)

      // 沙箱下文档旁的 assets/ 不在文件书签范围内：无授权时先请求目录授权
      if (!hasAccess(dirname(request.filePath))) {
        const granted = await requestDirectoryAccess(dirname(request.filePath))
        if (!granted) throw new Error(messages().error.sandboxFolderNeeded)
      }

      const bytes = Buffer.from(request.bytes)
      if (bytes.byteLength === 0) throw new Error(messages().error.assetContentEmpty)
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        throw new Error(
          `${messages().error.imageTooLarge}（${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB）`
        )
      }

      await mkdir(dirname(request.filePath), { recursive: true })
      await writeFile(request.filePath, bytes)

      return { filePath: request.filePath, byteLength: bytes.byteLength }
    }
  )

  /**
   * 把相对路径解析为绝对路径并确认存在。
   *
   * 渲染层需要它以两种形式使用：
   *  - 返回绝对路径：NodeView 用它构造 `file://` URL 才能显示本地图片
   *  - 返回 null：路径不存在时 NodeView 显示"缺失"占位而不是破图
   */
  ipcMain.handle(
    CHANNELS.assetsResolve,
    async (_event, request: ResolvePathRequest): Promise<string | null> => {
      const candidate =
        isAbsolute(request.target) || request.baseDirectory === null
          ? resolve(request.target)
          : resolve(join(request.baseDirectory, request.target))

      try {
        const info = await stat(candidate)
        if (!info.isFile()) return null
        await access(candidate)
        return candidate
      } catch {
        return null
      }
    }
  )
}
