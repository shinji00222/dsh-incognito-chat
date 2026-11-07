import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchSessionLog } from '../src/host/session-log.js'

const incognito = 'session-incognito-11111111-1111-4111-8111-111111111111'
function fixture(existing = true) {
  const calls = []
  const provider = { prepare(request) { calls.push(request.sessionId); return { value: { events: ['probe'] }, accept() {} } } }
  const registry = {
    providers: new Map(existing ? [['dsh_session_log', provider]] : []),
    register(field, value) { this.providers.set(field, value) },
    async prepare(request) {
      const fields = {}
      for (const [key, value] of this.providers) {
        const result = await value.prepare(request)
        if (result) fields[key] = result.value
      }
      return fields
    },
  }
  return { registry, provider, calls }
}

test('无痕会话不准备额外日志，普通会话和其他字段保持原样', async () => {
  const { registry, provider, calls } = fixture()
  registry.register('other', { prepare: () => ({ value: 'other-value' }) })
  const restore = patchSessionLog(registry)
  assert.deepEqual(await registry.prepare({ sessionId: incognito }), { other: 'other-value' })
  assert.deepEqual(await registry.prepare({ sessionId: 'normal' }), { dsh_session_log: { events: ['probe'] }, other: 'other-value' })
  assert.deepEqual(calls, ['normal'])
  restore()
  assert.equal(registry.providers.get('dsh_session_log'), provider)
})

test('保护安装后注册的日志提供者', async () => {
  const { registry, provider } = fixture(false)
  const restore = patchSessionLog(registry)
  registry.register('dsh_session_log', provider)
  assert.deepEqual(await registry.prepare({ sessionId: incognito }), {})
  assert.ok((await registry.prepare({ sessionId: 'normal' })).dsh_session_log)
  restore()
  assert.equal(registry.providers.get('dsh_session_log'), provider)
})

test('注册表结构不兼容时拒绝安装', () => {
  assert.throws(() => patchSessionLog({ providers: {} }), /unsupported/)
})
