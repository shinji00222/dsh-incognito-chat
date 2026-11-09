import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCapturedRequests, formatFindings } from '../scripts/lib/session-log-request-check.mjs'

const NORMAL_PROBE = 'M10-NORMAL-synthetic'
const INCOGNITO_PROBE = 'M10-INCOGNITO-synthetic'

function normalBody(overrides = {}) {
  return {
    model: 'deepseek-flash',
    max_tokens: 256000,
    stream: true,
    system: 'M10 synthetic system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: NORMAL_PROBE }] }],
    dsh_session_log: { sessionFormatVersion: 1, events: [{ text: NORMAL_PROBE }] },
    ...overrides,
  }
}

function incognitoBody(overrides = {}) {
  return {
    model: 'deepseek-flash',
    max_tokens: 256000,
    stream: true,
    system: 'M10 synthetic system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: INCOGNITO_PROBE }] }],
    ...overrides,
  }
}

const run = (normal, incognito) => checkCapturedRequests({
  normalBody: normal,
  incognitoBody: incognito,
  normalProbe: NORMAL_PROBE,
  incognitoProbe: INCOGNITO_PROBE,
})

const codes = (result) => result.findings.map((entry) => entry.code)

test('普通带字段、无痕不带字段时通过', () => {
  const result = run(normalBody(), incognitoBody())
  assert.deepEqual(result.findings, [])
  assert.equal(result.ok, true)
  assert.match(formatFindings(result), /RESULT: PASS/)
})

test('普通对照没有字段必须失败，不能算无痕通过', () => {
  const body = normalBody()
  delete body.dsh_session_log
  const result = run(body, incognitoBody())
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('CONTROL_MISSING_FIELD'))
})

test('普通字段没有本轮探针时失败（说明抓到的对照不属于这一轮）', () => {
  const result = run(normalBody({ dsh_session_log: { events: ['other'] } }), incognitoBody())
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('CONTROL_FIELD_WITHOUT_PROBE'))
})

test('普通请求 messages 里没有探针时失败', () => {
  const body = normalBody()
  body.messages = [{ role: 'user', content: [{ type: 'text', text: 'different' }] }]
  const result = run(body, incognitoBody())
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('CONTROL_CONVERSATION_MISSING_PROBE'))
})

test('无痕请求出现 dsh_session_log 时失败', () => {
  const result = run(normalBody(), incognitoBody({ dsh_session_log: { events: [] } }))
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('INCOGNITO_HAS_FIELD'))
})

test('无痕请求没有消息探针时失败（防止抓错请求或对话未发送）', () => {
  const body = incognitoBody()
  body.messages = []
  const result = run(normalBody(), body)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('INCOGNITO_CONVERSATION_MISSING_PROBE'))
  assert.ok(codes(result).includes('INCOGNITO_MESSAGES_MISSING'))
})

test('无痕请求没有 model 时失败（正常请求结构不完整）', () => {
  const body = incognitoBody()
  delete body.model
  const result = run(normalBody(), body)
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('INCOGNITO_MODEL_MISSING'))
})

test('缺少任一侧请求时直接失败', () => {
  assert.equal(run(null, incognitoBody()).ok, false)
  assert.ok(codes(run(null, incognitoBody())).includes('NORMAL_REQUEST_MISSING'))
  assert.equal(run(normalBody(), null).ok, false)
  assert.ok(codes(run(normalBody(), null)).includes('INCOGNITO_REQUEST_MISSING'))
})
