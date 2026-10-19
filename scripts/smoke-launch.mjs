/**
 * 应用启动自检：真实启动 Electron，验证端到端通路。
 *
 * 只跑静态断言（verify-l0.mjs）是不够的——它能证明文件存在、编解码正确，
 * 但证明不了"窗口起来了、preload 桥通了、渲染层 init() 跑完了"。
 * 这三件事任一失败，应用都是"构建成功但打开即白屏"。
 *
 * 判定依据是渲染层经 IPC 显式回传的断言明细（不是 stdout 文本匹配——
 * 渲染进程的 console 输出并不保证映射到父进程 stdout）。
 *
 * 用法：node scripts/smoke-launch.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BINARY = resolve(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const ENTRY = resolve(ROOT, 'out/main/index.js')
const TIMEOUT_MS = 60_000

if (!existsSync(BINARY)) {
  console.error(`✗ 未找到 Electron 二进制: ${BINARY}`)
  console.error('  请先运行: ./scripts/fetch-electron-binary.sh')
  process.exit(1)
}

if (!existsSync(ENTRY)) {
  console.error('✗ 未找到构建产物 out/main/index.js，请先运行 npm run build')
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 构建门禁
 * ------------------------------------------------------------------ */

/** 递归收集某个路径下所有文件的修改时间；路径不存在时返回空数组。 */
function collectMtimes(target) {
  if (!existsSync(target)) return []

  const times = []
  const stack = [target]

  while (stack.length > 0) {
    const current = stack.pop()
    const info = statSync(current)
    if (info.isDirectory()) {
      for (const entry of readdirSync(current)) stack.push(resolve(current, entry))
    } else {
      times.push(info.mtimeMs)
    }
  }
  return times
}

const sourceTimes = [
  ...collectMtimes(resolve(ROOT, 'src')),
  ...collectMtimes(resolve(ROOT, 'index.html'))
]
const newestSource = sourceTimes.length > 0 ? Math.max(...sourceTimes) : 0

/**
 * 判据：**最旧的产物**必须新于**最新的源码**。
 *
 * 曾经的实现只看 `out/main/index.js` 是否比源码新，太宽松。
 * electron-vite 依次构建 main → preload → renderer，若上次构建中途中断、
 * 或只有渲染层源码被更新，main 的产物可能仍比源码新而 `out/renderer` 是旧的，
 * 于是自检跑在**过期的渲染层**上：断言数量悄悄变少（少掉的正是新加的那些），
 * 却依然报告"全绿"。
 *
 * 实测中同一份源码曾报出 172 与 231 两个不同的断言数，差异全部来自渲染层版本。
 *
 * 收紧判据可行：三个 target 都设了 `emptyOutDir: true`，每次构建重写全部产物，
 * 构建后"最旧产物"必然晚于"最新源码"。
 */
const artifactTimes = [
  ...collectMtimes(resolve(ROOT, 'out/main')),
  ...collectMtimes(resolve(ROOT, 'out/preload')),
  ...collectMtimes(resolve(ROOT, 'out/renderer'))
]

if (artifactTimes.length === 0) {
  console.error('✗ 未找到构建产物，请先运行 npm run build')
  process.exit(1)
}

const oldestArtifact = Math.min(...artifactTimes)

if (oldestArtifact < newestSource) {
  console.error('✗ 构建产物早于源码，自检会验证到过期代码')
  console.error(`  最新源码 ${new Date(newestSource).toLocaleString()}`)
  console.error(`  最旧产物 ${new Date(oldestArtifact).toLocaleString()}`)
  console.error('  请先运行: npm run build')
  process.exit(1)
}

/* ------------------------------------------------------------------ *
 * 用户配置污染检查
 * ------------------------------------------------------------------ */

/**
 * 记录用户真实配置文件的修改时间。
 *
 * 自检会切换主题、排版、语言、布局并写入偏好。如果它与正常使用共享
 * userData 目录，跑一次自检就会**污染用户的真实配置**——
 * 而且这个副作用没有任何界面提示，属于"悄悄改坏了用户的设置"。
 *
 * 因此启动前记录 mtime，结束后比对。这是对隔离效果的直接验证，
 * 比在应用内断言某个路径变量更有说服力。
 */
const realPreferencesPath = join(
  homedir(),
  'Library/Application Support/TypeFlow/typeflow-preferences.json'
)
const realPreferencesBefore = existsSync(realPreferencesPath)
  ? statSync(realPreferencesPath).mtimeMs
  : null

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

console.log('▸ 启动 Electron（自检模式，完成即退出）')

/**
 * 必须剔除 ELECTRON_RUN_AS_NODE：
 * 该变量会让 Electron 退化为纯 Node 进程，此时 require('electron') 返回的
 * 对象上没有 app/BrowserWindow（表现为 "Cannot read properties of undefined"）。
 * 若运行环境的父进程恰好设置了它，子进程会静默继承并导致自检失败。
 */
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
childEnv.ELECTRON_SMOKE_TEST = '1'
childEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'

/**
 * Chromium 的 GPU 进程与沙箱在受限运行环境（无独立用户命名空间）下无法初始化，
 * 表现为反复 "sandbox initialization failed" 后 FATAL 退出。
 * 自检只验证窗口与 IPC 通路，不测渲染性能，因此关掉 GPU 与两个沙箱层。
 *
 * 注意：这只影响自检进程，应用正常启动（npm run dev / Electron 图标启动）不受影响。
 */
const CHROMIUM_FLAGS = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-dev-shm-usage'
]

const child = spawn(BINARY, [...CHROMIUM_FLAGS, '.'], {
  cwd: ROOT,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
let finished = false

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  process.stdout.write(chunk.toString().replace(/^/gm, '  │ '))
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

function finish(code, message) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  console.log(message)
  process.exit(code)
}

const timer = setTimeout(() => {
  child.kill('SIGKILL')
  console.error(`\n✗ 启动超时（${TIMEOUT_MS / 1000}s）`)
  console.error('--- stderr ---')
  console.error(stderr.slice(-2000) || '(空)')
  finish(1, '')
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  const mainReady = stdout.includes('[typeflow] main window ready')
  const rendererReady = stdout.includes('[typeflow] renderer ready')
  const smokePassed = stdout.includes('[typeflow] smoke test passed')

  console.log('\n▸ 完整 stdout')
  console.log(stdout.trimEnd() || '(空)')

  console.log('\n▸ 自检结果')
  console.log(`  ${mainReady ? '✓' : '✗'} 主进程窗口创建成功`)
  console.log(`  ${rendererReady ? '✓' : '✗'} 渲染层 init() 完成（preload 桥畅通）`)
  console.log(`  ${smokePassed ? '✓' : '✗'} 应用自检通过`)

  if (code !== 0 && signal !== 'SIGTERM') {
    console.error(`\n✗ 进程异常退出 code=${code} signal=${signal}`)
    console.error(stderr.slice(-2000))
    finish(1, '')
    return
  }

  /**
   * 真实配置未被改动的检查。
   *
   * 允许"文件不存在"（从未运行过应用）与"文件存在但 mtime 未变"两种情况；
   * 只要 mtime 变了，就说明自检写进了用户的真实配置。
   */
  let isolationHeld = true
  let isolationDetail = '用户配置未被触碰（或尚不存在）'

  if (realPreferencesBefore !== null && existsSync(realPreferencesPath)) {
    const after = statSync(realPreferencesPath).mtimeMs
    if (after !== realPreferencesBefore) {
      isolationHeld = false
      isolationDetail = `用户配置被修改: ${realPreferencesPath}`
    }
  }

  console.log(
    `  ${isolationHeld ? '✓' : '✗'} 自检未污染用户配置${isolationHeld ? '' : ` — ${isolationDetail}`}`
  )

  const ok = mainReady && rendererReady && smokePassed && isolationHeld
  finish(ok ? 0 : 1, ok ? '\n应用启动自检通过 ✅\n' : '\n应用启动自检失败 ❌\n')
})
