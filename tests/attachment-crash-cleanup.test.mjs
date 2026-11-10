import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { cleanupExitedAttachmentRoots, openAttachmentProcessRoot } from '../src/host/attachment-crash-cleanup.js'

test('启动清理只移除已退出进程的插件目录，保留活动进程和未知目录', async () => {
  const work = path.resolve('work')
  await mkdir(work, { recursive: true })
  const base = await mkdtemp(path.join(work, 'crash-cleanup-test-'))
  assert.equal(path.dirname(base), work)
  try {
    const { current } = await openAttachmentProcessRoot(base)
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    assert.equal(child.status, 0)
    const stale = `process-${child.pid}-11111111-1111-4111-8111-111111111111`
    await mkdir(path.join(base, stale))
    await writeFile(path.join(base, stale, 'synthetic'), 'test')
    await mkdir(path.join(base, 'unknown'))
    assert.equal(await cleanupExitedAttachmentRoots(base), 1)
    const names = await readdir(base)
    assert.deepEqual(names.sort(), [path.basename(current), 'unknown'].sort())
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('Windows 锁定的旧附件延后清理，其他旧目录仍会清理', { skip: process.platform !== 'win32' }, async () => {
  const work = path.resolve('work')
  await mkdir(work, { recursive: true })
  const base = await mkdtemp(path.join(work, 'crash-cleanup-lock-test-'))
  assert.equal(path.dirname(base), work)
  let locker
  try {
    const owner = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    assert.equal(owner.status, 0)
    const stale = ['11111111', '22222222'].map(prefix => `process-${owner.pid}-${prefix}-1111-4111-8111-111111111111`)
    for (const name of stale) await mkdir(path.join(base, name))
    const locked = path.join(base, stale[0], 'locked')
    await writeFile(locked, 'synthetic')
    const command = "$f = [IO.File]::Open($env:DSH_TEST_LOCKED_FILE, 'Open', 'Read', 'None'); try { [Console]::WriteLine('LOCKED'); Start-Sleep -Seconds 20 } finally { $f.Dispose() }"
    locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_TEST_LOCKED_FILE: locked },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const signal = AbortSignal.timeout(5000)
    const line = await Promise.race([
      once(locker.stdout, 'data', { signal }).then(([data]) => String(data).trim()),
      once(locker, 'exit', { signal }).then(([code]) => { throw Error(`lock holder exited before readiness (${code})`) }),
    ])
    assert.equal(line, 'LOCKED')
    const deferred = []
    assert.equal(await cleanupExitedAttachmentRoots(base, { onDeferred: name => deferred.push(name) }), 1)
    assert.deepEqual(deferred, [stale[0]])
    assert.deepEqual(await readdir(base), [stale[0]])
    const exit = once(locker, 'exit')
    locker.kill()
    await exit
    assert.equal(await cleanupExitedAttachmentRoots(base), 1)
    assert.deepEqual(await readdir(base), [])
  } finally {
    if (locker?.pid && locker.exitCode === null && locker.signalCode === null) {
      const exit = once(locker, 'exit')
      locker.kill()
      await exit
    }
    await rm(base, { recursive: true, force: true })
  }
})
