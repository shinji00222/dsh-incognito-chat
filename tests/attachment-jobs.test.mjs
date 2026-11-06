import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForSessionJobs, trackJobProducers } from '../src/host/attachment-jobs.js'

test('会话删除等待所属后台任务结束，忽略其他会话', async () => {
  let finish
  let status = 'stopping'
  const gate = new Promise(resolve => { finish = resolve })
  const jobs = {
    list: () => [{ id: 'a', owner: 'private', status }, { id: 'b', owner: 'other', status: 'running' }],
    async wait(id, timeout, owner) { assert.equal(id, 'a'); assert.equal(owner, 'private'); await gate; status = 'cancelled' },
  }
  let done = false
  const waiting = waitForSessionJobs(jobs, 'private').then(() => { done = true })
  assert.equal(done, false)
  finish()
  await waiting
  assert.equal(done, true)
})

test('后台任务未结束时拒绝清理', async () => {
  const jobs = { list: () => [{ id: 'a', owner: 'private', status: 'stopping' }], wait: async () => new Promise(resolve => setTimeout(resolve, 5)) }
  await assert.rejects(waitForSessionJobs(jobs, 'private', 1), /尚未结束/)
  await assert.rejects(waitForSessionJobs({}, 'private'), /无法确认/)
  await assert.rejects(waitForSessionJobs(undefined, 'private'), /无法确认/)
})

test('注册表提前终态时仍等待后台生产者完成，关闭后拒绝新任务', async () => {
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const jobs = { start(spec) { spec.run({}); return 'job' } }
  const tracker = trackJobProducers(jobs, id => id === 'private')
  assert.equal(jobs.start({ owner: 'private', run: () => ({ done }) }), 'job')
  tracker.beginClose('private')
  assert.throws(() => jobs.start({ owner: 'private', run: () => ({ done }) }), /正在关闭/)
  await assert.rejects(tracker.wait('private', 5), /尚未结束/)
  finish()
  await tracker.wait('private')
  tracker.restore()
})

test('生产者完成状态异常时拒绝清理，普通后台任务不受影响', async () => {
  const jobs = { start(spec) { return spec.run({}) } }
  const tracker = trackJobProducers(jobs, id => id === 'private')
  const ordinary = { done: Promise.resolve() }
  assert.equal(jobs.start({ owner: 'normal', run: () => ordinary }), ordinary)
  jobs.start({ owner: 'private', run: () => ({ done: Promise.reject(new Error('lost producer')) }) })
  tracker.beginClose('private')
  await assert.rejects(tracker.wait('private'), /无法确认/)
  tracker.restore()
})

test('无痕工具启动后台任务时拒绝缺失或不一致的会话归属', () => {
  const jobs = { start() { throw new Error('should not start') } }
  const tracker = trackJobProducers(jobs, id => id === 'private', () => ({ incognito: true, sessionId: 'private' }))
  assert.throws(() => jobs.start({}), /无法确认/)
  assert.throws(() => jobs.start({ owner: 'normal' }), /无法确认/)
  tracker.restore()
})

test('后台任务启动抛错或缺少完成句柄时保留附件', async () => {
  for (const run of [() => { throw new Error('start failed') }, () => ({})]) {
    const jobs = { start(spec) { return spec.run({}) } }
    const tracker = trackJobProducers(jobs, id => id === 'private')
    assert.throws(() => jobs.start({ owner: 'private', run }))
    tracker.beginClose('private')
    await assert.rejects(tracker.wait('private'), /无法确认/)
    tracker.restore()
  }
})
