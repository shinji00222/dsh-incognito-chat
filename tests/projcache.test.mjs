import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchProjectionCache } from '../src/host/projcache.js'

const NORMAL_ID = 'session-11111111-1111-4111-8111-111111111111'
const INCOGNITO_ID = 'session-incognito-22222222-2222-4222-8222-222222222222'

function fakeCache() {
  return {
    written: /** @type {string[]} */ ([]),
    async put(/** @type {string} */ id, /** @type {any} */ _identity, /** @type {any} */ _rows) {
      this.written.push(id)
    },
  }
}

test('投影缓存：无痕跳过，普通照写', async () => {
  const cache = fakeCache()
  assert.notEqual(patchProjectionCache(cache), false)

  await cache.put(NORMAL_ID, {}, {})
  await cache.put(INCOGNITO_ID, {}, {})

  assert.deepEqual(cache.written, [NORMAL_ID])
})

test('投影缓存：put 不存在（DSH 改了内部实现）时返回 false', () => {
  assert.equal(patchProjectionCache({}), false)
  assert.equal(patchProjectionCache({ put() {} }), false) // 参数个数也对不上
})
