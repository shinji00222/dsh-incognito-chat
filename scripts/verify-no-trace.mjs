// 验证「没发生的事」：无痕对话有没有在 DSH_HOME 留下痕迹。
//
// 用法（默认检查隔离环境 work/isolated-dsh，可用 DSH_HOME 覆盖）：
//   node scripts/verify-no-trace.mjs snapshot            # 1. 开无痕对话之前拍快照
//   （在无痕对话里发一条带探针文字的消息，比如 INCOG-PROBE-xxxx，然后离开）
//   node scripts/verify-no-trace.mjs check INCOG-PROBE-xxxx   # 2. 对比 + 全盘搜探针
//
// 判定：
//   - sessions/ 下不能有新文件
//   - 任何文件都不能包含探针文字
//   - workspace.json 里不能残留 session-incognito- id
// 注意：会话日志是 zstd 压缩的，搜文字搜不到压缩内容 —— 所以「没有新会话文件」才是主判据，
// 搜探针只是补充（覆盖 storages/ 里的明文 JSON）。

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  const newSessionFiles = added.filter((f) => f.startsWith('sessions/'))
  if (newSessionFiles.length) problems.push(`new session files: ${newSessionFiles.join(', ')}`)

  if (probe) {
    for (const file of Object.keys(after)) {
      if (readFileSync(path.join(home, file)).includes(probe)) problems.push(`probe text found in ${file}`)
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
