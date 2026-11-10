#!/usr/bin/env node
// M11（模型工具入口）验收：在隔离 DSH_HOME 中让本地模拟模型返回真正的
// `subagent` 工具调用，经由 DSH 正常工具执行链验证无痕父会话的拒绝保护。
//
// 与 scripts/verify-subagent-guard.mjs 的区别：
//   - 旧脚本在 host 探针里直接调用 `subagents.startActivation`；
//   - 本脚本不调用该服务入口，而是让模型返回 tool_use，由 agent-loop 解析、
//     注册表参数校验、工具调度、`subagent` 工具 body 调用 `startActivation`。
//
// 判定分级（关键）：
//   - 只有确认工具 body 已被执行、且返回的是 guard 的拒绝消息，才算“无痕保护通过”。
//   - 若工具调用停在参数校验（ToolArgsError）、工具不可用（UNKNOWN_TOOL）或审批阶段，
//     或模型调用没有产生 tool/call，则整次验收标为 UNVERIFIED，绝不当作通过。
//
// 只使用合成内容；不读取、不修改真实 desktop profile；模型端点指向本地模拟服务；
// API key 为本地假值；日志中的 token 和隔离 home 凭据在运行后打码。
//
// 用法：
//   node scripts/verify-subagent-tool-call.mjs
//   node scripts/verify-subagent-tool-call.mjs --run-dir work/subagent-tool-call-check
//   node scripts/verify-subagent-tool-call.mjs --timeout-ms 240000
//   node scripts/verify-subagent-tool-call.mjs --negative-control
//
// 退出码：0 PASS，1 FAIL，2 UNVERIFIED，3 运行环境/脚本错误。
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { assessIncognitoToolOutcome, classifyToolResult } from './lib/subagent-tool-call-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workRoot = path.join(root, 'work')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const TIMEOUT_MS = Number(option('--timeout-ms', '240000'))
const NEGATIVE_CONTROL = argv.includes('--negative-control')
const DESKTOP_EXE = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const SYNTHETIC_API_KEY = 'sk-m11-toolcall-synthetic-not-a-real-key'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function createRunDir() {
  fs.mkdirSync(workRoot, { recursive: true })
  const realWork = fs.realpathSync(workRoot)
  if (realWork.toLowerCase() !== path.join(fs.realpathSync(root), 'work').toLowerCase()) throw new Error('work must not redirect to another directory')
  const explicit = option('--run-dir')
  if (argv.includes('--run-dir') && (!explicit || explicit.startsWith('--'))) throw new Error('--run-dir requires a new directory under work')
  if (explicit) {
    const candidate = path.resolve(root, explicit)
    if (path.dirname(candidate).toLowerCase() !== path.resolve(workRoot).toLowerCase()) throw new Error('--run-dir must be a direct child of work')
    const target = path.join(realWork, path.basename(candidate))
    fs.mkdirSync(target)
    return target
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const prefix = NEGATIVE_CONTROL ? 'subagent-tool-call-negative-' : 'subagent-tool-call-'
  for (let attempt = 0; ; attempt += 1) {
    const candidate = path.join(realWork, `${prefix}${stamp}${attempt === 0 ? '' : `-${attempt}`}`)
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

function gitHead() {
  // This script may run inside a file sandbox where spawning git is denied, so
  // read .git/HEAD directly instead of invoking the git executable.
  const override = process.env.M11_BASE_COMMIT
  if (override !== undefined && override !== '') return override
  try {
    const dotGit = path.join(root, '.git')
    let gitDir
    if (fs.statSync(dotGit).isFile()) {
      const match = fs.readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/i)
      if (match === null) return null
      gitDir = path.resolve(root, match[1])
    } else {
      gitDir = dotGit
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head
    const ref = head.slice(5).trim()
    const commonDirFile = path.join(gitDir, 'commondir')
    const base = fs.existsSync(commonDirFile) ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim()) : gitDir
    const refFile = path.join(base, ...ref.split('/'))
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim()
    const packed = path.join(base, 'packed-refs')
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, 'utf8').split('\n').find((entry) => entry.endsWith(` ${ref}`))
      if (line !== undefined) return line.split(' ')[0]
    }
    return null
  } catch {
    return null
  }
}

// ── 本地模拟模型 ────────────────────────────────────────────────────────────

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function messageStart() {
  return ['message_start', {
    type: 'message_start',
    message: {
      id: `msg_m11_${randomBytes(4).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      usage: { input_tokens: 8, output_tokens: 0 },
    },
  }]
}

function textEvents(text) {
  return [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

function toolUseEvents(id, input) {
  return [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'subagent', input } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
}

function bodyText(body) {
  const parts = []
  for (const message of body?.messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function hasToolResult(body) {
  return (body?.messages ?? []).some((message) => (message?.content ?? []).some((block) => block?.type === 'tool_result'))
}

function startMockServer(config) {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (!(request.method === 'POST' && pathname.endsWith('/messages'))) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":"not found"}')
      return
    }
    let body = null
    try { body = JSON.parse(raw.toString('utf8')) } catch { body = null }
    const text = bodyText(body)
    const toolResult = hasToolResult(body)
    const seq = requests.length + 1
    const input = {
      description: 'M11 synthetic subagent tool call',
      prompt: '',
    }
    let reply
    if (toolResult) {
      reply = { kind: 'text', text: 'M11 synthetic follow-up completion.' }
    } else if (text.includes(config.incognitoMarker)) {
      input.prompt = config.incognitoChildPrompt
      reply = { kind: 'tool_use', toolCallId: config.incognitoCallId, name: 'subagent', input }
    } else if (text.includes(config.normalMarker)) {
      input.prompt = config.normalChildPrompt
      reply = { kind: 'tool_use', toolCallId: config.normalCallId, name: 'subagent', input }
    } else if (text.includes(config.incognitoChildPrompt) || text.includes(config.normalChildPrompt)) {
      reply = { kind: 'text', text: 'M11 synthetic child completion.' }
    } else {
      reply = { kind: 'text', text: 'M11 synthetic completion.' }
    }
    const record = {
      seq,
      pathname,
      method: request.method,
      at: new Date().toISOString(),
      body,
      classification: {
        matchedIncognitoMarker: text.includes(config.incognitoMarker),
        matchedNormalMarker: text.includes(config.normalMarker),
        matchedChildPrompt: text.includes(config.incognitoChildPrompt) || text.includes(config.normalChildPrompt),
        hasToolResult: toolResult,
      },
      response: reply,
    }
    requests.push(record)
    writeFile(path.join(config.requestsDir, `request-${String(seq).padStart(4, '0')}.json`), JSON.stringify(record, null, 2) + '\n')
    try {
      fs.appendFileSync(path.join(config.runDir, 'mock.log'), `${record.at} request#${seq} ${JSON.stringify(record.classification)} -> ${reply.kind}${reply.toolCallId === undefined ? '' : ` ${reply.toolCallId}`}\n`)
    } catch {}
    const events = reply.kind === 'tool_use' ? toolUseEvents(reply.toolCallId, reply.input) : textEvents(reply.text)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'close' })
    response.end(sse([messageStart(), ...events]))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }))
  })
}

// ── 隔离 profile ────────────────────────────────────────────────────────────

function buildProfile({ runDir, baseURL, includeIncognito }) {
  const home = path.join(runDir, 'home')
  const profile = path.join(home, 'profiles', 'web')
  const workspace = path.join(runDir, 'workspace')
  const temp = path.join(runDir, 'temp')
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(temp)
  writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          ...(includeIncognito ? ['dsh-incognito-chat'] : []),
          'dsh-subagent-tool-call-probe',
        ],
      },
    },
  }, null, 2) + '\n')
  writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  writeFile(path.join(profile, 'cordis.patch.yml'), [
    '# Isolated M11 model-tool-call verification profile. Never applied to the real desktop profile.',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(baseURL)}`,
    '    apiKeyEnv: DEEPSEEK_API_KEY',
  ].join('\n') + '\n')

  if (includeIncognito) {
    const plugin = path.join(profile, 'node_modules', 'dsh-incognito-chat')
    fs.cpSync(path.join(root, 'src'), path.join(plugin, 'src'), { recursive: true })
    fs.copyFileSync(path.join(root, 'package.json'), path.join(plugin, 'package.json'))
    fs.copyFileSync(path.join(root, 'cordis.patch.yml'), path.join(plugin, 'cordis.patch.yml'))
  }

  const probe = path.join(profile, 'node_modules', 'dsh-subagent-tool-call-probe')
  fs.cpSync(path.join(root, 'scripts', 'fixtures', 'subagent-tool-call-probe'), probe, { recursive: true })
  return { home, workspace, temp }
}

function spawnDsh({ runDir, home, workspace, temp, port, envExtra }) {
  const logFile = path.join(runDir, 'logs', 'dsh.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const logFd = fs.openSync(logFile, 'a')
  const cli = path.join(path.dirname(DESKTOP_EXE), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[key]
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    TEMP: temp,
    TMP: temp,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'OFF',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    DEEPSEEK_API_KEY: SYNTHETIC_API_KEY,
    ...envExtra,
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

function redactLogText(text) {
  return text
    .replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
}

function redactLog(file) {
  if (fs.existsSync(file)) fs.writeFileSync(file, redactLogText(fs.readFileSync(file, 'utf8')))
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

// ── 证据读取与判定 ──────────────────────────────────────────────────────────

function decodeAllFrames(buffer) {
  const parts = []
  for (let index = buffer.indexOf(ZSTD_MAGIC); index !== -1; index = buffer.indexOf(ZSTD_MAGIC, index + 1)) {
    try { parts.push(zstdDecompressSync(buffer.subarray(index))) } catch { /* not a real frame header */ }
  }
  return parts.length === 0 ? buffer : Buffer.concat(parts)
}

function readSessionFile(file) {
  return decodeAllFrames(fs.readFileSync(file)).toString('utf8')
}

function sessionFilesUnder(home) {
  const sessionsRoot = path.join(home, 'sessions')
  const files = []
  const walk = (dir, prefix) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  walk(sessionsRoot, '')
  return files.sort()
}

function absoluteSessionFile(home, relative) {
  return path.join(home, 'sessions', ...relative.split('/'))
}

function headerOfSessionText(text) {
  const firstLine = text.split('\n').find((line) => line.trim() !== '')
  if (firstLine === undefined) return null
  try {
    const record = JSON.parse(firstLine)
    return record?.type === 'session' ? record : null
  } catch {
    return null
  }
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function summarizeRequest(record) {
  const tools = Array.isArray(record.body?.tools) ? record.body.tools.map((tool) => tool?.name) : []
  return {
    seq: record.seq,
    matchedIncognitoMarker: record.classification?.matchedIncognitoMarker === true,
    matchedNormalMarker: record.classification?.matchedNormalMarker === true,
    matchedChildPrompt: record.classification?.matchedChildPrompt === true,
    hasToolResult: record.classification?.hasToolResult === true,
    toolNames: tools,
    response: record.response,
  }
}

async function main() {
  const runDir = createRunDir()
  const startedAt = new Date().toISOString()
  const nonce = randomUUID().slice(0, 8)
  const baseCommit = gitHead()
  const marker = `M11-TOOL-CALL-${nonce}`
  const normalId = `session-${randomUUID()}`
  const incognitoId = `session-incognito-${randomUUID()}`
  const normalMarker = `${marker}-NORMAL`
  const incognitoMarker = `${marker}-INCOGNITO`
  const normalCallId = `toolu_m11_normal_${nonce}`
  const incognitoCallId = `toolu_m11_incognito_${nonce}`
  const normalChildPrompt = `M11-SYNTHETIC-NORMAL-CHILD-${nonce}`
  const incognitoChildPrompt = `M11-SYNTHETIC-INCOGNITO-CHILD-${nonce}`
  const requestsDir = path.join(runDir, 'requests')
  fs.mkdirSync(requestsDir, { recursive: true })

  const mock = await startMockServer({
    runDir,
    requestsDir,
    incognitoMarker,
    normalMarker,
    incognitoChildPrompt,
    normalChildPrompt,
    incognitoCallId,
    normalCallId,
  })
  const baseURL = `http://127.0.0.1:${mock.port}`
  const { home, workspace, temp } = buildProfile({ runDir, baseURL, includeIncognito: !NEGATIVE_CONTROL })
  const port = await freePort()
  const { child, logFile, state } = spawnDsh({
    runDir,
    home,
    workspace,
    temp,
    port,
    envExtra: {
      M11_RUN_DIR: runDir,
      M11_WORKSPACE: workspace,
      M11_NORMAL_ID: normalId,
      M11_INCOGNITO_ID: incognitoId,
      M11_NORMAL_MARKER: normalMarker,
      M11_INCOGNITO_MARKER: incognitoMarker,
      M11_NORMAL_CALL_ID: normalCallId,
      M11_INCOGNITO_CALL_ID: incognitoCallId,
      M11_NORMAL_CHILD_PROMPT: normalChildPrompt,
      M11_INCOGNITO_CHILD_PROMPT: incognitoChildPrompt,
      M11_AGENT_PROVIDER: 'deepseek-official',
      M11_AGENT_MODEL: 'deepseek-flash',
    },
  })
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
      const tail = fs.existsSync(logFile) ? redactLogText(fs.readFileSync(logFile, 'utf8')).split('\n').slice(-30).join('\n') : '(no log)'
      throw new Error(`probe did not finish (spawn/exit=${String(state.spawnError ?? exitCode ?? 'running')})\n--- dsh log tail ---\n${tail}`)
    }
  } finally {
    await killTree(child)
    await new Promise((resolve) => mock.server.close(() => resolve()))
    redactLog(logFile)
    redactCredentials(home)
  }

  const requestFiles = fs.readdirSync(requestsDir).filter((file) => file.endsWith('.json')).sort()
  const requests = requestFiles.map((file) => JSON.parse(fs.readFileSync(path.join(requestsDir, file), 'utf8')))
  const requestSummaries = requests.map(summarizeRequest)
  const incognitoToolRequest = requests.find((record) => record.classification?.matchedIncognitoMarker === true && record.classification?.hasToolResult !== true)
  const normalToolRequest = requests.find((record) => record.classification?.matchedNormalMarker === true && record.classification?.hasToolResult !== true)
  const childRequest = requests.find((record) => record.classification?.matchedChildPrompt === true)

  const checks = []
  const findings = []
  const check = (id, status, detail) => {
    checks.push({ id, status, detail })
    if (status === 'fail') findings.push({ code: id, severity: 'fail', message: detail })
    else if (status === 'unverified') findings.push({ code: id, severity: 'unverified', message: detail })
  }
  const verify = (id, condition, detail) => check(id, condition ? 'pass' : 'fail', detail)
  const unverify = (id, condition, detail) => check(id, condition ? 'pass' : 'unverified', detail)

  if (done?.ok !== true) {
    check('PROBE', 'fail', `probe did not finish: ${done?.error ?? 'no done.json'}`)
  } else if (NEGATIVE_CONTROL) {
    // ── 负向对照：不加载 dsh-incognito-chat ────────────────────────────────
    // 同一个模型 tool_use 必须真正执行，并在 session-incognito-* 会话下创建子会话
    // 文件。只有这样才能证明正向的拒绝不是参数校验/工具不可用/审批等早期阶段造成的。
    const incognitoCall = done.incognitoEvents.find((event) => event.type === 'tool/call' && event.callId === incognitoCallId)
    const incognitoAssistant = done.incognitoEvents.find((event) => event.type === 'assistant/message' && (event.toolCalls ?? []).some((call) => call.id === incognitoCallId))
    const incognitoResult = done.incognitoEvents.find((event) => event.type === 'tool/result' && event.callId === incognitoCallId)
    const incognitoClassification = classifyToolResult(incognitoResult)
    const incognitoEvidence = incognitoToolRequest?.response
    const incognitoAssistantCall = incognitoAssistant?.toolCalls?.find((call) => call.id === incognitoCallId)
    const UUID_RE = /started subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    const incognitoChildIdMatch = typeof incognitoResult?.text === 'string' ? incognitoResult.text.match(UUID_RE) : null

    verify('NEGATIVE_GUARD_ABSENT', done.guardInstalled === false, `subagentGuard patched: ${done.guardInstalled} (expected false without the plugin)`)
    verify('NEGATIVE_PRESET', done.preset?.id === 'standard' && done.preset?.broken == null, `agent preset: ${JSON.stringify(done.preset)}`)
    verify('NEGATIVE_TOOL_VISIBLE', done.incognitoToolVisible === true && done.incognitoToolNames.includes('subagent'), `subagent tool visible: ${done.incognitoToolVisible}`)
    verify('NEGATIVE_MODEL_TOOL_CALL', incognitoEvidence?.kind === 'tool_use' && incognitoEvidence.toolCallId === incognitoCallId, `mock returned tool_use: ${JSON.stringify(incognitoEvidence ?? null)}`)
    verify('NEGATIVE_ASSISTANT_TOOL_CALL', incognitoAssistantCall?.name === 'subagent', `assistant message carried tool call: ${JSON.stringify(incognitoAssistantCall ?? null)}`)
    verify('NEGATIVE_TOOL_CALL_EVENT', incognitoCall?.name === 'subagent', `tool/call event: ${JSON.stringify(incognitoCall ?? null)}`)
    verify('NEGATIVE_INCOGNITO_TOOL_EXECUTED', incognitoClassification.stage === 'executed', `without the plugin the same tool call executes: ${incognitoClassification.stage} ${incognitoClassification.detail}`)
    verify('NEGATIVE_INCOGNITO_CHILD_ID', incognitoChildIdMatch !== null && done.incognitoChildId === incognitoChildIdMatch[1], `incognito child id: ${incognitoChildIdMatch?.[1] ?? null}; probe recorded ${done.incognitoChildId}`)
    verify('NEGATIVE_INCOGNITO_CHILD_HEADER', done.incognitoChildStat?.header?.parentSession === incognitoId
      && done.incognitoChildStat?.header?.origin === 'subagent'
      && done.incognitoChildStat?.header?.delegationDepth === 1, `incognito child header: ${JSON.stringify(done.incognitoChildStat?.header ?? null)}`)
    verify('NEGATIVE_INCOGNITO_CHILD_SESSION_FILE', done.incognitoChildSessionFiles.length === 1, `incognito child files: ${JSON.stringify(done.incognitoChildSessionFiles)}`)
    verify('NEGATIVE_INCOGNITO_PARENT_SESSION_FILE', done.incognitoParentSessionFiles.length === 1, `incognito parent files: ${JSON.stringify(done.incognitoParentSessionFiles)}`)
    verify('NEGATIVE_INCOGNITO_SESSION_FILES_ADDED', done.incognitoNewSessionFiles.length >= 2, `new files during incognito attempt: ${JSON.stringify(done.incognitoNewSessionFiles)}`)
    const negativeFinalFiles = sessionFilesUnder(home)
    const negativeIncognitoFiles = negativeFinalFiles.filter((file) => file.includes(incognitoId))
    verify('NEGATIVE_FINAL_SESSION_FILES', negativeIncognitoFiles.length === 1 && negativeFinalFiles.length === 4, `final session files: ${JSON.stringify(negativeFinalFiles)}`)
  } else {
    // ── 0. 基础状态 ────────────────────────────────────────────────────────
    verify('GUARD_INSTALLED', done.guardInstalled === true, `subagentGuard patched at startActivation: ${done.guardInstalled}`)
    check('INCOGNITO_TOOL_VISIBLE', done.incognitoToolVisible === true && done.incognitoToolNames.includes('subagent') ? 'pass' : 'unverified',
      `subagent tool visible to incognito agent: ${done.incognitoToolVisible}; tool count ${done.incognitoToolNames.length}`)
    check('NORMAL_TOOL_VISIBLE', done.normalToolVisible === true && done.normalToolNames.includes('subagent') ? 'pass' : 'unverified',
      `subagent tool visible to normal agent: ${done.normalToolVisible}; tool count ${done.normalToolNames.length}`)
    check('PRESET', done.preset?.id === 'standard' && done.preset?.broken == null ? 'pass' : 'unverified', `agent preset: ${JSON.stringify(done.preset)}`)

    // ── 1. 模型确实返回了 subagent 工具调用 ───────────────────────────────
    const incognitoEvidence = incognitoToolRequest?.response
    const normalEvidence = normalToolRequest?.response
    const incognitoModelCalled = incognitoEvidence?.kind === 'tool_use'
    const normalModelCalled = normalEvidence?.kind === 'tool_use'
    const incognitoModelCall = incognitoModelCalled
      && incognitoEvidence.toolCallId === incognitoCallId
      && incognitoEvidence.name === 'subagent'
      && incognitoEvidence.input?.prompt === incognitoChildPrompt
    const normalModelCall = normalModelCalled
      && normalEvidence.toolCallId === normalCallId
      && normalEvidence.name === 'subagent'
      && normalEvidence.input?.prompt === normalChildPrompt
    check('INCOGNITO_MODEL_TOOL_CALL', incognitoModelCalled ? (incognitoModelCall ? 'pass' : 'fail') : 'unverified',
      `mock returned tool_use for incognito request: ${JSON.stringify(incognitoEvidence ?? null)}`)
    check('NORMAL_MODEL_TOOL_CALL', normalModelCalled ? (normalModelCall ? 'pass' : 'fail') : 'unverified',
      `mock returned tool_use for normal request: ${JSON.stringify(normalEvidence ?? null)}`)
    const requestAdvertised = (record) => record !== undefined && record.body?.tools?.some((tool) => tool?.name === 'subagent')
    check('INCOGNITO_REQUEST_TOOLS', incognitoToolRequest === undefined ? 'unverified' : requestAdvertised(incognitoToolRequest) ? 'pass' : 'fail',
      `request advertised subagent tool: ${requestAdvertised(incognitoToolRequest)}`)
    check('NORMAL_REQUEST_TOOLS', normalToolRequest === undefined ? 'unverified' : requestAdvertised(normalToolRequest) ? 'pass' : 'fail',
      `request advertised subagent tool: ${requestAdvertised(normalToolRequest)}`)

    const incognitoFollowupRequest = requests.find((record) => record.classification?.matchedIncognitoMarker === true && record.classification?.hasToolResult === true)
    const normalFollowupRequest = requests.find((record) => record.classification?.matchedNormalMarker === true && record.classification?.hasToolResult === true)
    const followupCarriesResult = (record, callId) => (record?.body?.messages ?? []).some((message) => (message?.content ?? []).some((block) => block?.type === 'tool_result' && block?.tool_use_id === callId))
    check('INCOGNITO_FOLLOWUP_REQUEST', incognitoFollowupRequest === undefined ? 'unverified'
      : (followupCarriesResult(incognitoFollowupRequest, incognitoCallId) && incognitoFollowupRequest.response?.kind === 'text') ? 'pass' : 'fail',
    `agent loop sent the rejected tool result back to the model: ${JSON.stringify(incognitoFollowupRequest === undefined ? null : summarizeRequest(incognitoFollowupRequest))}`)
    check('NORMAL_FOLLOWUP_REQUEST', normalFollowupRequest === undefined ? 'unverified'
      : (followupCarriesResult(normalFollowupRequest, normalCallId) && normalFollowupRequest.response?.kind === 'text') ? 'pass' : 'fail',
    `agent loop sent the successful tool result back to the model: ${JSON.stringify(normalFollowupRequest === undefined ? null : summarizeRequest(normalFollowupRequest))}`)

    // ── 2. 无痕父会话：工具调用被 guard 拒绝，且不产生子会话文件 ─────────
    const incognitoCall = done.incognitoEvents.find((event) => event.type === 'tool/call' && event.callId === incognitoCallId)
    const incognitoAssistant = done.incognitoEvents.find((event) => event.type === 'assistant/message' && (event.toolCalls ?? []).some((call) => call.id === incognitoCallId))
    const incognitoResult = done.incognitoEvents.find((event) => event.type === 'tool/result' && event.callId === incognitoCallId)
    const incognitoClassification = classifyToolResult(incognitoResult)

    const assistantCall = incognitoAssistant?.toolCalls?.find((call) => call.id === incognitoCallId)
    check('INCOGNITO_ASSISTANT_TOOL_CALL', assistantCall === undefined ? 'unverified'
      : (assistantCall.name === 'subagent' && incognitoModelCalled && equalJson(parseArguments(assistantCall.arguments), incognitoEvidence.input)) ? 'pass' : 'fail',
    `assistant message carried the model tool call: ${JSON.stringify(assistantCall ?? null)}`)
    check('INCOGNITO_TOOL_CALL_EVENT', incognitoCall === undefined ? 'unverified'
      : (incognitoCall.name === 'subagent' && incognitoModelCalled && equalJson(parseArguments(incognitoCall.arguments), incognitoEvidence.input)) ? 'pass' : 'fail',
    `tool/call event: ${JSON.stringify(incognitoCall ?? null)}`)

    const incognitoVerdict = assessIncognitoToolOutcome(incognitoClassification.stage)
    if (incognitoVerdict === 'pass') {
      check('INCOGNITO_TOOL_RESULT_GUARD', 'pass', `tool/result rejected by guard: ${incognitoClassification.detail}`)
    } else if (incognitoVerdict === 'fail') {
      check('INCOGNITO_TOOL_RESULT_GUARD', 'fail', `incognito tool call was NOT rejected; tool executed: ${incognitoClassification.detail}`)
    } else {
      check('INCOGNITO_TOOL_RESULT_GUARD', 'unverified', `tool call stopped before the guard body boundary (${incognitoClassification.stage}): ${incognitoClassification.detail}`)
    }
    check('INCOGNITO_TURN_COMPLETED', done.incognitoTurnEnd?.type === 'turn/end' && done.incognitoTurnError === null ? 'pass' : 'unverified',
      `incognito turn end: ${JSON.stringify(done.incognitoTurnEnd ?? done.incognitoTurnError)}`)

    verify('INCOGNITO_NO_NEW_SESSION_FILES', done.incognitoNewSessionFiles.length === 0, `new sessions files during incognito attempt: ${JSON.stringify(done.incognitoNewSessionFiles)}`)
    verify('INCOGNITO_NO_OBSERVED_SESSION_CHANGES', done.incognitoObservedChanges.length === 0, `observed sessions changes during incognito attempt: ${JSON.stringify(done.incognitoObservedChanges)}`)
    const incognitoPathLeak = done.incognitoSessionsAfter.filter((file) => file.includes(incognitoId))
    verify('INCOGNITO_NO_INCOGNITO_SESSION_PATH', incognitoPathLeak.length === 0, `session paths containing the incognito id: ${JSON.stringify(incognitoPathLeak)}`)

    // 独立扫描：任何会话文件（解压后）都不应含无痕 id / 无痕探针 / 无痕子任务提示。
    const allSessionFiles = sessionFilesUnder(home)
    const leakedMarkers = []
    for (const relative of allSessionFiles) {
      const text = readSessionFile(absoluteSessionFile(home, relative))
      if (text.includes(incognitoId) || text.includes(incognitoMarker) || text.includes(incognitoChildPrompt)) leakedMarkers.push(relative)
    }
    verify('INCOGNITO_NO_SESSION_CONTENT', leakedMarkers.length === 0, `session files containing incognito id/probe/child prompt: ${JSON.stringify(leakedMarkers)}`)

    // ── 3. 普通对照：子 Agent 启动、子会话记录正确 ───────────────────────
    const normalCall = done.normalEvents.find((event) => event.type === 'tool/call' && event.callId === normalCallId)
    const normalAssistant = done.normalEvents.find((event) => event.type === 'assistant/message' && (event.toolCalls ?? []).some((call) => call.id === normalCallId))
    const normalResult = done.normalEvents.find((event) => event.type === 'tool/result' && event.callId === normalCallId)
    const normalClassification = classifyToolResult(normalResult)
    const normalExecuted = normalClassification.stage === 'executed'
    const normalAssistantCall = normalAssistant?.toolCalls?.find((call) => call.id === normalCallId)
    const verifyIfControl = (id, condition, detail) => {
      if (normalExecuted) verify(id, condition, detail)
      else check(id, 'unverified', `normal control did not execute (${normalClassification.stage}); ${detail}`)
    }

    check('NORMAL_ASSISTANT_TOOL_CALL', normalAssistantCall === undefined ? 'unverified'
      : (normalAssistantCall.name === 'subagent' && normalModelCalled && equalJson(parseArguments(normalAssistantCall.arguments), normalEvidence.input)) ? 'pass' : 'fail',
    `assistant message carried the model tool call: ${JSON.stringify(normalAssistantCall ?? null)}`)
    check('NORMAL_TOOL_CALL_EVENT', normalCall === undefined ? 'unverified'
      : (normalCall.name === 'subagent' && normalModelCalled && equalJson(parseArguments(normalCall.arguments), normalEvidence.input)) ? 'pass' : 'fail',
    `tool/call event: ${JSON.stringify(normalCall ?? null)}`)
    if (normalExecuted) check('NORMAL_TOOL_RESULT_EXECUTED', 'pass', `normal tool result: ${normalClassification.stage}`)
    else if (['parameter-validation', 'tool-unavailable', 'approval', 'missing'].includes(normalClassification.stage)) check('NORMAL_TOOL_RESULT_EXECUTED', 'unverified', `normal tool result: ${normalClassification.stage} ${normalClassification.detail}`)
    else check('NORMAL_TOOL_RESULT_EXECUTED', 'fail', `normal tool result: ${normalClassification.stage} ${normalClassification.detail}`)

    // DSH in-process spawn 子会话 id 是裸 UUID（无 `session-` 前缀）。
    const CHILD_ID_RE = /started subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
    const childIdMatch = typeof normalResult?.text === 'string' ? normalResult.text.match(CHILD_ID_RE) : null
    verifyIfControl('NORMAL_CHILD_ID', childIdMatch !== null && done.normalChildId === childIdMatch[1], `child id from tool result: ${childIdMatch?.[1] ?? null}; probe recorded ${done.normalChildId}`)
    verifyIfControl('NORMAL_CHILD_ID_FORMAT', typeof done.normalChildId === 'string' && /^[0-9a-f-]{36}$/.test(done.normalChildId), `child id carries no session- prefix: ${done.normalChildId}`)

    const childHeader = done.childStat?.header ?? null
    verifyIfControl('NORMAL_CHILD_HEADER', childHeader !== null
      && childHeader.id === done.normalChildId
      && childHeader.parentSession === normalId
      && childHeader.origin === 'subagent'
      && childHeader.delegationDepth === 1, `persistence header: ${JSON.stringify(childHeader)}`)
    verifyIfControl('NORMAL_CHILD_CWD', childHeader?.cwd === workspace, `child cwd: ${childHeader?.cwd}`)
    verifyIfControl('NORMAL_CHILD_PRESET', childHeader?.agentPreset === 'standard', `child agentPreset: ${childHeader?.agentPreset}`)
    verifyIfControl('NORMAL_CHILD_SESSION_FILE', done.childSessionFiles.length === 1, `child session files: ${JSON.stringify(done.childSessionFiles)}`)

    if (!normalExecuted) {
      check('NORMAL_CHILD_FILE_HEADER', 'unverified', `normal control did not execute (${normalClassification.stage})`)
    } else if (done.childSessionFiles.length === 1) {
      const childText = readSessionFile(absoluteSessionFile(home, done.childSessionFiles[0]))
      const fileHeader = headerOfSessionText(childText)
      verify('NORMAL_CHILD_FILE_HEADER', fileHeader !== null
        && fileHeader.id === done.normalChildId
        && fileHeader.parentSession === normalId
        && fileHeader.origin === 'subagent'
        && fileHeader.delegationDepth === 1, `child session file header: ${JSON.stringify(fileHeader)}`)
    } else {
      check('NORMAL_CHILD_FILE_HEADER', 'fail', 'cannot read child session file header: expected exactly one child session file')
    }

    // 普通父会话自己的落盘记录也必须有同一次 tool/call + tool/result。
    const normalParentFile = allSessionFiles.find((file) => file.includes(normalId))
    if (!normalExecuted) {
      check('NORMAL_PARENT_PERSISTED_TOOL_EVENTS', 'unverified', `normal control did not execute (${normalClassification.stage})`)
    } else if (normalParentFile === undefined) {
      check('NORMAL_PARENT_PERSISTED_TOOL_EVENTS', 'fail', 'normal parent session file not found')
    } else {
      const parentText = readSessionFile(absoluteSessionFile(home, normalParentFile))
      const hasCall = parentText.includes(`"type":"tool/call"`) && parentText.includes(`"callId":"${normalCallId}"`) && parentText.includes(`"name":"subagent"`)
      const hasResult = parentText.includes(`"type":"tool/result"`) && parentText.includes(`"toolCallId":"${normalCallId}"`)
      verify('NORMAL_PARENT_PERSISTED_TOOL_EVENTS', hasCall && hasResult, `normal parent log contains tool/call and tool/result for ${normalCallId}`)
    }

    verifyIfControl('NORMAL_PARENT_SESSION_FILE', done.normalParentSessionFiles.length === 1, `normal parent session files: ${JSON.stringify(done.normalParentSessionFiles)}`)
    verifyIfControl('NORMAL_CHILD_MODEL_TURN', childRequest?.response?.kind === 'text', `child model request observed: ${childRequest === undefined ? false : JSON.stringify(summarizeRequest(childRequest))}`)
    verify('INCOGNITO_WRONG_CHILD_NOT_CREATED', done.incognitoEvents.every((event) => event.type !== 'tool/result' || event.callId !== incognitoCallId || event.isError === true), 'incognito tool result had no success activation')
    check('NORMAL_TURN_COMPLETED', !normalExecuted ? 'unverified' : (done.normalTurnEnd?.type === 'turn/end' && done.normalTurnError === null) ? 'pass' : 'fail',
      `normal turn end: ${JSON.stringify(done.normalTurnEnd ?? done.normalTurnError)}`)

    // 最终 sessions 目录只允许普通父会话与它的子会话；任何第三个会话都算意外。
    const finalSessionFiles = sessionFilesUnder(home)
    const unrelatedFinalFiles = finalSessionFiles.filter((file) => !file.includes(normalId) && !file.includes(done.normalChildId ?? '\0'))
    if (!normalExecuted) check('SESSION_FILES_SCOPE', 'unverified', `normal control did not execute (${normalClassification.stage})`)
    else verify('SESSION_FILES_SCOPE', unrelatedFinalFiles.length === 0 && finalSessionFiles.length === 2, `final session files: ${JSON.stringify(finalSessionFiles)}; unrelated: ${JSON.stringify(unrelatedFinalFiles)}`)
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => item.status === 'fail')
  const unverified = checks.filter((item) => item.status === 'unverified')
  const status = done?.ok !== true || failed.length > 0 ? 'FAIL' : unverified.length > 0 ? 'UNVERIFIED' : 'PASS'
  const result = {
    mode: NEGATIVE_CONTROL ? 'negative-control' : 'acceptance',
    status,
    runDir,
    baseCommit,
    startedAt,
    finishedAt: new Date().toISOString(),
    ids: { normalId, incognitoId, normalCallId, incognitoCallId, normalMarker, incognitoMarker, normalChildPrompt, incognitoChildPrompt },
    mockRequests: requestSummaries,
    checks,
    findings,
    finalSessionFiles: sessionFilesUnder(home),
    done,
  }
  writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')

  const lines = []
  lines.push(NEGATIVE_CONTROL
    ? '# M11 模型工具入口负向对照（不加载 dsh-incognito-chat）'
    : '# M11 模型工具入口验收（preview.11）')
  lines.push('')
  lines.push(`- 运行目录：\`${runDir}\``)
  lines.push(`- 基线提交：\`${baseCommit ?? '(unknown)'}\``)
  lines.push(`- 开始 / 结束：${startedAt} / ${result.finishedAt}`)
  lines.push(`- 结果：**${status}**`)
  lines.push(`- 无痕父会话 id：\`${incognitoId}\`；普通父会话 id：\`${normalId}\``)
  lines.push(`- 模拟模型工具调用 id：无痕 \`${incognitoCallId}\`；普通 \`${normalCallId}\``)
  lines.push('')
  lines.push('## 模拟模型往返')
  lines.push('')
  lines.push('| # | 匹配 | hasToolResult | 返回 | tool_call id |')
  lines.push('|---|---|---|---|---|')
  for (const record of requestSummaries) {
    const kind = record.response?.kind ?? '?'
    lines.push(`| ${record.seq} | incognito=${record.matchedIncognitoMarker} normal=${record.matchedNormalMarker} child=${record.matchedChildPrompt} | ${record.hasToolResult} | ${kind} | ${record.response?.toolCallId ?? ''} |`)
  }
  lines.push('')
  lines.push('## 判定')
  lines.push('')
  for (const item of checks) lines.push(`- [${item.status.toUpperCase()}] \`${item.id}\` — ${item.detail}`)
  lines.push('')
  lines.push('## 最终 sessions 文件')
  lines.push('')
  for (const file of result.finalSessionFiles) lines.push(`- \`${file}\``)
  lines.push('')
  lines.push('## 证据文件')
  lines.push('')
  lines.push('- `requests/request-*.json`：本地模拟模型收到的完整请求体与返回的 tool_use。')
  lines.push('- `done.json`：探针从真实 host 会话事件里记录的 assistant/message、tool/call、tool/result、sessions 快照。')
  lines.push('- `home/sessions/`：无痕阶段前后与普通对照的会话文件（zstd 多帧 JSONL）。')
  lines.push('- `logs/dsh.log`：隔离 DSH 日志（已打码）。')
  lines.push('- `result.json`：机器可读的判定与证据汇总。')
  lines.push('')
  lines.push('## 覆盖与限制')
  lines.push('')
  if (NEGATIVE_CONTROL) {
    lines.push('- 负向对照：同一隔离 profile 去掉 `dsh-incognito-chat` bundle。同一个模型 `subagent` tool_use 真正执行，在 `session-incognito-*` 会话下创建子会话并落盘。这证明本验收链能够走到工具 body，因此正向运行的 guard 拒绝可归因于插件保护，而不是参数校验/工具不可用/审批等早期阶段。')
  } else {
    lines.push('- 覆盖：本地模拟模型返回真实 `subagent` tool_use；DSH agent-loop 解析、工具注册表参数校验、`subagent` 工具 body 调用 `subagents.startActivation`；无痕 guard 拒绝；无痕阶段 sessions 目录无新增/变更；普通父会话同一路径成功启动子会话，子会话 header/落盘文件/子模型回合正确。')
    lines.push('- 未覆盖：真实 desktop UI 新建无痕会话、真实 DeepSeek 服务商、外部 provider（ACP/SDK/Codex）及子进程、子 Agent 自身的工具调用/多层递归、其它插件绕过 `subagents.startActivation` 的路径。')
  }
  lines.push('- 限制：sessions 变化用 50ms 轮询观察约 1.5s，不能排除两次采样之间的瞬时写入；最终会话文件内容另行全量扫描。')
  lines.push('')
  writeFile(path.join(runDir, 'evidence.md'), lines.join('\n'))

  console.log(`M11 model tool entry verification: ${runDir}`)
  console.log(`mode: ${NEGATIVE_CONTROL ? 'negative-control (dsh-incognito-chat NOT loaded)' : 'acceptance (dsh-incognito-chat loaded)'}`)
  console.log(`base commit: ${baseCommit ?? '(unknown)'}`)
  console.log(`status: ${status}`)
  if (done?.ok !== true) console.log(`probe error: ${done?.error ?? 'missing done.json'}`)
  else {
    console.log(`incognito tool/result: ${JSON.stringify(classifyToolResult(done.incognitoEvents.find((event) => event.type === 'tool/result' && event.callId === done.incognitoCallId)))}`)
    console.log(`incognito turn: ${JSON.stringify(done.incognitoTurnEnd ?? done.incognitoTurnError)}`)
    console.log(`incognito new session files: ${JSON.stringify(done.incognitoNewSessionFiles)}`)
    console.log(`normal tool/result: ${JSON.stringify(classifyToolResult(done.normalEvents.find((event) => event.type === 'tool/result' && event.callId === done.normalCallId)))}`)
    console.log(`normal child: ${done.normalChildId ?? 'MISSING'} file(s)=${JSON.stringify(done.childSessionFiles)}`)
    console.log(`final session files: ${JSON.stringify(sessionFilesUnder(home))}`)
  }
  for (const finding of findings) console.log(`${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`)
  console.log(status === 'PASS' ? 'RESULT: PASS' : status === 'UNVERIFIED' ? 'RESULT: UNVERIFIED' : 'RESULT: FAIL')
  return status === 'PASS' ? 0 : status === 'UNVERIFIED' ? 2 : 1
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(3)
})
