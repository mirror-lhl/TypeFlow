/**
 * 标签栏。
 *
 * 每个标签需同时表达三件事：标题、是否脏、是否活动。
 * 脏标记用"●/✕ 互换"而非并排两个元素：鼠标悬停即可关闭，
 * 且不会因为多一个元素导致标题被挤压换行。
 */

import { messages } from '../../shared/i18n'

export interface TabItem {
  id: string
  title: string
  dirty: boolean
  /** 文件路径为 null 的未命名文档 */
  untitled: boolean
}

export interface TabBarCallbacks {
  onActivate(id: string): void
  onClose(id: string): void
}

export interface TabBarView {
  render(items: readonly TabItem[], activeId: string | null): void
  destroy(): void
}

export function createTabBar(host: HTMLElement, callbacks: TabBarCallbacks): TabBarView {
  const strip = document.createElement('div')
  strip.className = 'tab-strip'
  strip.setAttribute('role', 'tablist')
  host.replaceChildren(strip)

  return {
    render(items: readonly TabItem[], activeId: string | null): void {
      const fragment = document.createDocumentFragment()

      for (const item of items) {
        const tab = document.createElement('div')
        tab.className = 'tab'
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(item.id === activeId))
        if (item.id === activeId) tab.classList.add('is-active')
        if (item.dirty) tab.classList.add('is-dirty')

        const title = document.createElement('button')
        title.type = 'button'
        title.className = 'tab-title'
        title.textContent = item.title
        title.title = item.untitled ? `${item.title}${messages().dialog.tabUnsavedToFile}` : item.title
        title.addEventListener('click', () => callbacks.onActivate(item.id))

        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'tab-close'
        close.title = item.dirty ? messages().dialog.tabCloseDirty : messages().dialog.tabClose
        // 脏标记与关闭按钮共用位置：未脏显示 ✕，脏显示 ●，悬停时始终显示 ✕
        close.textContent = item.dirty ? '●' : '✕'
        close.addEventListener('click', (event) => {
          event.stopPropagation()
          callbacks.onClose(item.id)
        })

        tab.append(title, close)
        fragment.appendChild(tab)
      }

      strip.replaceChildren(fragment)
    },
    destroy(): void {
      host.replaceChildren()
    }
  }
}
