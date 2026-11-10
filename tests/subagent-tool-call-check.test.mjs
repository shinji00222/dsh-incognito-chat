// M11 模型工具入口验收的判定单元测试（A19）。
//
// 目的不是重跑隔离服务，而是锁住「哪些阶段绝对不能算无痕保护通过」：
// 参数校验、工具不可用、审批、没有 tool/result 都必须 unverified；
// 只有 guard 自己的拒绝消息才 pass；工具真正执行则 fail。
import assert from 'node:assert/strict'
import test from 'node:test'
import { GUARD_MESSAGE, assessIncognitoToolOutcome, classifyToolResult } from '../scripts/lib/subagent-tool-call-check.mjs'

test('A19 guard rejection is the only passing incognito outcome', () => {
  const guard = classifyToolResult({
    callId: 'toolu_guard',
    isError: true,
    text: `Error: ${GUARD_MESSAGE}`,
    error: { name: 'Error' },
  })
  assert.equal(guard.stage, 'guard')
  assert.equal(assessIncognitoToolOutcome(guard.stage), 'pass')
})

test('A19 parameter validation, unknown tool and approval are unverified, never pass', () => {
  const cases = [
    classifyToolResult({ isError: true, text: 'Error: invalid arguments: prompt is required', error: { name: 'ToolArgsError', code: 'INVALID_ARGS' } }),
    classifyToolResult({ isError: true, text: 'Error: unknown tool', error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } }),
    classifyToolResult({ isError: true, text: 'Error: tool "subagent" requires approval, but no approval channel is available', error: { name: 'Error' } }),
    classifyToolResult({ isError: true, text: 'Error: approval for tool "subagent" was cancelled', error: { name: 'Error' } }),
  ]
  const stages = cases.map((entry) => entry.stage)
  assert.deepEqual(stages, ['parameter-validation', 'tool-unavailable', 'approval', 'approval'])
  for (const stage of stages) assert.equal(assessIncognitoToolOutcome(stage), 'unverified')
})

test('A19 a missing tool result is unverified', () => {
  assert.equal(classifyToolResult(undefined).stage, 'missing')
  assert.equal(assessIncognitoToolOutcome('missing'), 'unverified')
})

test('A19 a started subagent means the protection did not hold', () => {
  const executed = classifyToolResult({ isError: false, text: 'started subagent 11111111-1111-4111-8111-111111111111', error: null })
  assert.equal(executed.stage, 'executed')
  assert.equal(assessIncognitoToolOutcome('executed'), 'fail')
})

test('A19 unrelated tool errors are not attributed to the guard', () => {
  const other = classifyToolResult({ isError: true, text: 'Error: something else failed', error: { name: 'Error' } })
  assert.equal(other.stage, 'other-error')
  assert.equal(assessIncognitoToolOutcome('other-error'), 'unverified')
})
