import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { AttachmentStorePool } from '../src/host/attachment-store-pool.js'
import { AttachmentContext } from '../src/host/attachment-context.js'
import { patchToolDispatch } from '../src/host/attachment-hooks.js'

const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
const ref = { attachmentId: 'sha256:' + 'a'.repeat(64) }

test('关闭清理失败后可以重试，关闭期间仍拒绝访问', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'attachment-pool-retry-test-'))
  try {
    let sessionDir
    const pool = new AttachmentStorePool(base, dir => {
      sessionDir = dir
      return {
        fileHostPath() { return path.join(dir, 'file') },
        async saveFile() { await writeFile(path.join(dir, 'file'), 'probe'); return ref },
      }
    })
    await pool.saveFile(id, {})
    await rm(sessionDir, { recursive: true })
    await writeFile(sessionDir, 'not a directory')
    await assert.rejects(pool.close(id), /unsafe temporary attachment cleanup target/)
    await assert.rejects(pool.saveFile(id, {}), /closed/)
    await rm(sessionDir)
    await mkdir(sessionDir)
    await writeFile(path.join(sessionDir, 'file'), 'probe')
    await pool.closeAll()
    await assert.rejects(access(sessionDir), { code: 'ENOENT' })
    await assert.rejects(pool.saveFile(id, {}), /closed/)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('删除等待正在保存的附件及其登记完成', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'attachment-pool-test-'))
  try {
    let started, resume, savedPath
    const begun = new Promise(resolve => { started = resolve })
    const gate = new Promise(resolve => { resume = resolve })
    const pool = new AttachmentStorePool(base, dir => ({
      imageHostPath() { return path.join(dir, 'image') },
      async saveImage() {
        savedPath = path.join(dir, 'image')
        await writeFile(savedPath, 'image')
        started()
        await gate
        return ref
      },
    }))
    const save = pool.saveImage(id, {})
    await begun
    let closed = false
    const closing = pool.close(id).then(() => { closed = true })
    assert.equal(closed, false)
    await access(savedPath)
    resume()
    assert.equal((await save).ref, ref)
    await closing
    await assert.rejects(access(savedPath), { code: 'ENOENT' })
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('工具通过宿主路径读取时删除等待工具结束，失败也释放等待', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'attachment-pool-test-'))
  try {
    let started, resume, savedPath
    const begun = new Promise(resolve => { started = resolve })
    const gate = new Promise(resolve => { resume = resolve })
    const pool = new AttachmentStorePool(base, dir => ({
      fileHostPath() { return path.join(dir, 'file') },
      async saveFile() { savedPath = path.join(dir, 'file'); await writeFile(savedPath, 'probe'); return ref },
    }))
    await pool.saveFile(id, {})
    const context = new AttachmentContext()
    const tools = { async dispatchScheduledExecution(exec) {
      assert.equal(context.current().sessionId, id)
      started()
      await gate
      assert.equal(await readFile(exec.path, 'utf8'), 'probe')
      throw new Error('tool failed after read')
    } }
    const restore = patchToolDispatch(tools, context, pool)
    const running = tools.dispatchScheduledExecution({ agent: { session: { id } }, path: savedPath })
    await begun
    let closed = false
    const closing = pool.close(id).then(() => { closed = true })
    await assert.rejects(tools.dispatchScheduledExecution({ agent: { session: { id } } }), /clos/)
    await access(savedPath)
    assert.equal(closed, false)
    resume()
    await assert.rejects(running, /tool failed after read/)
    await closing
    await assert.rejects(access(savedPath), { code: 'ENOENT' })
    restore()
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('删除开始后已运行工具仍可取得并读取附件，新工具被拒绝', async () => {
  const base = await mkdtemp(path.join(path.resolve('work'), 'attachment-pool-test-'))
  try {
    let resume, started
    const gate = new Promise(resolve => { resume = resolve })
    const begun = new Promise(resolve => { started = resolve })
    const pool = new AttachmentStorePool(base, dir => ({
      fileHostPath() { return path.join(dir, 'file') },
      async saveFile() { await writeFile(path.join(dir, 'file'), 'probe'); return ref },
      async *readFileStream() { yield await readFile(path.join(dir, 'file')) },
    }))
    await pool.saveFile(id, {})
    const tools = { async dispatchScheduledExecution() {
      started()
      await gate
      const entry = pool.reference(id, 'file', ref)
      const chunks = []
      for await (const chunk of pool.readFileStream(id, entry.token, ref)) chunks.push(chunk)
      return Buffer.concat(chunks).toString()
    } }
    patchToolDispatch(tools, new AttachmentContext(), pool)
    const running = tools.dispatchScheduledExecution({ agent: { session: { id } } })
    await begun
    const closing = pool.close(id)
    assert.throws(() => pool.reference(id, 'file', ref), /closing/)
    await assert.rejects(tools.dispatchScheduledExecution({ agent: { session: { id } } }), /clos/)
    resume()
    assert.equal(await running, 'probe')
    assert.equal(await closing, true)
  } finally { await rm(base, { recursive: true, force: true }) }
})
