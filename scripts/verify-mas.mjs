#!/usr/bin/env node
/**
 * Mac App Store 构建校验。
 *
 * 存在原因：App Store 提交是**一次性**的——构建有问题要等审核驳回，
 * 一轮就是几天。而商店版与站外版共用同一份代码，差异全在构建配置与
 * entitlements 上，这类错误在开发态完全看不出来。
 *
 * 检查两类东西：
 *  1. **静态配置**：entitlements 是否包含沙箱与书签所需的键、构建号是否存在、
 *     商店材料是否齐备。这些不需要证书就能查。
 *  2. **运行时行为**：真的构建一个 MAS 包，在上面跑完整自检，
 *     确认 `process.mas` 分支生效（自更新被禁用、书签路径启用）。
 *
 * 用法：node scripts/verify-mas.mjs           # 静态检查 + 构建 + 自检
 *       node scripts/verify-mas.mjs --static  # 只做静态检查（秒级）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const staticOnly = process.argv.includes('--static')

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function plist(source, path) {
  const full = resolve(ROOT, path)
  if (!existsSync(full)) {
    check(`entitlements 存在: ${path}`, false, '文件缺失')
    return null
  }
  return source
}

/* ---------------- 1. MAS entitlements ---------------- */
console.log('\n▸ MAS entitlements')

const masPlist = plist(readFileSync(resolve(ROOT, 'build/entitlements.mas.plist'), 'utf8'), 'build/entitlements.mas.plist')
const inheritPlist = plist(readFileSync(resolve(ROOT, 'build/entitlements.mas.inherit.plist'), 'utf8'), 'build/entitlements.mas.inherit.plist')

/** plist 里的键是否以 `<true/>` 值出现。 */
function hasTrue(contents, key) {
  const pattern = new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true\\s*/>`)
  return pattern.test(contents)
}

/** plist 里是否存在某个键（不论值）。 */
function hasKey(contents, key) {
  return contents.includes(`<key>${key}</key>`)
}

if (masPlist) {
  /**
   * 这四个是 MAS 的硬性要求：
   * - app-sandbox：商店强制沙箱
   * - bookmarks.app-scope：**持久化文件访问授权的必要条件**，缺了它
   *   `startAccessingSecurityScopedResource` 在下次启动时失败，
   *   最近文档 / assets 写入 / 工作区全部失效
   * - user-selected.read-write：用户经对话框选中的文件可读写
   * - allow-jit：Electron/Chromium 的 JIT 需要
   */
  for (const key of [
    'com.apple.security.app-sandbox',
    'com.apple.security.files.bookmarks.app-scope',
    'com.apple.security.files.user-selected.read-write',
    'com.apple.security.cs.allow-jit'
  ]) {
    check(`MAS 含 ${key}`, masPlist !== null && hasTrue(masPlist, key))
  }

  // 站外版不应带沙箱：两者混用会导致站外版无法正常读写任意路径
  const macPlistPath = resolve(ROOT, 'build/entitlements.mac.plist')
  const macPlist = existsSync(macPlistPath) ? readFileSync(macPlistPath, 'utf8') : ''
  check(
    '站外版 entitlements 不含沙箱（两套配置已分离）',
    macPlist.length > 0 && !hasKey(macPlist, 'com.apple.security.app-sandbox')
  )
}

if (inheritPlist) {
  check('子进程 entitlements 同样启用沙箱', hasTrue(inheritPlist, 'com.apple.security.app-sandbox'))
}

/* ---------------- 2. 构建配置 ---------------- */
console.log('\n▸ 构建配置')

const builderConfig = readFileSync(resolve(ROOT, 'electron-builder.yml'), 'utf8')
const masSection = builderConfig.slice(builderConfig.indexOf('\nmas:'))

check('electron-builder.yml 含 mas 段', masSection.length > 0)
check('mas 段引用 MAS entitlements', masSection.includes('build/entitlements.mas.plist'))
check('mas 段引用子进程 entitlements', masSection.includes('build/entitlements.mas.inherit.plist'))
check(
  'mas 段声明 CFBundleVersion（商店要求单调递增）',
  /bundleVersion:\s*"?\d+"?/.test(masSection),
  `bundleVersion=${masSection.match(/bundleVersion:\s*"?(\d+)"?/)?.[1] ?? '未找到'}`
)

const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
check('市场版本号有效', /^\d+\.\d+\.\d+$/.test(packageJson.version), packageJson.version)

/* ---------------- 3. 商店材料 ---------------- */
console.log('\n▸ 商店材料')

for (const path of [
  'store/listing.md',
  'store/privacy-policy.md',
  'store/screenshots/mac-1440x900.png',
  'store/screenshots/mac-1440x900-en.png'
]) {
  check(`存在 ${path}`, existsSync(resolve(ROOT, path)))
}

// 图标：App Store 要求 1024×1024 营销图标
const iconPath = resolve(ROOT, 'build/icon.png')
if (existsSync(iconPath)) {
  const dimensions = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', iconPath], {
    encoding: 'utf8'
  })
  const width = Number(/pixelWidth:\s*(\d+)/.exec(dimensions)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(dimensions)?.[1] ?? 0)
  check('商店图标为 1024×1024', width === 1024 && height === 1024, `${width}×${height}`)
} else {
  check('商店图标存在', false, 'build/icon.png 缺失')
}

if (staticOnly) {
  console.log(failures === 0 ? '\n✓ MAS 静态检查通过 ✅\n' : `\n✗ ${failures} 项检查失败 ❌\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/* ---------------- 4. 构建 MAS 包并跑自检 ---------------- */
console.log('\n▸ 构建源码（确保打包的是当前代码）')

/**
 * 必须先构建。
 *
 * electron-builder 只是把 `out/` 打进 asar——如果源码改了而没重建，
 * 校验跑的是**上一次的产物**。实测中就因此跑出 172 项断言（当前应为 257），
 * 而脚本却报告"自检通过"：断言数量变少是唯一线索，很容易被忽略。
 */
try {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
} catch {
  console.error('✗ 构建失败')
  process.exit(1)
}

console.log('\n▸ 构建 MAS 包（dir 目标，无需证书）')

try {
  // electron-builder 26 移除了顶层的 `--mas` 开关：mas 现在是 --mac 下的 target
  execFileSync('npx', ['electron-builder', '--mac', 'mas', '--arm64'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE:
        process.env.ELECTRON_BUILDER_CACHE ?? `${process.env.TMPDIR ?? '/tmp'}typeflow-builder-cache`
    }
  })
} catch {
  console.error('✗ MAS 构建失败')
  process.exit(1)
}

/**
 * 产物目录名取决于签名状态：无证书时可能是 `mas-arm64` 或 `mas-dev-arm64`。
 * 两种都接受，但**优先取本次构建实际产出的那个**——取错目录会跑到旧产物上，
 * 而旧产物同样能"自检通过"，只是断言数量对不上（实测踩过）。
 */
const appPath = ['release/mas-arm64/TypeFlow.app', 'release/mas-dev-arm64/TypeFlow.app']
  .map((relative) => resolve(ROOT, relative))
  .filter((candidate) => existsSync(candidate))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]

if (!appPath) {
  console.error('✗ 未找到 MAS 构建产物（release/mas-arm64 或 release/mas-dev-arm64）')
  process.exit(1)
}

const binary = resolve(appPath, 'Contents/MacOS/TypeFlow')
console.log(`  产物: ${appPath}`)

console.log('\n▸ 在 MAS 包上运行完整自检')

/**
 * 必须剔除 ELECTRON_RUN_AS_NODE（会让 Electron 退化为纯 Node），
 * 并关闭 Chromium 沙箱与 GPU——受限环境里它们无法初始化。
 * 注意：这里的 --no-sandbox 是**进程级**降级，不影响 App Sandbox 的
 * entitlements 判定（后者由签名与 plist 决定）。
 */
const env = { ...process.env, ELECTRON_SMOKE_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE

let output = ''
try {
  output = execFileSync(
    binary,
    ['--no-sandbox', '--disable-gpu', '--disable-gpu-sandbox', '--disable-software-rasterizer'],
    { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
} catch (error) {
  output = `${error.stdout ?? ''}`
}

const summary = output.split('\n').find((line) => line.includes('断言')) ?? '（未找到断言汇总）'
console.log(`  ${summary.trim()}`)

const passed = output.includes('[typeflow] smoke test passed')
const masBranch = output.includes('商店版禁用自更新并给出商店口径原因')
const masFailed = /失败\s*[1-9]/.test(summary)

check('MAS 包自检通过', passed && !masFailed)
check('自检确认走了商店版分支（process.mas 生效）', masBranch)

const count = Number(/断言\s*(\d+)\s*项/.exec(summary)?.[1] ?? 0)
check(
  '断言数量与当前源码一致（防止跑到旧产物）',
  count >= 250,
  `${count} 项`
)

console.log(
  failures === 0 ? '\n✓ MAS 构建校验通过 ✅\n' : `\n✗ ${failures} 项检查失败 ❌\n`
)
process.exit(failures === 0 ? 0 : 1)
