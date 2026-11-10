#!/usr/bin/env node
// M11：在隔离 DSH_HOME 中验证无痕父会话的子 Agent 限制真实生效。
//
// 真实服务入口是 subagents.startActivation —— dsh-tool-subagent 的 subagent 工具
// 最终也调用它。探针在 host 内创建普通/无痕两个真实 Agent，然后：
//   - 无痕父会话调用 startActivation，期望被 subagent-guard.js 拒绝
//   - 直接调用 sessionPersistence.create 带无痕 parentSession，期望被 persistence.js 拒绝
//   - 普通父会话调用同一个 startActivation，期望通过保护并创建子会话
// 同时统计隔离 home 的 sessions 文件数，确认无痕尝试没有写出子会话。
//
// 只用合成内容；模型端点指向本地模拟服务；不碰真实 desktop profile。
//
// 用法：
//   node scripts/verify-subagent-guard.mjs
//   node scripts/verify-subagent-guard.mjs --run-dir work/subagent-guard-check
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const TIMEOUT_MS = Number(option('--timeout-ms', '120000'))
const DESKTOP_EXE = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const SYNTHETIC_API_KEY = 'sk-m11-synthetic-not-a-real-key'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createRunDir() {
  const work = path.join(root, 'work')
  fs.mkdirSync(work, { recursive: true })
  const realWork = fs.realpathSync(work)
  if (realWork.toLowerCase() !== path.join(fs.realpathSync(root), 'work').toLowerCase()) throw new Error('work must not redirect to another directory')
  const explicit = option('--run-dir')
  if (argv.includes('--run-dir') && (!explicit || explicit.startsWith('--'))) throw new Error('--run-dir requires a new directory under work')
  if (explicit) {
    const candidate = path.resolve(root, explicit)
    if (path.dirname(candidate).toLowerCase() !== path.resolve(work).toLowerCase()) throw new Error('--run-dir must be a direct child of work')
    const target = path.join(realWork, path.basename(candidate))
    fs.mkdirSync(target)
    return target
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (let attempt = 0; ; attempt += 1) {
    const candidate = path.join(realWork, `subagent-guard-${stamp}${attempt === 0 ? '' : `-${attempt}`}`)
    try { fs.mkdirSync(candidate); return candidate } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function buildProfile({ runDir, baseURL }) {
  const home = path.join(runDir, 'home')
  const profile = path.join(home, 'profiles', 'web')
  const workspace = path.join(runDir, 'workspace')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-incognito-chat',
          'dsh-subagent-guard-m11-probe',
        ],
      },
    },
  }, null, 2) + '\n')
  writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  writeFile(path.join(profile, 'cordis.patch.yml'), [
    '# Isolated M11 verification profile. Never applied to the real desktop profile.',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(baseURL)}`,
    '    apiKeyEnv: DEEPSEEK_API_KEY',
  ].join('\n') + '\n')

  const plugin = path.join(profile, 'node_modules', 'dsh-incognito-chat')
  fs.cpSync(path.join(root, 'src'), path.join(plugin, 'src'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(plugin, 'package.json'))
  fs.copyFileSync(path.join(root, 'cordis.patch.yml'), path.join(plugin, 'cordis.patch.yml'))

  const probe = path.join(profile, 'node_modules', 'dsh-subagent-guard-m11-probe')
  fs.cpSync(path.join(root, 'scripts', 'fixtures', 'subagent-guard-probe'), probe, { recursive: true })
  return { home, workspace }
}

function startMockServer() {
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'POST' && pathname.endsWith('/messages')) {
      const sse = [
        ['message_start', { type: 'message_start', message: { id: 'msg_m11_synthetic', type: 'message', role: 'assistant', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'M11 synthetic completion.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }],
      ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'close' })
      response.end(sse)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function spawnDsh({ runDir, home, workspace, port }) {
  const logFile = path.join(runDir, 'logs', 'dsh.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const logFd = fs.openSync(logFile, 'a')
  const cli = path.join(path.dirname(DESKTOP_EXE), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[key]
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    DEEPSEEK_API_KEY: SYNTHETIC_API_KEY,
    M11_RUN_DIR: runDir,
    M11_WORKSPACE: workspace,
    M11_NORMAL_ID: process.env.M11_NORMAL_ID,
    M11_INCOGNITO_ID: process.env.M11_INCOGNITO_ID,
  })
  const child = spawn(DESKTOP_EXE, ['--expose-internals', cli, 'web', '--no-open', '--port', String(port)], {
    cwd: workspace,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  const state = { spawnError: null }
  child.once('error', (error) => {
    state.spawnError = error
    try { fs.appendFileSync(logFile, `spawn error: ${error?.stack ?? error}\n`) } catch {}
  })
  child.on('exit', () => { try { fs.closeSync(logFd) } catch {} })
  return { child, logFile, state }
}

function redactLog(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
    .replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
  fs.writeFileSync(file, text)
}

function redactCredentials(home) {
  const file = path.join(home, '.credentials.yaml')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, text.replace(/^(\s*(?:secret|access|refresh|token|api[_-]?key)\s*:\s*).+$/gim, '$1<redacted>'))
}

async function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5000).then(() => false),
  ])
  if (exited) return
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('exit', () => resolve())
    killer.on('error', () => resolve())
  })
}

function assertResult(result) {
  const findings = []
  const error = (code, message) => findings.push({ code, message })
  if (result?.ok !== true) {
    error('PROBE_FAILED', `probe did not finish: ${result?.error ?? 'no result'}`)
    return findings
  }
  if (result.incognitoRejected !== true) error('INCOGNITO_NOT_REJECTED', `incognito activation was not rejected: ${result.incognitoError ?? 'no error'}`)
  else if (!String(result.incognitoError).includes('无痕对话暂不支持启动子 agent')) error('WRONG_REJECTION', result.incognitoError)
  if (!Array.isArray(result.incognitoUnexpectedSessionFiles) || result.incognitoUnexpectedSessionFiles.length !== 0) {
    error('INCOGNITO_SESSION_WRITTEN', `incognito attempt wrote unexpected session files: ${JSON.stringify(result.incognitoUnexpectedSessionFiles)}`)
  }
  if (result.persistenceRejected !== true) error('PERSISTENCE_NOT_REJECTED', `direct child persistence was not rejected: ${result.persistenceError ?? 'no error'}`)
  else if (!String(result.persistenceError).includes('无痕对话暂不支持创建子会话')) error('WRONG_PERSISTENCE_REJECTION', result.persistenceError)
  if (!Array.isArray(result.persistenceUnexpectedSessionFiles) || result.persistenceUnexpectedSessionFiles.length !== 0) {
    error('PERSISTENCE_WROTE_SESSION', `direct child create wrote unexpected session files: ${JSON.stringify(result.persistenceUnexpectedSessionFiles)}`)
  }
  if (!Array.isArray(result.incognitoFileChanges) || result.incognitoFileChanges.length !== 0) error('INCOGNITO_FILE_CHANGES', 'session files changed after rejected activation')
  if (!String(result.incognitoExternalError).includes('无痕对话暂不支持启动子 agent') || result.incognitoExternalStarts !== 0) {
    error('INCOGNITO_EXTERNAL_START', 'incognito request was not rejected before the external provider start boundary')
  }
  if (result.normalExternalStarts !== 1 || result.normalExternalError !== 'M11_EXTERNAL_START_REACHED') {
    error('NORMAL_EXTERNAL_CONTROL', `normal request did not reach the external provider exactly once: ${result.normalExternalError}`)
  }
  if (!Array.isArray(result.persistenceFileChanges) || result.persistenceFileChanges.length !== 0) error('PERSISTENCE_FILE_CHANGES', 'session files changed after rejected persistence')
  if (!result.normalChildId) error('NORMAL_CHILD_NOT_CREATED', `normal parent could not start a child: ${result.normalError ?? 'no child id'}`)
  if (result.normalError) error('NORMAL_CHILD_ERROR', String(result.normalError))
  if (result.normalParentSession !== result.normalId) error('NORMAL_CHILD_WRONG_PARENT', `normal child parentSession=${result.normalParentSession}`)
  if (result.normalPersisted === false) error('NORMAL_CHILD_NOT_PERSISTED', 'normal child session was not persisted')
  if (!Array.isArray(result.normalChildSessionFiles) || result.normalChildSessionFiles.length === 0) {
    error('NORMAL_CHILD_NOT_WRITTEN', 'normal child did not create a session file')
  }
  return findings
}

async function main() {
  const runDir = createRunDir()
  const nonce = randomUUID().slice(0, 8)
  const normalId = `session-${randomUUID()}`
  const incognitoId = `session-incognito-${randomUUID()}`
  process.env.M11_NORMAL_ID = normalId
  process.env.M11_INCOGNITO_ID = incognitoId

  const mock = await startMockServer()
  const baseURL = `http://127.0.0.1:${mock.port}`
  const { home, workspace } = buildProfile({ runDir, baseURL })
  const port = await freePort()
  const { child, logFile, state } = spawnDsh({ runDir, home, workspace, port })
  const doneFile = path.join(runDir, 'done.json')
  let done = null
  let exitCode = null
  child.once('exit', (code) => { exitCode = code })
  try {
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      if (fs.existsSync(doneFile)) { done = JSON.parse(fs.readFileSync(doneFile, 'utf8')); break }
      if (state.spawnError !== null || exitCode !== null) break
      await sleep(200)
    }
    if (done === null) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n') : '(no log)'
      throw new Error(`probe did not finish (spawn/exit=${String(state.spawnError ?? exitCode ?? 'running')})\n--- dsh log tail ---\n${tail}`)
    }
  } finally {
    await killTree(child)
    await new Promise((resolve) => mock.server.close(() => resolve()))
    redactLog(logFile)
    redactCredentials(home)
  }

  const findings = assertResult(done)
  const summary = {
    runDir,
    normalId,
    incognitoId,
    incognitoRejected: done.incognitoRejected,
    incognitoError: done.incognitoError,
    sessionFilesBefore: done.sessionFilesBefore,
    sessionFilesAfterIncognito: done.sessionFilesAfterIncognito,
    incognitoUnexpectedSessionFiles: done.incognitoUnexpectedSessionFiles,
    persistenceRejected: done.persistenceRejected,
    persistenceError: done.persistenceError,
    sessionFilesAfterPersistence: done.sessionFilesAfterPersistence,
    persistenceUnexpectedSessionFiles: done.persistenceUnexpectedSessionFiles,
    incognitoFileChanges: done.incognitoFileChanges,
    incognitoExternalError: done.incognitoExternalError,
    incognitoExternalStarts: done.incognitoExternalStarts,
    normalExternalError: done.normalExternalError,
    normalExternalStarts: done.normalExternalStarts,
    persistenceFileChanges: done.persistenceFileChanges,
    normalChildId: done.normalChildId,
    normalError: done.normalError,
    normalLive: done.normalLive,
    normalParentSession: done.normalParentSession,
    normalPersisted: done.normalPersisted,
    sessionFilesAfterNormal: done.sessionFilesAfterNormal,
    normalChildSessionFiles: done.normalChildSessionFiles,
    ok: findings.length === 0,
    findings,
  }
  writeFile(path.join(runDir, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(`M11 isolated subagent guard verification: ${runDir}`)
  console.log(`incognito activation rejected: ${summary.incognitoRejected} (${summary.incognitoError ?? ''})`)
  console.log(`external provider start calls: incognito=${summary.incognitoExternalStarts}, normal=${summary.normalExternalStarts}`)
  console.log(`session files before/after incognito: ${summary.sessionFilesBefore}/${summary.sessionFilesAfterIncognito}`)
  console.log(`direct persistence rejected: ${summary.persistenceRejected} (${summary.persistenceError ?? ''})`)
  console.log(`normal child: ${summary.normalChildId ?? 'MISSING'} live=${summary.normalLive} parent=${summary.normalParentSession} persisted=${summary.normalPersisted}`)
  for (const finding of findings) console.log(`ERROR ${finding.code}: ${finding.message}`)
  console.log(findings.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  return findings.length === 0 ? 0 : 1
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(2)
})
