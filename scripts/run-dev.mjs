#!/usr/bin/env node
/**
 * 开发/启动包装器。
 *
 * 解决两个环境相关的启动问题：
 *
 * 1. **`ELECTRON_RUN_AS_NODE` 必须剔除。**
 *    该变量会让 Electron 退化为纯 Node 进程，此时 `require('electron')` 返回的对象上
 *    没有 `app`/`BrowserWindow`，表现为启动即抛
 *      TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *    外部工具链（IDE、终端集成、CI 运行器）常会预设这个变量并被静默继承。
 *
 * 2. **受限环境下需要关闭 Chromium 沙箱与 GPU。**
 *    无独立用户命名空间 / 无 GPU 的环境会刷屏 `sandbox initialization failed` 后 FATAL。
 *    这类参数必须传给 Electron 可执行文件本身，`electron-vite dev` 不提供该通道，
 *    因此这里用 `--noSandbox` 让 electron-vite 只负责构建与 dev server，
 *    再由本脚本以受控参数启动 Electron。
 *
 * 用 Node 包装而非 bash，是为了在 macOS / Linux / Windows 上行为一致。
 *
 * 用法：
 *   node scripts/run-dev.mjs dev                 开发模式（热更新）
 *   node scripts/run-dev.mjs start               启动已构建产物
 *   TYPEFLOW_NO_SANDBOX=1 node scripts/run-dev.mjs dev   受限环境降级
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const mode = process.argv[2] ?? 'dev'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/**
 * 受限环境降级开关。
 *
 * **默认不启用**——它会同时关掉渲染层沙箱，属于安全降级。
 * 仅在明确知道自己在受限环境（容器 / CI / 无 GPU）时才设置 TYPEFLOW_NO_SANDBOX=1。
 */
const RESTRICTED_ENV_FLAGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage'
]

const useRestrictedFallback = env.TYPEFLOW_NO_SANDBOX === '1'
const extraFlags = useRestrictedFallback ? RESTRICTED_ENV_FLAGS : []

const ELECTRON_BINARY = resolve(
  ROOT,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)

function requireFile(target, hint) {
  if (existsSync(target)) return
  console.error(`✗ 未找到 ${target}`)
  console.error(`  ${hint}`)
  process.exit(1)
}

/** 以受控参数启动 Electron，继承 stdio 以便日志直达终端。 */
function launchElectron(args, label) {
  requireFile(ELECTRON_BINARY, '请先运行 ./scripts/fetch-electron-binary.sh')
  console.log(`▸ 启动 Electron（${label}）`)

  const child = spawn(ELECTRON_BINARY, [...extraFlags, ...args], {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
}

/**
 * 开发模式：electron-vite 只负责构建与 dev server，Electron 由本脚本启动。
 *
 * 必须从 electron-vite 的输出里**捕获真实 dev server URL** 再启动 Electron：
 * 端口不一定是我们期望的那个（5173 可能已被占用，electron-vite 会自动换端口），
 * 写死地址会导致渲染层加载到空白或别的东西。
 */
function runDevMode() {
  console.log(
    `▸ 开发模式（已剔除 ELECTRON_RUN_AS_NODE${useRestrictedFallback ? '，受限环境降级已启用' : ''}）`
  )
  if (useRestrictedFallback) {
    console.warn('⚠ --no-sandbox 已启用，仅用于容器/CI，勿用于生产')
  }

  // 回退副本：electron-vite 会先同步写一份到 out/{main,preload} 再起 dev server
  const fallbackEnv = { ...env }
  const child = spawn('npx', ['--no-install', 'electron-vite', 'dev', '--noSandbox'], {
    cwd: ROOT,
    env: fallbackEnv,
    stdio: ['inherit', 'pipe', 'inherit']
  })

  let booted = false
  const watcher = (chunk) => {
    // 原样转发，保持开发体验不变
    process.stdout.write(chunk)
    if (booted) return

    const match = chunk.toString().match(/https?:\/\/localhost:\d+/)
    if (!match) return

    booted = true
    env.ELECTRON_RENDERER_URL = match[0]
    console.log(`▸ dev server: ${env.ELECTRON_RENDERER_URL}`)
    launchElectron(['.'], '连接 dev server')
  }

  child.stdout.on('data', watcher)
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
}

switch (mode) {
  case 'dev':
    runDevMode()
    break

  case 'preview':
    launchElectron(['.'], '预览已构建产物')
    break

  case 'start':
    requireFile(resolve(ROOT, 'out/main/index.js'), '请先运行 npm run build')
    launchElectron(['.'], '加载已构建产物')
    break

  default:
    console.error(`✗ 未知模式: ${mode}（可选 dev / preview / start）`)
    process.exit(1)
}
