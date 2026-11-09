#!/usr/bin/env node
// Start one isolated DSH web profile and read the incognito plugin's self-check
// from the real HTTP endpoint. Used after installing a candidate tarball into a
// throwaway DSH_HOME; never reads or modifies the real desktop profile.
//
// Usage:
//   node scripts/check-isolated-status.mjs --home work/<candidate>/home
//   node scripts/check-isolated-status.mjs --home work/<candidate>/home --timeout-ms 60000
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const HOME = option('--home')
if (!HOME) {
  console.error('usage: node scripts/check-isolated-status.mjs --home <isolated-dsh-home>')
  process.exit(2)
}
const home = path.resolve(root, HOME)
const timeoutMs = Number(option('--timeout-ms', '60000'))
const exe = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const cli = path.join(path.dirname(exe), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const logFile = path.join(home, 'logs', 'status-check.log')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function redact(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8').replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1<redacted>')
  fs.writeFileSync(file, text)
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

async function waitForUrl(file, deadline) {
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const match = fs.readFileSync(file, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (match) return match[0]
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for the isolated web URL in ${file}`)
}

async function main() {
  if (!fs.existsSync(path.join(home, 'profiles', 'web', 'package.json'))) {
    throw new Error(`no web profile under ${home}`)
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const logFd = fs.openSync(logFile, 'w')
  const port = await freePort()
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[key]
  env.ELECTRON_RUN_AS_NODE = '1'
  env.DSH_HOME = home
  env.DSH_TELEMETRY_DISABLED = '1'
  const child = spawn(exe, ['--expose-internals', cli, 'web', '--no-open', '--port', String(port)], {
    cwd: root,
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  child.on('exit', () => fs.closeSync(logFd))
  try {
    const url = await waitForUrl(logFile, Date.now() + timeoutMs)
    const index = await fetch(url, { redirect: 'manual' })
    const cookie = index.headers.getSetCookie?.()[0]?.split(';', 1)[0]
    if (!cookie) throw new Error(`no browser cookie from ${index.status} index response`)
    const statusUrl = new URL('/api/incognito-chat/status', url)
    const response = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    if (!response.ok) throw new Error(`status endpoint returned HTTP ${response.status}`)
    const payload = await response.json()
    const status = payload?.value
    console.log(JSON.stringify(status, null, 2))
    const problems = []
    if (payload?.ok !== true) problems.push('endpoint ok !== true')
    if (status?.ready !== true) problems.push('ready !== true')
    if (status?.persistence !== 'ok') problems.push(`persistence=${status?.persistence}`)
    if (status?.sessionLog !== 'ok') problems.push(`sessionLog=${status?.sessionLog}`)
    if (status?.subagentGuard !== 'ok') problems.push(`subagentGuard=${status?.subagentGuard}`)
    if (status?.attachments !== 'ok') problems.push(`attachments=${status?.attachments}`)
    if (status?.projectionCache === 'failed') problems.push('projectionCache=failed')
    if (problems.length) {
      console.error(`FAIL: ${problems.join(', ')}`)
      return 1
    }
    console.log('PASS: isolated candidate self-check is ready')
    return 0
  } finally {
    await killTree(child)
    redact(logFile)
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(2)
})
