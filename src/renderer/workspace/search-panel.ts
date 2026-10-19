import type { SearchMatch, SearchResult } from '../../shared/ipc'
import { messages } from '../../shared/i18n'

/**
 * 工作区内容搜索面板。
 *
 * 交互要点：
 *  - 输入去抖 300ms：搜索要遍历磁盘，逐字触发会持续占用主进程
 *  - 每次搜索带序号，**只接受最新一次的结果**：用户快速输入时，
 *    先发出的请求可能后返回，否则会看到与当前关键词不匹配的旧结果
 *  - 结果按文件分组，点击跳转到该行
 */

export interface SearchPanelCallbacks {
  onSearch(query: string, caseSensitive: boolean): Promise<SearchResult>
  /** 传入整条匹配而非仅行号：跳转需要行文本才能可靠定位 */
  onOpenMatch(filePath: string, match: SearchMatch): void
  onError(message: string): void
}

export interface SearchPanelView {
  /** 语言切换后刷新占位符（它由模块自绘，不在 data-i18n 标注体系里） */
  refreshLocaleText(): void
  focus(): void
  setWorkspaceReady(ready: boolean): void
  destroy(): void
}

const DEBOUNCE_MS = 300

export function createSearchPanel(
  host: HTMLElement,
  callbacks: SearchPanelCallbacks
): SearchPanelView {
  const controls = document.createElement('div')
  controls.className = 'search-controls'

  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'search-input'
  input.placeholder = messages().panel.searchPlaceholder

  /**
   * 语言切换后刷新自绘文案。
   *
   * 三处文案都是构造时取一次 `messages()`，之后不会自己更新：
   * 占位符、区分大小写的 title、以及"未打开工作区"的空状态提示。
   * 它们都不在 `data-i18n*` 标注体系里（由模块自绘）。
   */
  const refreshLocaleText = (): void => {
    input.placeholder = messages().panel.searchPlaceholder
    caseToggle.title = messages().panel.caseSensitive
    // 空状态只在"无工作区"时显示；有工作区时它是空字符串，不该被写回提示
    if (!workspaceReady) setStatus(messages().panel.noWorkspace, 'warn')
  }

  const caseToggle = document.createElement('label')
  caseToggle.className = 'search-case'
  const caseCheckbox = document.createElement('input')
  caseCheckbox.type = 'checkbox'
  const caseText = document.createElement('span')
  caseText.textContent = 'Aa'
  caseToggle.append(caseCheckbox, caseText)
  caseToggle.title = messages().panel.caseSensitive

  controls.append(input, caseToggle)

  const status = document.createElement('p')
  status.className = 'panel-empty'
  status.textContent = messages().panel.noWorkspace

  const results = document.createElement('div')
  results.className = 'search-results'

  host.replaceChildren(controls, status, results)

  let workspaceReady = false
  let timer: number | undefined
  /** 搜索序号：只接受最新一次请求的结果，避免乱序覆盖 */
  let requestSequence = 0

  function setStatus(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    status.textContent = text
    status.dataset.tone = tone
    status.hidden = text.length === 0
  }

  function paint(result: SearchResult): void {
    const fragment = document.createDocumentFragment()

    for (const file of result.files) {
      const group = document.createElement('div')
      group.className = 'search-group'

      const header = document.createElement('div')
      header.className = 'search-file'
      header.textContent = `${file.relativePath}`
      header.title = file.path

      const count = document.createElement('span')
      count.className = 'search-count'
      count.textContent = String(file.matches.length)
      header.appendChild(count)

      group.appendChild(header)

      for (const match of file.matches) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'search-match'

        const lineLabel = document.createElement('span')
        lineLabel.className = 'search-line'
        lineLabel.textContent = `${match.line}`

        const snippet = document.createElement('span')
        snippet.className = 'search-snippet'
        snippet.textContent = match.snippet.trim()

        item.append(lineLabel, snippet)
        item.addEventListener('click', () => callbacks.onOpenMatch(file.path, match))
        group.appendChild(item)
      }

      fragment.appendChild(group)
    }

    results.replaceChildren(fragment)
  }

  async function runSearch(): Promise<void> {
    const query = input.value.trim()
    if (!workspaceReady) {
      setStatus(messages().panel.noWorkspace, 'warn')
      results.replaceChildren()
      return
    }
    if (query.length === 0) {
      setStatus('')
      results.replaceChildren()
      return
    }

    requestSequence += 1
    const sequence = requestSequence
    setStatus(messages().panel.searching)

    try {
      const result = await callbacks.onSearch(query, caseCheckbox.checked)
      // 过期结果直接丢弃：用户已经改了关键词
      if (sequence !== requestSequence) return

      if (result.totalMatches === 0) {
        setStatus(`${messages().panel.noResults}：${query}`)
        results.replaceChildren()
        return
      }

      const panel = messages().panel
      const summary = result.truncated
        ? `${panel.showingFirst} ${result.totalMatches} ${panel.matchCount}${panel.limitReached}`
        : `${result.totalMatches} ${panel.matchCount} · ${result.files.length} ${panel.fileCount}`
      setStatus(summary, result.truncated ? 'warn' : 'info')
      paint(result)
    } catch (error) {
      if (sequence !== requestSequence) return
      setStatus(`${messages().error.searchFailed}：${error instanceof Error ? error.message : String(error)}`, 'error')
      results.replaceChildren()
    }
  }

  input.addEventListener('input', () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => void runSearch(), DEBOUNCE_MS)
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (timer !== undefined) window.clearTimeout(timer)
      void runSearch()
    }
  })

  caseCheckbox.addEventListener('change', () => void runSearch())

  return {
    refreshLocaleText,

    focus(): void {
      input.focus()
      input.select()
    },
    setWorkspaceReady(ready: boolean): void {
      workspaceReady = ready
      input.disabled = !ready
      if (!ready) {
        results.replaceChildren()
        setStatus(messages().panel.noWorkspace, 'warn')
      } else {
        setStatus('')
      }
    },
    destroy(): void {
      if (timer !== undefined) window.clearTimeout(timer)
      host.replaceChildren()
    }
  }
}
