import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// Windows-only isolated integration probe. It force-stops only the DSH processes it starts.
const scripts = path.dirname(fileURLToPath(import.meta.url))
const project = path.dirname(scripts)
const work = path.join(project, 'work')
await fs.mkdir(work, { recursive: true })
const realWork = await fs.realpath(work)
assert.equal(realWork.toLowerCase(), path.join(await fs.realpath(project), 'work').toLowerCase())
const dir = await fs.mkdtemp(path.join(realWork, 'managed-crash-'))
console.log('Evidence directory:', path.relative(project, dir))
const home = path.join(dir, 'home')
const temp = path.join(dir, 'temp')
const profile = path.join(home, 'profiles/web')
const plugin = path.join(profile, 'node_modules/dsh-incognito-chat')
await fs.mkdir(plugin, { recursive: true })
await fs.mkdir(temp)
const workspace = path.join(dir, 'workspace')
await fs.mkdir(workspace)
await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-incognito-chat', 'dsh-managed-crash-probe'] } },
}))
await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '- id: session-telemetry-otel\n  disabled: true\n')
await fs.cp(path.join(project, 'src'), path.join(plugin, 'src'), { recursive: true })
for (const name of ['package.json','cordis.patch.yml']) await fs.copyFile(path.join(project, name), path.join(plugin, name))

const fixture = path.join(profile, 'node_modules/dsh-managed-crash-probe')
await fs.mkdir(fixture)
await fs.copyFile(path.join(scripts, 'fixtures/managed-crash-probe.mjs'), path.join(fixture, 'index.js'))
await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name:'dsh-managed-crash-probe', version:'0.0.0', type:'module', main:'./index.js', dsh:{bundle:{patch:'./cordis.patch.yml'}} }))
await fs.writeFile(path.join(fixture, 'cordis.patch.yml'), "- insert:\n    - id: managed-crash-probe\n      name: dsh-managed-crash-probe\n")
const exe = process.env.DSH_DESKTOP_EXE ?? path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const cli = path.join(path.dirname(exe), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_MANAGED_CRASH_DIR: workspace, TEMP: temp, TMP: temp, DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'OFF' }
for (const key of ['DSH_PROFILE','DSH_PROFILE_DIR','DSH_SESSION_ID','DSH_SHELL','DSH_WEB_URL','DEEPSEEK_API_KEY']) delete childEnv[key]
const root = path.join(temp, 'dsh-incognito-chat-attachments-v1')
const children = new Set()

async function launch() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  const child = spawn(exe, ['--expose-internals', cli, 'web', '--no-open', '--port', String(port)], { cwd: workspace, env: childEnv, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  children.add(child)
  let spawnError
  child.once('error', error => { spawnError = error })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    if (spawnError) throw spawnError
    const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)?.[0]
    if (link) {
      const res = await fetch(link, { redirect: 'manual' })
      const cookie = res.headers.getSetCookie()[0]?.split(';', 1)[0]
      assert.ok(cookie)
      const statusResponse = await fetch(new URL('/api/incognito-chat/status', link), { method:'POST', headers:{ 'content-type':'application/json', cookie }, body:'{}' })
      const status = (await statusResponse.json()).value
      if (!status?.ready) { if (status?.attachments === 'failed') throw Error('isolated attachment initialization failed'); await delay(200); continue }
      assert.equal(status.attachments, 'ok')
      return child
    }
    await delay(100)
  }
  throw Error('isolated DSH did not become ready')
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (child.kill('SIGKILL')) await exited
}

async function redactLocalGrant() {
  const credentials = path.join(home, '.credentials.yaml')
  let content
  try { content = await fs.readFile(credentials, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  await fs.writeFile(credentials, content.replace(/^(\s*(?:secret|access|refresh|token|api[_-]?key)\s*:\s*).+$/gim, '$1<redacted>'))
}

try {
  const first = await launch()
  const names = (await fs.readdir(root)).filter(n => n.startsWith('process-' + first.pid + '-'))
  assert.equal(names.length, 1)
  const session = path.join(root, names[0], 'session-synthetic-managed-probe')
  await fs.mkdir(session)
  const file = path.join(session, 'probe.txt')
  await fs.writeFile(file, 'P11-MANAGED-CRASH-SYNTHETIC')
  await fs.writeFile(path.join(workspace, 'read-target.txt'), file)
  async function waitFile(name, match) {
    for (let i = 0; i < 100; i++) {
      const failure = await fs.readFile(path.join(workspace, 'worker.error'), 'utf8').catch(() => '')
      if (failure) throw Error(failure)
      const value = await fs.readFile(path.join(workspace, name), 'utf8').catch(() => '')
      if (match(value)) return value
      await delay(100)
    }
    throw Error('worker did not produce ' + name)
  }
  const readPid = async name => Number(await waitFile(name, value => /^[1-9]\d*$/.test(value)))
  const shellPid = await readPid('shell.pid')
  const workerPid = await readPid('worker.pid')
  assert.notEqual(shellPid, workerPid)
  await waitFile('heartbeat.txt', value => value === 'P11-MANAGED-CRASH-SYNTHETIC')
  function alive(pid) {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  assert.ok(alive(shellPid) && alive(workerPid))
  await stop(first)
  await fs.access(file)
  for (let i = 0; i < 40 && (alive(shellPid) || alive(workerPid)); i++) await delay(50)
  assert.equal(alive(shellPid), false, 'managed PowerShell survived host exit')
  assert.equal(alive(workerPid), false, 'managed descendant survived host exit')
  await launch()
  await assert.rejects(fs.access(session), { code: 'ENOENT' })
  assert.equal(alive(shellPid), false)
  assert.equal(alive(workerPid), false)
  console.log('PASS: shell and descendant exited before restart; stale attachment directory was cleaned on startup')
} finally {
  for (const child of children) await stop(child)
  await redactLocalGrant()
}
