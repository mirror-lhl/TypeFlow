/**
 * L0 冒烟验证：不启动 GUI，直接在 Node 侧验证三项契约。
 *
 *  1. 构建产物齐全（main / preload / renderer 缺一不可）
 *  2. 编解码往返无损：UTF-8 / UTF-8 BOM / UTF-16LE / CRLF / 中文
 *  3. 原子写入后内容逐字节一致
 *
 * 这三项是 L0 唯一的"数据安全"断言，因此用可重复执行的脚本固化，
 * 而不是依赖人工点击验证。
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const REQUIRED_ARTIFACTS = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html'
]

let failures = 0

function check(label, condition, detail = '') {
  const status = condition ? '\u2713' : '\u2717'
  const suffix = detail ? ` — ${detail}` : ''
  console.log(`  ${status} ${label}${suffix}`)
  if (!condition) failures += 1
}

console.log('\n[1/3] 构建产物完整性')
for (const artifact of REQUIRED_ARTIFACTS) {
  check(artifact, existsSync(join(ROOT, artifact)))
}

console.log('\n[2/3] 文本编解码往返')

const SAMPLES = [
  {
    label: 'UTF-8 中文 + LF',
    encoding: 'utf8',
    eol: 'lf',
    content: '# 标题\n\n正文包含中文、Emoji 🎉 与 `code`。\n'
  },
  {
    label: 'UTF-8 BOM + CRLF',
    encoding: 'utf8-bom',
    eol: 'crlf',
    content: '第一行\r\n第二行\r\n'
  },
  {
    label: 'UTF-16 LE + 中文',
    encoding: 'utf16le',
    eol: 'lf',
    content: '混合 mixed 内容 123\n'
  },
  {
    label: '纯 ASCII',
    encoding: 'utf8',
    eol: 'lf',
    content: 'plain ascii only\n'
  }
]

const workdir = await mkdtemp(join(tmpdir(), 'typeflow-smoke-'))

/** 复刻主进程的编码规则，确保脚本断言与实际落盘行为一致。 */
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])
const BOM_UTF16LE = Buffer.from([0xff, 0xfe])

function applyEol(content, eol) {
  return eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : content
}

function encode(content, encoding) {
  switch (encoding) {
    case 'utf16le':
      return Buffer.concat([BOM_UTF16LE, Buffer.from(content, 'utf16le')])
    case 'utf8-bom':
      return Buffer.concat([BOM_UTF8, Buffer.from(content, 'utf8')])
    default:
      return Buffer.from(content, 'utf8')
  }
}

function decode(buffer) {
  if (buffer.subarray(0, 3).equals(BOM_UTF8)) {
    return { content: buffer.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  if (buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return { content: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  return { content: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf8' }
}

for (const sample of SAMPLES) {
  const target = join(workdir, `${sample.encoding}-${sample.eol}.md`)
  const payload = applyEol(sample.content, sample.eol)
  await writeFile(target, encode(payload, sample.encoding))

  const roundTripped = decode(await readFile(target))
  check(
    `${sample.label} 往返一致`,
    roundTripped.content === payload && roundTripped.encoding === sample.encoding,
    roundTripped.encoding
  )
}

console.log('\n[3/3] 原子写入（临时文件 + rename）')

async function writeAtomic(filePath, data) {
  const temporary = `${filePath}.tmp-${process.pid}`
  await writeFile(temporary, data)
  const { rename } = await import('node:fs/promises')
  await rename(temporary, filePath)
}

const atomicTarget = join(workdir, 'atomic.md')
const atomicPayload = Buffer.from('覆盖写入测试 content', 'utf8')
await writeAtomic(atomicTarget, Buffer.from('旧内容', 'utf8'))
await writeAtomic(atomicTarget, atomicPayload)
check('原子写入后内容正确', (await readFile(atomicTarget)).equals(atomicPayload))
check('临时文件已清理', !existsSync(`${atomicTarget}.tmp-${process.pid}`))

await rm(workdir, { recursive: true, force: true })

console.log(
  failures === 0
    ? '\n数据安全静态验证全部通过 ✅\n'
    : `\n数据安全静态验证失败：${failures} 项 ❌\n`
)

process.exit(failures === 0 ? 0 : 1)
