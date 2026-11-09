import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TemporaryAttachments } from '../src/host/temporary-attachments.js'

const a = 'session-incognito-11111111-1111-4111-8111-111111111111'
const b = 'session-incognito-22222222-2222-4222-8222-222222222222'

test('同内容的不同无痕会话使用独立目录，关闭等待未完成的操作', async () => {
  const work = path.resolve('work')
  await mkdir(work, { recursive: true })
  const base = await mkdtemp(path.join(work, 'temp-attachment-test-'))
  assert.equal(path.dirname(base), work)
  try {
    const temp = new TemporaryAttachments(base)
    let release
    const wait = new Promise(resolve => { release = resolve })
    let firstDir
    let started
    const startedPromise = new Promise(resolve => { started = resolve })
    const running = temp.use(a, async dir => {
      firstDir = dir
      await writeFile(path.join(dir, 'probe'), 'same data')
      started()
      await wait
    })
    await startedPromise
    const secondDir = await temp.use(b, async dir => {
      await writeFile(path.join(dir, 'probe'), 'same data')
      return dir
    })
    assert.notEqual(firstDir, secondDir)
    const contentId = 'sha256:' + 'a'.repeat(64)
    const firstToken = await temp.register(a, 'probe', contentId)
    const secondToken = await temp.register(b, 'probe', contentId)
    assert.notEqual(firstToken, secondToken)
    assert.equal(await temp.access(a, firstToken, async ref => readFile(ref.path, 'utf8')), 'same data')
    await assert.rejects(temp.access(b, firstToken, async () => {}), /not owned/)
    await assert.rejects(temp.register(a, '../outside', contentId), /escaped/)
    let completed = false
    const closing = temp.close(a).then(() => { completed = true })
    await assert.rejects(temp.use(a, async () => {}), /clos/)
    assert.equal(completed, false)
    release()
    await running
    await closing
    await assert.rejects(readFile(path.join(firstDir, 'probe')), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(secondDir, 'probe'), 'utf8'), 'same data')
    await temp.close(b)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('目录尚在创建时关闭会阻止后续操作', async () => {
  const work = path.resolve('work')
  await mkdir(work, { recursive: true })
  const base = await mkdtemp(path.join(work, 'temp-attachment-test-'))
  assert.equal(path.dirname(base), work)
  try {
    const temp = new TemporaryAttachments(base)
    let invoked = false
    const use = temp.use(a, async () => { invoked = true })
    const closing = temp.close(a)
    await assert.rejects(use, /closing/)
    assert.equal(await closing, true)
    assert.equal(invoked, false)
    await assert.rejects(temp.use(a, async () => {}), /closed/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('关闭期间已开始的保存可以完成登记，关闭等待登记结束', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'temp-attachment-test-'))
  try {
    const temp = new TemporaryAttachments(base)
    let resume, started
    const gate = new Promise(resolve => { resume = resolve })
    const begun = new Promise(resolve => { started = resolve })
    const save = temp.use(a, async (dir, register) => {
      await writeFile(path.join(dir, 'probe'), 'data')
      started()
      await gate
      return register('probe', 'sha256:' + 'a'.repeat(64))
    })
    await begun
    let done = false
    const closing = temp.close(a).then(() => { done = true })
    assert.equal(done, false)
    resume()
    assert.match(await save, /^[0-9a-f-]{36}$/)
    await closing
    assert.equal(done, true)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('已经结束的操作不能借用残留的异步上下文绕过关闭', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'temp-attachment-test-'))
  try {
    const temp = new TemporaryAttachments(base)
    let resume
    const gate = new Promise(resolve => { resume = resolve })
    let detached
    await temp.use(a, async () => {
      detached = gate.then(() => temp.use(a, async () => 'unexpected'))
    })
    await temp.close(a)
    resume()
    await assert.rejects(detached, /closed/)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('延迟写入完成后才清理，关闭后的操作无法重新创建目录', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'temp-attachment-test-'))
  try {
    const temp = new TemporaryAttachments(base)
    let start, resume, dir
    const begun = new Promise(resolve => { start = resolve })
    const gate = new Promise(resolve => { resume = resolve })
    const order = []
    const writing = temp.use(a, async sessionDir => {
      dir = sessionDir
      start()
      await gate
      await writeFile(path.join(dir, 'delayed-probe'), 'synthetic')
      order.push('write-finished')
    })
    await begun
    const otherDir = await temp.use(b, async sessionDir => {
      await writeFile(path.join(sessionDir, 'other-probe'), 'keep')
      return sessionDir
    })
    const closing = temp.close(a).then(() => order.push('close-finished'))
    await assert.rejects(temp.use(a, async () => {}), /clos/)
    assert.deepEqual(order, [])
    resume()
    await writing
    await closing
    assert.deepEqual(order, ['write-finished', 'close-finished'])
    await assert.rejects(readFile(path.join(dir, 'delayed-probe')), { code: 'ENOENT' })
    await assert.rejects(temp.use(a, async () => { throw new Error('must not run') }), /closed/)
    await assert.rejects(readFile(path.join(dir, 'delayed-probe')), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(otherDir, 'other-probe'), 'utf8'), 'keep')
    await temp.close(b)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('清理目标异常时关闭失败，不返回清理成功', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'temp-attachment-test-'))
  try {
    const temp = new TemporaryAttachments(base)
    const dir = await temp.use(a, async sessionDir => sessionDir)
    await rm(dir, { recursive: true })
    await writeFile(dir, 'not a directory')
    await assert.rejects(temp.close(a), /unsafe temporary attachment cleanup target/)
    assert.equal(await readFile(dir, 'utf8'), 'not a directory')
    await assert.rejects(temp.use(a, async () => {}), /closed/)
  } finally { await rm(base, { recursive: true, force: true }) }
})
