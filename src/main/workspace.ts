import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  FileTreeNode,
  SearchMatch,
  SearchResult,
  WorkspaceChangeEvent
} from '../shared/ipc'
import { messages } from '../shared/i18n'
import { DOCUMENT_EXTENSIONS, bareExtensions, isDocumentPath, isViewablePath } from '../shared/document-types'

const execFileAsync = promisify(execFile)

/**
 * 工作区（文件夹）能力：目录树、文件操作、内容搜索、变更监听。
 *
 * 设计取舍：
 *  - 树视图**不隐藏**任何文件（避免用户困惑），而是标记 `isText` / `isViewable`
 *    表示"能否打开、以及打开后可编辑还是只读"，由渲染层决定是否置灰
 *  - 搜索优先用 ripgrep（快且已处理各种边界），不可用时退化为纯 Node 遍历。
 *    两条路径返回同构结果，因此上层无需分支；可搜索范围与可**编辑**范围一致，
 *    只读查看对象（PDF / HTML / 图片）不参与全文搜索——搜到也跳不进去
 *  - 所有遍历都有深度与数量上限：工作区可能是任意大目录，不能让 UI 被拖死
 */

/** ripgrep 的 glob 由同一份扩展名清单生成，避免与目录树标记漂移。 */
const SEARCH_GLOB = `*.{${bareExtensions(DOCUMENT_EXTENSIONS).join(',')}}`

/** 递归遍历时跳过的目录名：版本控制、依赖、构建产物。 */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'release',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode'
])

const MAX_TREE_DEPTH = 12
const MAX_TREE_ENTRIES = 5000
const MAX_SEARCH_FILE_BYTES = 8 * 1024 * 1024
const MAX_SEARCH_RESULTS = 500
const MAX_MATCHES_PER_FILE = 20
const MAX_SNIPPET_LENGTH = 320

/* ------------------------------------------------------------------ *
 * 目录树
 * ------------------------------------------------------------------ */

interface TreeAccumulator {
  entries: number
  truncated: boolean
}

/** 目录优先、随后按名称排序：与常见文件管理器一致，用户不必重新适应。 */
function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

async function readDirectory(
  directoryPath: string,
  depth: number,
  accumulator: TreeAccumulator
): Promise<FileTreeNode[]> {
  if (depth > MAX_TREE_DEPTH) {
    accumulator.truncated = true
    return []
  }

  let dirents
  try {
    dirents = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    // 权限不足或目录消失：返回空而不是让整棵树失败
    return []
  }

  const nodes: FileTreeNode[] = []

  for (const dirent of dirents) {
    if (accumulator.entries >= MAX_TREE_ENTRIES) {
      accumulator.truncated = true
      break
    }
    if (dirent.name.startsWith('.') && dirent.name !== '.github') continue
    if (dirent.isDirectory() && SKIPPED_DIRECTORIES.has(dirent.name)) continue

    const childPath = join(directoryPath, dirent.name)
    accumulator.entries += 1

    if (dirent.isDirectory()) {
      nodes.push({
        name: dirent.name,
        path: childPath,
        isDirectory: true,
        isText: false,
        isViewable: false,
        children: await readDirectory(childPath, depth + 1, accumulator)
      })
    } else {
      let size = 0
      try {
        size = (await stat(childPath)).size
      } catch {
        // 读取失败时保持 0，不影响展示
      }
      nodes.push({
        name: dirent.name,
        path: childPath,
        isDirectory: false,
        isText: isDocumentPath(childPath),
        isViewable: isViewablePath(childPath),
        size
      })
    }
  }

  nodes.sort(compareNodes)
  return nodes
}

export async function readWorkspaceTree(
  directoryPath: string
): Promise<{ root: FileTreeNode; truncated: boolean }> {
  const absolute = resolve(directoryPath)
  const accumulator: TreeAccumulator = { entries: 0, truncated: false }
  const children = await readDirectory(absolute, 0, accumulator)

  return {
    root: {
      name: basename(absolute) || absolute,
      path: absolute,
      isDirectory: true,
      isText: false,
      isViewable: false,
      children
    },
    truncated: accumulator.truncated
  }
}

/* ------------------------------------------------------------------ *
 * 文件操作
 * ------------------------------------------------------------------ */

/** 路径必须位于工作区内，防止渲染层被诱导去操作任意位置。 */
export function assertInsideWorkspace(workspacePath: string, targetPath: string): void {
  const workspace = resolve(workspacePath)
  const target = resolve(targetPath)
  if (target !== workspace && !target.startsWith(workspace + sep)) {
    throw new Error(messages().error.pathOutsideWorkspace)
  }
}

export async function createWorkspaceFile(
  workspacePath: string,
  targetPath: string,
  content = ''
): Promise<void> {
  assertInsideWorkspace(workspacePath, targetPath)
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' })
}

export async function createWorkspaceDirectory(
  workspacePath: string,
  targetPath: string
): Promise<void> {
  assertInsideWorkspace(workspacePath, targetPath)
  await mkdir(targetPath, { recursive: true })
}

export async function renameWorkspaceEntry(
  workspacePath: string,
  fromPath: string,
  toPath: string
): Promise<void> {
  assertInsideWorkspace(workspacePath, fromPath)
  assertInsideWorkspace(workspacePath, toPath)
  await mkdir(dirname(toPath), { recursive: true })
  await rename(fromPath, toPath)
}

export async function deleteWorkspaceEntry(
  workspacePath: string,
  targetPath: string
): Promise<void> {
  assertInsideWorkspace(workspacePath, targetPath)
  const workspace = resolve(workspacePath)
  if (resolve(targetPath) === workspace) throw new Error(messages().error.cannotDeleteRoot)
  await rm(targetPath, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * 内容搜索
 * ------------------------------------------------------------------ */

let ripgrepAvailable: boolean | null = null

async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable
  // 沙箱下不应依赖系统外部二进制：直接走内置 Node 搜索
  if (process.mas === true) {
    ripgrepAvailable = false
    return false
  }
  try {
    await execFileAsync('rg', ['--version'], { timeout: 3000 })
    ripgrepAvailable = true
  } catch {
    ripgrepAvailable = false
  }
  return ripgrepAvailable
}

function buildSnippet(line: string, column: number, matchLength: number): string {
  if (line.length <= MAX_SNIPPET_LENGTH) return line
  const half = Math.floor((MAX_SNIPPET_LENGTH - matchLength) / 2)
  const start = Math.max(0, column - half)
  const end = Math.min(line.length, start + MAX_SNIPPET_LENGTH)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  return `${prefix}${line.slice(start, end)}${suffix}`
}

/**
 * ripgrep 搜索。
 *
 * 用 `--json` 而非默认输出：默认输出的转义规则与列号语义在不同版本间有差异，
 * JSON 是稳定契约。
 */
async function searchWithRipgrep(
  workspacePath: string,
  query: string,
  caseSensitive: boolean
): Promise<SearchResult> {
  const args = [
    '--json',
    '--line-number',
    '--max-count',
    String(MAX_MATCHES_PER_FILE),
    '--max-filesize',
    String(MAX_SEARCH_FILE_BYTES),
    '--glob',
    SEARCH_GLOB,
    ...(caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
    '--fixed-strings',
    '--',
    query,
    '.'
  ]

  const { stdout } = await execFileAsync('rg', args, {
    cwd: workspacePath,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000
  })

  const byFile = new Map<string, SearchMatch[]>()
  let total = 0

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue

    let parsed: {
      type?: string
      data?: {
        path?: { text?: string }
        line_number?: number
        lines?: { text?: string }
        submatches?: { start?: number; end?: number }[]
      }
    }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type !== 'match' || !parsed.data) continue

    const relativePath = parsed.data.path?.text ?? ''
    if (relativePath.length === 0) continue

    const lineNumber = parsed.data.line_number ?? 0
    const text = (parsed.data.lines?.text ?? '').replace(/\r?\n$/, '')
    const start = parsed.data.submatches?.[0]?.start ?? 0

    const matches = byFile.get(relativePath) ?? []
    if (matches.length >= MAX_MATCHES_PER_FILE) continue
    matches.push({
      line: lineNumber,
      column: start,
      snippet: buildSnippet(text, start, query.length),
      lineText: text
    })
    byFile.set(relativePath, matches)
    total += 1
    if (total >= MAX_SEARCH_RESULTS) break
  }

  return finalizeSearch(workspacePath, byFile, total)
}

/** 纯 Node 搜索：ripgrep 不可用时的退路，结果结构与 ripgrep 路径完全一致。 */
async function searchWithNode(
  workspacePath: string,
  query: string,
  caseSensitive: boolean
): Promise<SearchResult> {
  const needle = caseSensitive ? query : query.toLowerCase()
  const byFile = new Map<string, SearchMatch[]>()
  const queue: string[] = [resolve(workspacePath)]
  let total = 0
  let visited = 0

  // 广度优先遍历：便于用 visited 数量兜住最坏情况，不会在超大目录上失控
  while (queue.length > 0 && total < MAX_SEARCH_RESULTS && visited < MAX_TREE_ENTRIES) {
    const directory = queue.shift() as string

    let dirents
    try {
      dirents = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      if (visited >= MAX_TREE_ENTRIES || total >= MAX_SEARCH_RESULTS) break
      if (dirent.name.startsWith('.')) continue
      if (dirent.isDirectory() && SKIPPED_DIRECTORIES.has(dirent.name)) continue

      const childPath = join(directory, dirent.name)
      visited += 1

      if (dirent.isDirectory()) {
        queue.push(childPath)
        continue
      }
      if (!isDocumentPath(childPath)) continue

      let content: string
      try {
        const info = await stat(childPath)
        if (info.size > MAX_SEARCH_FILE_BYTES) continue
        content = await readFile(childPath, 'utf8')
      } catch {
        continue
      }

      const lines = content.split(/\r?\n/)
      const matches: SearchMatch[] = []

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const haystack = caseSensitive ? line : line.toLowerCase()
        const column = haystack.indexOf(needle)
        if (column < 0) continue

        matches.push({
          line: index + 1,
          column,
          snippet: buildSnippet(line, column, query.length),
          lineText: line
        })
        total += 1
        if (matches.length >= MAX_MATCHES_PER_FILE || total >= MAX_SEARCH_RESULTS) break
      }

      if (matches.length > 0) byFile.set(relative(workspacePath, childPath), matches)
    }
  }

  return finalizeSearch(workspacePath, byFile, total)
}

function finalizeSearch(
  workspacePath: string,
  byFile: Map<string, SearchMatch[]>,
  total: number
): SearchResult {
  const files = [...byFile.entries()]
    .map(([relativePath, matches]) => ({
      path: join(workspacePath, relativePath),
      relativePath: relativePath.replace(/^\.\//, ''),
      matches
    }))
    // 命中多的文件排前面：用户更可能想先看这些
    .sort((a, b) => b.matches.length - a.matches.length || a.relativePath.localeCompare(b.relativePath))

  return { files, totalMatches: total, truncated: total >= MAX_SEARCH_RESULTS }
}

export async function searchWorkspace(
  workspacePath: string,
  query: string,
  caseSensitive = false
): Promise<SearchResult> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { files: [], totalMatches: 0, truncated: false }

  if (await hasRipgrep()) {
    try {
      return await searchWithRipgrep(workspacePath, trimmed, caseSensitive)
    } catch {
      // ripgrep 退出码 1 表示"无匹配"，2 表示出错；统一退化到 Node 实现更稳妥
      return searchWithNode(workspacePath, trimmed, caseSensitive)
    }
  }
  return searchWithNode(workspacePath, trimmed, caseSensitive)
}

/* ------------------------------------------------------------------ *
 * 变更监听
 * ------------------------------------------------------------------ */

const watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>()

/**
 * 监听工作区变化并去抖后通知渲染层刷新。
 *
 * 只监听工作区根目录（非递归）：跨平台递归监听行为差异大，
 * 且编辑器自身保存也会触发事件。根目录一层足以覆盖"新建/删除文件"这类主要场景，
 * 深层改动由用户手动刷新兜底——把复杂度留给 L5 的性能优化阶段。
 */
export function startWatching(
  workspacePath: string,
  onEvent: (event: WorkspaceChangeEvent) => void
): void {
  stopWatching(workspacePath)

  let watcher: FSWatcher
  try {
    watcher = watch(workspacePath, { persistent: false })
  } catch {
    return
  }

  const entry = { watcher, timer: null as NodeJS.Timeout | null }
  watchers.set(workspacePath, entry)

  watcher.on('all', (eventType, filename) => {
    // 忽略临时文件（原子写入会产生 .typeflow-* 临时文件）
    if (filename && filename.startsWith('.typeflow-')) return

    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      onEvent({
        workspacePath,
        eventType: eventType as WorkspaceChangeEvent['eventType'],
        fileName: filename ?? null
      })
    }, 250)
  })
}

export function stopWatching(workspacePath: string): void {
  const entry = watchers.get(workspacePath)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.watcher.close()
  watchers.delete(workspacePath)
}

export function stopAllWatching(): void {
  for (const path of [...watchers.keys()]) stopWatching(path)
}
