import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchSubagentStart } from '../src/host/subagent-guard.js'
const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
test('拒绝无痕父会话启动子 agent，普通会话保持原行为', () => {
  const calls = []
  const service = { startActivation(spec) { calls.push([this, spec]); return 'started' } }
  const original = service.startActivation
  const restore = patchSubagentStart(service)
  assert.throws(() => service.startActivation({ request: { parent: { session: { id } } } }), /暂不支持/)
  assert.equal(calls.length, 0)
  const spec = { request: { parent: { session: { id: 'ordinary' } } } }
  assert.equal(service.startActivation(spec), 'started')
  assert.deepEqual(calls, [[service, spec]])
  restore()
  assert.equal(service.startActivation, original)
})
test('接口不兼容时报告失败', () => assert.throws(() => patchSubagentStart({}), /unsupported/))
