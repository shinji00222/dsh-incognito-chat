// 验证「没发生的事」：无痕对话有没有在 DSH_HOME 留下痕迹。
//
// 用法（默认检查隔离环境 work/isolated-dsh，可用 DSH_HOME 覆盖）：
//   node scripts/verify-no-trace.mjs snapshot            # 1. 开无痕对话之前拍快照
//   （在无痕对话里发一条带探针文字的消息，比如 INCOG-PROBE-xxxx，然后离开）
//   node scripts/verify-no-trace.mjs check INCOG-PROBE-xxxx   # 2. 对比 + 全盘搜探针
//
// 判定：
//   - sessions/ 下不能出现无痕 id 的目录
//   - 任何文件（包括解压后的 .zstd 会话日志）都不能包含探针文字
//   - workspace.json 里不能残留 session-incognito- id
// 新出现的普通会话文件只提示不判失败：DSH 点「新建会话」会给空白普通会话写一个只有表头的日志。
// 会话日志是 zstd 压缩的，用 Node 自带的 zlib.zstdDecompressSync 解开再搜（Node 22.15+）。

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME ?? path.join(root, 'work/isolated-dsh')
const snapshotFile = path.join(root, 'work/no-trace-snapshot.json')
const SKIP = new Set(['profiles', 'node_modules', '.credentials.yaml', 'dsh-runtimes', 'cache'])

/** @returns {Record<string, number>} 相对路径 → 大小 */
function listFiles(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) listFiles(full, base, out)
    else out[path.relative(base, full).replaceAll('\\', '/')] = stat.size
  }
  return out
}

/**
 * DSH 的会话日志是多个 zstd 帧首尾相接（每批事件一帧）。
 * zlib.zstdDecompressSync 只解第一帧（实测：10 帧的文件只解出表头）——直接用会漏检！
 * 所以在每个帧魔数（28 B5 2F FD）处各解一次，解不开的（数据里碰巧出现的魔数）跳过。
 * @param {Buffer} buf
 */
export function decodeAllFrames(buf) {
  const parts = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) {
    try { parts.push(zstdDecompressSync(buf.subarray(i))) } catch { /* 不是真的帧头 */ }
  }
  return Buffer.concat(parts)
}
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const [command, probe] = process.argv.slice(2)

if (command === 'snapshot') {
  writeFileSync(snapshotFile, JSON.stringify(listFiles(home), null, 2))
  console.log(`snapshot saved: ${Object.keys(listFiles(home)).length} files under ${home}`)
} else if (command === 'check') {
  if (!existsSync(snapshotFile)) throw new Error('run "snapshot" first')
  const before = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  const after = listFiles(home)
  const added = Object.keys(after).filter((f) => !(f in before))
  const problems = []

  const incognitoDirs = Object.keys(after).filter((f) => f.startsWith('sessions/') && f.includes('session-incognito-'))
  if (incognitoDirs.length) problems.push(`incognito session files on disk: ${incognitoDirs.join(', ')}`)
  const newSessionFiles = added.filter((f) => f.startsWith('sessions/'))
  if (newSessionFiles.length) console.log(`note: new ordinary session files (checked for probe below): ${newSessionFiles.join(', ')}`)

  if (probe) {
    for (const file of Object.keys(after)) {
      let bytes = readFileSync(path.join(home, file))
      if (file.endsWith('.zstd')) bytes = decodeAllFrames(bytes)
      if (bytes.includes(probe)) problems.push(`probe text found in ${file}`)
    }
  }

  const workspace = path.join(home, 'storages/workspace.json')
  if (existsSync(workspace) && /session-incognito-/.test(readFileSync(workspace, 'utf8'))) {
    problems.push('workspace.json still lists an incognito session id (still open, or cleanup failed)')
  }

  console.log(`added files: ${added.length ? added.join(', ') : '(none)'}`)
  if (problems.length) {
    console.log('FAIL\n- ' + problems.join('\n- '))
    process.exit(1)
  }
  console.log('PASS: no trace left')
} else {
  console.log('usage: node scripts/verify-no-trace.mjs snapshot | check <probe-text>')
  process.exit(2)
}
