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
