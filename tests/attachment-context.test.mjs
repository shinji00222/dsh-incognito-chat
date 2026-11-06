import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentContext } from '../src/host/attachment-context.js'

test('并发上传和普通会话在异步调用后保持各自的会话归属', async () => {
  const context = new AttachmentContext()
  const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
  const service = {
    marker: 'receiver',
    async upload(request) {
      await new Promise(resolve => setImmediate(resolve))
      return { ...context.current(), marker: this.marker, data: request.data }
    },
  }
  const restore = context.wrap(service, 'upload', request => request.sessionId)
  const [privateResult, ordinaryResult] = await Promise.all([
    service.upload({ sessionId: id, data: 'private' }),
    service.upload({ sessionId: 'session-normal', data: 'ordinary' }),
  ])
  assert.deepEqual(privateResult, { sessionId: id, incognito: true, marker: 'receiver', data: 'private' })
  assert.deepEqual(ordinaryResult, { sessionId: 'session-normal', incognito: false, marker: 'receiver', data: 'ordinary' })
  assert.throws(() => service.upload({ data: 'unknown' }), /session is missing/)
  assert.equal(context.current(), undefined)
  restore()
  assert.equal((await service.upload({ data: 'ordinary' })).incognito, undefined)
})

test('延迟读取的异步流仍保留原始会话归属，取消时也保留归属', async () => {
  const context = new AttachmentContext()
  const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
  let finalized
  const service = {
    async *read(request) {
      try {
        await Promise.resolve()
        yield context.current().sessionId
        yield context.current().sessionId
      } finally { finalized = context.current().sessionId }
    },
  }
  context.wrap(service, 'read', request => request.sessionId)
  const stream = service.read({ sessionId: id })
  assert.equal(context.current(), undefined)
  for await (const value of stream) { assert.equal(value, id); break }
  assert.equal(finalized, id)
  assert.equal(context.current(), undefined)
})

test('冻结的模型调用在异步调度时按请求的会话重新绑定归属', async () => {
  const context = new AttachmentContext()
  const privateId = 'session-incognito-11111111-1111-4111-8111-111111111111'
  const normalId = 'session-normal'
  const seen = []
  const llm = {
    async prepareCall() {
      let dispatched = false
      return Object.freeze({
        config: Object.freeze({ model: 'test' }),
        stream(options) {
          if (dispatched) throw new Error('already dispatched')
          dispatched = true
          seen.push(['dispatch', context.current().sessionId])
          return (async function* () {
            try {
              await new Promise(resolve => setImmediate(resolve))
              yield context.current().sessionId
            } finally { seen.push(['finish', context.current().sessionId]) }
          })()
        },
      })
    },
  }
  const restore = context.wrapPreparedCalls(llm)
  const call = await llm.prepareCall()
  assert.equal(Object.isFrozen(call), true)
  assert.equal(call.config.model, 'test')
  const stream = context.run(normalId, () => call.stream({ sessionId: privateId }))
  const values = await context.run(normalId, async () => {
    const out = []
    for await (const value of stream) out.push(value)
    return out
  })
  assert.deepEqual(values, [privateId])
  assert.deepEqual(seen, [['dispatch', privateId], ['finish', privateId]])
  assert.throws(() => call.stream({ sessionId: privateId }), /already dispatched/)
  const missing = await llm.prepareCall()
  assert.throws(() => missing.stream({}), /session is missing/)
  restore()
  assert.equal(context.current(), undefined)
})
