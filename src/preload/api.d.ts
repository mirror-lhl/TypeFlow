import type { TypeFlowApi } from '../shared/ipc'

/**
 * 渲染进程看到的全局类型。
 * 与 preload 暴露的 TypeFlowApi 严格同构，改契约必然触发两端类型错误。
 */
declare global {
  interface Window {
    readonly typeflow: TypeFlowApi
  }
}

export {}
