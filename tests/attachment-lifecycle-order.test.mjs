import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { AttachmentStorePool } from '../src/host/attachment-store-pool.js'
import { trackJobProducers } from '../src/host/attachment-jobs.js'

const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
const ref = { attachmentId: 'sha256:' + 'b'.repeat(64) }
const base = async () => mkdtemp(path.join(path.resolve('work'), 'attachment-order-test-'))

function indexOf(events, name) {
  const index = events.indexOf(name)
  assert.notEqual(index, -1, `missing event ${name} in ${events.join(' -> ')}`)
  return index
}

test('后台任务使用附件期间删除：任务结束前不清理，事件顺序可判定', async () => {
  const dir = await base()
  try {
    const events = []
    let savedPath
    let releaseJob
    const jobGate = new Promise(resolve => { releaseJob = resolve })
    let signalStarted
    const started = new Promise(resolve => { signalStarted = resolve })
    const pool = new AttachmentStorePool(dir, storeDir => {
      savedPath = path.join(storeDir, 'file')
      return {
        fileHostPath() { return savedPath },
        async saveFile() { await writeFile(savedPath, 'probe'); return ref },
      }
    })
    await pool.saveFile(id, {})

    const jobs = { start(spec) { return spec.run({}) } }
    const tracker = trackJobProducers(jobs, value => value === id)
    jobs.start({
      owner: id,
      run: () => ({
        done: (async () => {
          events.push('job:start')
          signalStarted()
          await jobGate
          events.push('job:read')
          assert.equal(await readFile(savedPath, 'utf8'), 'probe')
          events.push('job:end')
        })(),
      }),
    })
    await started

    events.push('delete:start')
    tracker.beginClose(id)
    let deleteSettled = false
    const deleting = (async () => {
      await tracker.wait(id)
      events.push('jobs:settled')
      await pool.close(id)
      events.push('cleanup:done')
      deleteSettled = true
    })()
    await Promise.resolve()
    assert.equal(deleteSettled, false)
    assert.equal(events.includes('cleanup:done'), false)
    await access(savedPath)

    releaseJob()
    await deleting
    await assert.rejects(access(savedPath), { code: 'ENOENT' })
    assert.ok(indexOf(events, 'job:start') < indexOf(events, 'delete:start'))
    assert.ok(indexOf(events, 'delete:start') < indexOf(events, 'job:read'))
    assert.ok(indexOf(events, 'job:read') < indexOf(events, 'job:end'))
    assert.ok(indexOf(events, 'job:end') < indexOf(events, 'jobs:settled'))
    assert.ok(indexOf(events, 'jobs:settled') < indexOf(events, 'cleanup:done'))
    tracker.restore()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('后台任务结束状态无法确认时保留附件，不执行清理', async () => {
  const dir = await base()
  try {
    const events = []
    let savedPath
    const pool = new AttachmentStorePool(dir, storeDir => {
      savedPath = path.join(storeDir, 'file')
      return {
        fileHostPath() { return savedPath },
        async saveFile() { await writeFile(savedPath, 'probe'); return ref },
      }
    })
    await pool.saveFile(id, {})
    const jobs = { start(spec) { return spec.run({}) } }
    const tracker = trackJobProducers(jobs, value => value === id)
    jobs.start({ owner: id, run: () => ({ done: Promise.reject(new Error('lost producer')) }) })
    tracker.beginClose(id)
    await assert.rejects(async () => {
      await tracker.wait(id)
      events.push('cleanup:done')
    }, /无法确认/)
    await access(savedPath)
    assert.equal(events.includes('cleanup:done'), false)
    assert.deepEqual(events, [])
    tracker.restore()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
