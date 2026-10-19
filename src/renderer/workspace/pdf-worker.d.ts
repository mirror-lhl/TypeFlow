/**
 * `pdfjs-dist/legacy/build/pdf.worker.mjs` 的类型声明。
 *
 * 官方类型只覆盖包入口（`types/src/pdf.d.ts`）与 `legacy/build/pdf.d.mts`，
 * worker 构建产物没有声明文件。这里只声明实际用到的一项：
 * 把它赋给 `globalThis.pdfjsWorker`，让 pdf.js 走主线程 fake worker，
 * 而不是去 `new Worker(...)`（后者需要放宽 CSP 的 `worker-src`）。
 *
 * 用 legacy 而非默认构建的原因见 `viewer.ts` 的 `loadPdfJs`。
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
