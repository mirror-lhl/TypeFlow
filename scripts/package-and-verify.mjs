#!/usr/bin/env node
/**
 * 打包并验证应用。
 *
 * 存在原因：**"打包成功"不等于"打包产物能跑"**。
 * 本项目实际遇到过两个只在打包产物上出现的缺陷：
 *  - 更新检查向用户抛原始 ENOENT（缺 app-update.yml）
 *  - 依赖分类错误导致安装包多出 40 MB 的 node_modules
 *
 * 因此把"重新构建 → 打包 → 在产物上跑完整自检"固化成一条命令，
 * 避免每次都靠记忆手动执行（漏掉验证就等于没验证）。
 *
 * 同时解决"产物过期"这个隐蔽问题：源码改了但忘了重新打包时，
 * 你运行的仍是旧版本，而界面上完全看不出来。
 *
 * 用法：
 *   node scripts/package-and-verify.mjs            # 打包 dir 目标并验证（最快）
 *   node scripts/package-and-verify.mjs --zip      # 额外产出可分发 zip
 *   node scripts/package-and-verify.mjs --open     # 验证通过后打开应用
 *   node scripts/package-and-verify.mjs --skip-build   # 复用已有 out/（仅调试脚本时用）
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const wantZip = args.includes('--zip')
const wantOpen = args.includes('--open')
const skipBuild = args.includes('--skip-build')

const APP_PATH = resolve(ROOT, 'release/mac-arm64/TypeFlow.app')
const BINARY = resolve(APP_PATH, 'Contents/MacOS/TypeFlow')
const ASAR = resolve(APP_PATH, 'Contents/Resources/app.asar')

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options
  })
}

function step(label) {
  console.log(`\n▸ ${label}`)
}

/** 源码中最新的修改时间，用于判断打包产物是否过期。 */
function newestSourceMtime() {
  const output = execFileSync(
    'find',
    ['src', 'index.html', '-type', 'f', '-exec', 'stat', '-f', '%m', '{}', ';'],
    { cwd: ROOT, encoding: 'utf8' }
  )
  return Math.max(...output.split('\n').filter(Boolean).map(Number))
}

/* ---------------- 1. 构建 ---------------- */
const sourceMtime = newestSourceMtime()

if (skipBuild && existsSync(ASAR)) {
  const artifactMtime = statSync(ASAR).mtimeMs / 1000
  if (artifactMtime < sourceMtime) {
    console.error('✗ --skip-build 但产物早于源码，拒绝验证过期代码')
    process.exit(1)
  }
  step('跳过构建（--skip-build）')
} else {
  step('构建（typecheck + 三 target）')
  run('npm', ['run', 'build'])
}

/* ---------------- 2. 打包 ---------------- */
step(`打包（mac ${wantZip ? 'dir + zip' : 'dir'}）`)

// electron-builder 的 Electron 下载缓存默认在 ~/Library/Caches/electron，
// 受限环境下不可写；统一指向可写位置并复用已下载的包。
const packEnv = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE ?? `${process.env.TMPDIR ?? '/tmp'}typeflow-builder-cache`
}

run('npx', ['electron-builder', '--mac', 'dir', '--arm64'], { env: packEnv })
if (wantZip) run('npx', ['electron-builder', '--mac', 'zip', '--arm64'], { env: packEnv })

if (!existsSync(BINARY)) {
  console.error(`✗ 未找到打包产物: ${BINARY}`)
  process.exit(1)
}

/* ---------------- 3. 在产物上验证 ---------------- */
step('在打包产物上运行完整自检')

/**
 * 两个环境变量必须处理：
 *  - `ELECTRON_RUN_AS_NODE` 会让 Electron 退化成纯 Node 进程（报 bad option），
 *    必须真正删除而不是设为空串
 *  - 受限环境需要关闭 Chromium 沙箱与 GPU，否则直接 FATAL 退出
 */
const smokeEnv = { ...process.env, ELECTRON_SMOKE_TEST: '1' }
delete smokeEnv.ELECTRON_RUN_AS_NODE

const sandboxFlags = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer'
]

let smokeOutput = ''
try {
  smokeOutput = execFileSync(BINARY, sandboxFlags, {
    cwd: ROOT,
    env: smokeEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
} catch (error) {
  // 自检失败时进程返回非零，但 stdout 里仍有完整断言明细
  smokeOutput = `${error.stdout ?? ''}`
  if (!smokeOutput) {
    console.error('✗ 自检未能产出输出')
    console.error(error.stderr?.slice(-2000) ?? '')
    process.exit(1)
  }
}

const summary = smokeOutput.split('\n').find((line) => line.includes('断言')) ?? '（未找到断言汇总）'
console.log(`  ${summary.trim()}`)

const failed = /失败\s*[1-9]/.test(summary)
const passed = smokeOutput.includes('smoke test passed')

if (failed || !passed) {
  console.error('\n✗ 打包产物自检未通过')
  for (const line of smokeOutput.split('\n').filter((l) => l.includes('✗'))) {
    console.error(`  ${line.trim()}`)
  }
  process.exit(1)
}

/* ---------------- 4. 结果 ---------------- */
console.log('\n▸ 产物')
const appSize = execFileSync('du', ['-sh', APP_PATH], { encoding: 'utf8' }).split('\t')[0]
const asarSize = execFileSync('du', ['-h', ASAR], { encoding: 'utf8' }).split('\t')[0]
console.log(`  ${APP_PATH}`)
console.log(`    应用包 ${appSize}（其中 asar ${asarSize}）`)

if (wantZip) {
  const zips = execFileSync('ls', ['-1', resolve(ROOT, 'release')], { encoding: 'utf8' })
    .split('\n')
    .filter((name) => name.endsWith('.zip'))
  for (const name of zips) {
    const size = execFileSync('du', ['-h', resolve(ROOT, 'release', name)], { encoding: 'utf8' }).split('\t')[0]
    console.log(`    分发件 ${name}  ${size}`)
  }
}

console.log('\n✓ 打包产物已验证通过 ✅')
console.log('\n打开方式：')
console.log('  双击（或在终端执行）:')
console.log(`    open "${APP_PATH}"`)
console.log('  若被 Gatekeeper 拦下（未签名应用）:')
console.log('    右键 → 打开 → 在弹窗中再次点"打开"（只需一次）')

if (wantOpen) {
  console.log('\n▸ 正在打开…')
  spawn('open', [APP_PATH], { detached: true, stdio: 'ignore' }).unref()
}
