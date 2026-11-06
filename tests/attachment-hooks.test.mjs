import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installAttachmentHooks, patchToolDispatch } from '../src/host/attachment-hooks.js'
import { AttachmentContext } from '../src/host/attachment-context.js'

const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
const methods = ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'readImage', 'readImageRequest', 'readFileStream', 'imageHostPath', 'fileHostPath']
function fixture() {
  const calls = []
  const attachments = Object.fromEntries(methods.map(name => [name, function (...args) { calls.push(['ordinary', name, ...args]); return 'ordinary' }]))
  const sessionController = {
    async prompt(request) { return attachments.saveImage(request.image) },
    attachment(request) { return attachments.readImage(request.ref) },
    updateQueue(request) { return attachments.saveImage(request.image) },
  }
  const fileUploads = {
    upload(agent, request) { return attachments.saveFile(request) },
    uploadStream(request) { return attachments.saveFileStream(request) },
  }
  const commands = { execute(agent, request) { return attachments.saveImage(request) } }
  const llm = { stream() { return (async function* () {})() }, async prepareCall() { return Object.freeze({ stream() { return (async function* () {})() } }) } }
  const tools = { async dispatchScheduledExecution(exec) { return exec.name } }
  const pool = {
    async saveImage(owner, input) { calls.push(['private', 'image', owner, input]); return { ref: 'private image' } },
    async saveFile(owner, input) { calls.push(['private', 'file', owner, input]); return { ref: 'private file' } },
    async saveFileStream(owner, input) { calls.push(['private', 'stream', owner, input]); return { ref: 'private stream' } },
    reference(owner, kind, ref) { calls.push(['reference', owner, kind, ref]); return { token: 'token', path: 'private-path' } },
    async readImage(owner, token, ref) { return [owner, token, ref] },
  }
  return { attachments, sessionController, fileUploads, commands, llm, tools, pool, calls }
}

test('会话和上传入口按会话分流，无法识别归属时拒绝写入', async () => {
  const f = fixture()
  const { restore } = installAttachmentHooks(f)
  assert.equal(await f.sessionController.prompt({ sessionId: id, image: 'one' }), 'private image')
  assert.equal(await f.sessionController.prompt({ sessionId: 'normal', image: 'two' }), 'ordinary')
  assert.equal(await f.fileUploads.upload({ session: { id } }, 'three'), 'private file')
  assert.equal(await f.fileUploads.uploadStream({ sessionId: id }), 'private stream')
  assert.equal(await f.commands.execute({ session: { id } }, 'four'), 'private image')
  assert.deepEqual(await f.sessionController.attachment({ sessionId: id, ref: 'ref' }), [id, 'token', 'ref'])
  assert.throws(() => f.attachments.saveImage('unknown'), /缺少对话归属/)
  assert.equal(f.calls.filter(call => call[0] === 'ordinary').length, 1)
  restore()
  assert.equal(f.attachments.saveImage('after restore'), 'ordinary')
})

test('缺少任一入口时撤销之前的补丁', () => {
  const f = fixture()
  const original = f.attachments.saveImage
  delete f.fileUploads.uploadStream
  assert.throws(() => installAttachmentHooks(f), /uploadStream/)
  assert.equal(f.attachments.saveImage, original)
  assert.equal(f.attachments.saveImage('normal'), 'ordinary')
})

test('普通工具保持原行为，无法确认工具归属时拒绝执行', async () => {
  const calls = []
  const tools = { async dispatchScheduledExecution(exec) { calls.push([this, exec]); return 'ok' } }
  const original = tools.dispatchScheduledExecution
  const restore = patchToolDispatch(tools, new AttachmentContext(), { withToolExecution() { throw Error('unexpected lease') } })
  const exec = { agent: { session: { id: 'normal' } } }
  assert.equal(await tools.dispatchScheduledExecution(exec), 'ok')
  assert.deepEqual(calls, [[tools, exec]])
  await assert.rejects(tools.dispatchScheduledExecution({}), /session is missing/)
  restore()
  assert.equal(tools.dispatchScheduledExecution, original)
})
