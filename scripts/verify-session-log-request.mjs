#!/usr/bin/env node
// M10：验证“额外会话日志是否随请求发送”，覆盖真实请求组装 + HTTP 发送链路。
//
// 做法：
//   1. 在 work/session-log-request-<时间戳>/ 下建一个全新 DSH_HOME（隔离，不碰 ~/.dsh）
//   2. 把当前仓库的插件和探针插件直接装进隔离 web profile
//   3. 起一个本地 DeepSeek Messages 模拟服务端，记录收到的请求体（不记录 header）
//   4. 用真实 DSH 运行时启动 web profile；探针插件在 host 内用真实 Agent 链路发两轮合成对话：
//        普通会话 session-<uuid>、无痕会话 session-incognito-<uuid>
//   5. 判定：普通对照必须带 dsh_session_log；无痕必须不带且对话照常发送
//
// 安全边界：只用合成探针；API key 是本地假值，只放进程环境；不记录 header/Cookie；
// 不安装、不改动真实 desktop profile；不发送真实模型请求（baseURL 指向本地模拟端）。
//
// 用法：
//   node scripts/verify-session-log-request.mjs
//   node scripts/verify-session-log-request.mjs --negative-control
//   node scripts/verify-session-log-request.mjs --run-dir work/session-log-request-xxx
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { checkCapturedRequests, formatFindings } from './lib/session-log-request-check.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}

const NEGATIVE_CONTROL = flag('--negative-control')
const TIMEOUT_MS = Number(option('--timeout-ms', '90000'))
const DESKTOP_EXE = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const SYNTHETIC_API_KEY = 'sk-m10-synthetic-not-a-real-key'
const FIELD = 'dsh_session_log'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createRunDir() {
  const explicit = option('--run-dir')
  if (explicit) return path.resolve(root, explicit)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (let attempt = 0; ; attempt += 1) {
    const candidate = path.join(root, 'work', `session-log-request-${stamp}${attempt === 0 ? '' : `-${attempt}`}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function buildIsolatedProfile({ runDir, disableSessionLog, baseURL }) {
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
          'dsh-session-log-m10-probe',
        ],
      },
    },
  }, null, 2) + '\n')
  writeFile(path.join(profile, 'cordis.yml'), '[]\n')

  const patch = [
    '# Isolated M10 verification profile. Never applied to the real desktop profile.',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(baseURL)}`,
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    ...disableSessionLog
      ? ['- id: session-log-deepseek', '  disabled: true']
      : [],
  ]
  writeFile(path.join(profile, 'cordis.patch.yml'), patch.join('\n') + '\n')

  const pluginTarget = path.join(profile, 'node_modules', 'dsh-incognito-chat')
  fs.cpSync(path.join(root, 'src'), path.join(pluginTarget, 'src'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pluginTarget, 'package.json'))
  fs.copyFileSync(path.join(root, 'cordis.patch.yml'), path.join(pluginTarget, 'cordis.patch.yml'))

  const probeTarget = path.join(profile, 'node_modules', 'dsh-session-log-m10-probe')
  fs.cpSync(path.join(root, 'scripts', 'fixtures', 'session-log-m10-probe'), probeTarget, { recursive: true })

  return { home, profile, workspace }
}

function startMockServer({ runDir, normalProbe, incognitoProbe }) {
  const requestsDir = path.join(runDir, 'requests')
  fs.mkdirSync(requestsDir, { recursive: true })
  const captures = { normal: null, incognito: null, other: [] }
  const respond = () => {
    const text = 'M10 synthetic completion.'
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_m10_synthetic', type: 'message', role: 'assistant', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  }

  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      body = { raw }
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    fs.appendFileSync(path.join(runDir, 'mock.log'), `${request.method} ${pathname} ${raw.length}\n`)
    if (request.method === 'POST' && pathname.endsWith('/messages')) {
      const text = raw
      const slot = text.includes(normalProbe) ? 'normal' : text.includes(incognitoProbe) ? 'incognito' : null
      if (slot === null) {
        captures.other.push({ url: request.url, bytes: raw.length })
      } else if (captures[slot] === null) {
        captures[slot] = body
        writeFile(path.join(requestsDir, `${slot}.json`), JSON.stringify(body, null, 2))
      }
      const sse = respond()
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'close',
      })
      response.end(sse)
      return
    }
    if (pathname.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [] }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, captures, requestsDir })
    })
  })
}

async function stopMockServer(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

function spawnDsh({ runDir, home, workspace, port, baseURL }) {
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
    DEEPSEEK_BASE_URL: baseURL,
    DEEPSEEK_API_KEY: SYNTHETIC_API_KEY,
    DSH_SYSTEM_PROMPT: 'M10 synthetic system prompt. This run contains no real conversation.',
    M10_RUN_DIR: runDir,
    M10_WORKSPACE: workspace,
    M10_NORMAL_ID: process.env.M10_NORMAL_ID,
    M10_INCOGNITO_ID: process.env.M10_INCOGNITO_ID,
    M10_NORMAL_PROBE: process.env.M10_NORMAL_PROBE,
    M10_INCOGNITO_PROBE: process.env.M10_INCOGNITO_PROBE,
  })
  const child = spawn(DESKTOP_EXE, ['--expose-internals', cli, 'web', '--no-open', '--port', String(port)], {
    cwd: workspace,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  let spawnError = null
  child.once('error', (error) => {
    spawnError = error
    try {
      fs.appendFileSync(logFile, `spawn error: ${error?.stack ?? error}\n`)
    } catch {}
    try { fs.closeSync(logFd) } catch {}
  })
  child.on('exit', () => fs.closeSync(logFd))
  return { child, logFile, spawnError: () => spawnError }
}

function redactLog(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
    .replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
  fs.writeFileSync(file, text)
}

// The isolated web profile generates its own browser-session grant at boot.
// It is a throwaway secret, but the run directory is kept as evidence, so mask
// every secret-shaped value instead of leaving a usable credential on disk.
function redactIsolatedCredentials(home) {
  const file = path.join(home, '.credentials.yaml')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  const redacted = text.replace(/^(\s*(?:secret|access|refresh|token|api[_-]?key)\s*:\s*).+$/gim, '$1<redacted>')
  fs.writeFileSync(file, redacted)
}

async function killProcessTree(child) {
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

async function runHarness({ disableSessionLog }) {
  const runDir = createRunDir()
  fs.mkdirSync(runDir, { recursive: true })
  const nonce = randomUUID().slice(0, 8)
  const normalProbe = `M10-NORMAL-${nonce}`
  const incognitoProbe = `M10-INCOGNITO-${nonce}`
  const normalId = `session-${randomUUID()}`
  const incognitoId = `session-incognito-${randomUUID()}`
  const workspace = path.join(runDir, 'workspace')

  process.env.M10_NORMAL_ID = normalId
  process.env.M10_INCOGNITO_ID = incognitoId
  process.env.M10_NORMAL_PROBE = normalProbe
  process.env.M10_INCOGNITO_PROBE = incognitoProbe

  const mock = await startMockServer({ runDir, normalProbe, incognitoProbe })
  const baseURL = `http://127.0.0.1:${mock.port}`
  const { home } = buildIsolatedProfile({ runDir, disableSessionLog, baseURL })
  const port = await freePort()
  const { child, logFile, spawnError } = spawnDsh({ runDir, home, workspace, port, baseURL })
  const doneFile = path.join(runDir, 'done.json')
  const deadline = Date.now() + TIMEOUT_MS
  let done = null
  let exitCode = null
  child.once('exit', (code) => { exitCode = code })
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(doneFile)) {
        done = JSON.parse(fs.readFileSync(doneFile, 'utf8'))
        break
      }
      if (spawnError() !== null) break
      if (exitCode !== null) break
      await sleep(200)
    }
    if (done === null) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n') : '(no log)'
      const reason = spawnError() ?? exitCode
      throw new Error(`probe did not finish (spawn/exit=${String(reason ?? 'running')})\n--- dsh log tail ---\n${tail}`)
    }
    if (done.ok !== true) throw new Error(`probe failed: ${done.error}`)
  } finally {
    await killProcessTree(child)
    await stopMockServer(mock.server)
    redactLog(logFile)
    redactIsolatedCredentials(home)
  }

  const normalBody = mock.captures.normal
  const incognitoBody = mock.captures.incognito
  const result = checkCapturedRequests({ normalBody, incognitoBody, normalProbe, incognitoProbe })
  const summary = {
    negativeControl: disableSessionLog,
    runDir,
    normalSessionId: normalId,
    incognitoSessionId: incognitoId,
    normalProbe,
    incognitoProbe,
    normal: normalBody === null ? null : {
      model: normalBody.model,
      hasField: Object.hasOwn(normalBody, FIELD),
      fieldBytes: Object.hasOwn(normalBody, FIELD) ? JSON.stringify(normalBody[FIELD]).length : 0,
      messages: Array.isArray(normalBody.messages) ? normalBody.messages.length : null,
      requestBytes: JSON.stringify(normalBody).length,
    },
    incognito: incognitoBody === null ? null : {
      model: incognitoBody.model,
      hasField: Object.hasOwn(incognitoBody, FIELD),
      messages: Array.isArray(incognitoBody.messages) ? incognitoBody.messages.length : null,
      requestBytes: JSON.stringify(incognitoBody).length,
    },
    otherRequests: mock.captures.other.length,
    ok: result.ok,
    findings: result.findings,
  }
  writeFile(path.join(runDir, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
  return { runDir, result, summary, normalBody, incognitoBody }
}

async function main() {
  if (NEGATIVE_CONTROL) {
    const { runDir, result } = await runHarness({ disableSessionLog: true })
    const rejected = !result.ok && result.findings.some((entry) => entry.code === 'CONTROL_MISSING_FIELD')
    console.log(`negative control run: ${runDir}`)
    console.log(formatFindings(result))
    if (rejected) {
      console.log('PASS negative control: a normal control request without dsh_session_log is rejected, not counted as an incognito pass')
      return 0
    }
    console.log('FAIL negative control: verifier did not reject the missing control field')
    return 1
  }

  const { runDir, result, summary } = await runHarness({ disableSessionLog: false })
  console.log(`M10 isolated request verification: ${runDir}`)
  console.log(`normal session: ${summary.normalSessionId}`)
  console.log(`incognito session: ${summary.incognitoSessionId}`)
  console.log(`normal request: ${summary.normal ? `model=${summary.normal.model} field=${summary.normal.hasField} messages=${summary.normal.messages} bytes=${summary.normal.requestBytes}` : 'MISSING'}`)
  console.log(`incognito request: ${summary.incognito ? `model=${summary.incognito.model} field=${summary.incognito.hasField} messages=${summary.incognito.messages} bytes=${summary.incognito.requestBytes}` : 'MISSING'}`)
  console.log(formatFindings(result))
  return result.ok ? 0 : 1
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(2)
})
