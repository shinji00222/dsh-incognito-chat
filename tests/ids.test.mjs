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
test.todo('普通会话 id 不是无痕')

// TODO(shin)：大写 uuid、少一位、多一段后缀，都应该是 false。想想为什么要这么严格？
test.todo('格式不完整或大写的 id 不是无痕')

// TODO(shin)：undefined、数字、对象传进来不能报错，只返回 false
test.todo('非字符串输入返回 false')

// TODO(shin)：newIncognitoId 可以注入固定 uuid，用它写一个「生成的 id 能被 isIncognito 认出」的测试
test.todo('newIncognitoId 生成的 id 能被认出')
