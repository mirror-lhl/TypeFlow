#!/usr/bin/env node
/**
 * 商店截图捕获：以截图模式启动应用，渲染层铺好演示文档后回报，
 * 主进程按 Mac App Store 接受尺寸抓图，输出到 store/screenshots/。
 *
 * 一次跑出中英两套：中文（mac-1440x900.png）与英文（mac-1440x900-en.png），
 * 供 README 与发布页使用。
 *
 * 与 smoke-launch 同源：直接跑 out/ 构建结果，不需要先打包成 .app；
 * 截图模式使用隔离 userData，不会污染用户真实配置。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const BINARY = resolve(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const ENTRY = resolve(ROOT, 'out/main/index.js')
const OUT_DIR = resolve(ROOT, 'docs/screenshots')

/**
 * 受限运行环境下 Chromium 的 GPU 进程与沙箱无法初始化，
 * 表现为 "sandbox initialization failed" 后直接退出。
 * 截图只验证界面呈现，不测渲染性能，因此关掉 GPU 与两层沙箱。
 */
const CHROMIUM_FLAGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage'
]

for (const lang of ['zh', 'en']) {
  const env = {
    ...process.env,
    ELECTRON_SCREENSHOT: '1',
    ELECTRON_SCREENSHOT_DIR: OUT_DIR,
    ELECTRON_SCREENSHOT_LANG: lang
  }
  // 与 smoke-launch 一致：父 shell 若带该变量会把 Electron 变成纯 Node
  delete env.ELECTRON_RUN_AS_NODE

  // 跨屏移动窗口偶发 SIGSEGV（macOS 窗口服务瞬时问题），失败重试一次
  for (let attempt = 1; ; attempt += 1) {
    try {
      // 与 smoke-launch 使用同一组降级参数：受限环境下 Chromium 的 GPU 进程与
      // 沙箱无法初始化，不加这些参数会直接 "sandbox initialization failed" 退出
      execFileSync(BINARY, [...CHROMIUM_FLAGS, ENTRY], {
        env,
        stdio: 'inherit',
        timeout: 90_000
      })
      break
    } catch (error) {
      if (attempt >= 2) throw error
      console.warn(`[capture] ${lang} 首次抓图崩溃，重试一次…`)
    }
  }
}
console.log(`✓ 中英截图已输出到 ${OUT_DIR}`)
