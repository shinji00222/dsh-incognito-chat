// 练习：shin 来写 ids.js 的测试。
//
// 规则在 src/host/ids.js：只认「session-incognito- + 小写 uuid」。
// 把下面每个 test.todo 改成真正的 test，跑 `npm test` 看它变绿。
// 参考 tests/persistence.test.mjs 的写法。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIncognito, newIncognitoId, INCOGNITO_PREFIX } from '../src/host/ids.js'

const UUID = '22222222-2222-4222-8222-222222222222'

test('示范：完整的无痕 id 能认出来', () => {
  assert.equal(isIncognito(INCOGNITO_PREFIX + UUID), true)
})

// TODO(shin)：官方普通 id（session-<uuid>）不能被认成无痕
test('普通会话 id 不是无痕', () => {
  const id='session-'+UUID
  const result = isIncognito(id)
  assert.equal(result, false)
  console.log(result)
})

// TODO(shin)：大写 uuid、少一位、多一段后缀，都应该是 false。想想为什么要这么严格？
test('格式不完整或大写的 id 不是无痕',()=>{
  const id=INCOGNITO_PREFIX+UUID+'-extra'
  const result = isIncognito(id)
  assert.equal(result, false)

  const shortId = INCOGNITO_PREFIX + UUID.slice(0, -1)
  const shortResult = isIncognito(shortId)
  assert.equal(shortResult, false)

  const upperId = INCOGNITO_PREFIX + 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  assert.equal(isIncognito(upperId), false)

  const extraPrefixId = 'abc-' + INCOGNITO_PREFIX + UUID
  assert.equal(isIncognito(extraPrefixId), false)
})

// TODO(shin)：undefined、数字、对象传进来不能报错，只返回 false
test('非字符串输入返回 false', () => {
  assert.equal(isIncognito(undefined), false)
  assert.equal(isIncognito(123), false)
  assert.equal(isIncognito({}), false)
})

// TODO(shin)：newIncognitoId 可以注入固定 uuid，用它写一个「生成的 id 能被 isIncognito 认出」的测试
test('newIncognitoId 生成的 id 能被认出', () => {
  const id = newIncognitoId(() => UUID)
  assert.equal(isIncognito(id), true)
})
