import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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
