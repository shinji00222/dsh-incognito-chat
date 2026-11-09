// 示范测试：「前台」分流和草稿本。
//
// 读法：每个 test 都是「准备 → 动作 → 断言」三段。
// 我们不启动真的 DSH，而是写一个假的 JSONL（fakeJsonl），
// 记下它被调用了几次 —— 只要无痕会话没走到它，就证明不会落盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IncognitoStore, wrapPersistence } from '../src/host/persistence.js'
import { MemoryHandle } from '../src/host/memory-handle.js'

const NORMAL_ID = 'session-11111111-1111-4111-8111-111111111111'
const INCOGNITO_ID = 'session-incognito-22222222-2222-4222-8222-222222222222'

/** 假的 JSONL 档案员：只记录 create 被谁调用过 */
function fakeJsonl() {
  return {
    created: /** @type {string[]} */ ([]),
    async create(/** @type {any} */ header) {
      this.created.push(header.id)
      return { id: header.id, fromJsonl: true }
    },
  }
}

/** 造一个最小的会话事件 */
const event = (/** @type {number} */ seq) => ({ type: 'user/message', seq, time: 0, data: {} })

test('普通会话照常交给 JSONL', async () => {
  const jsonl = fakeJsonl()
  wrapPersistence(jsonl, new IncognitoStore())

  const handle = await jsonl.create({ id: NORMAL_ID })

  assert.deepEqual(jsonl.created, [NORMAL_ID])
  assert.equal(handle.fromJsonl, true)
})

test('无痕会话不碰 JSONL，拿到的是内存草稿本', async () => {
  const jsonl = fakeJsonl()
  const store = new IncognitoStore()
  wrapPersistence(jsonl, store)

  const handle = await jsonl.create({ id: INCOGNITO_ID })

  assert.deepEqual(jsonl.created, []) // ← 整个插件最重要的一行断言
  assert.ok(handle instanceof MemoryHandle)
  assert.equal(store.get(INCOGNITO_ID), handle)
})

test('同一个无痕 id 不能建两次', async () => {
  const jsonl = fakeJsonl()
  wrapPersistence(jsonl, new IncognitoStore())
  await jsonl.create({ id: INCOGNITO_ID })

  await assert.rejects(jsonl.create({ id: INCOGNITO_ID }), { name: 'SessionAlreadyExistsError' })
})

test('还原后恢复成原来的 create', async () => {
  const jsonl = fakeJsonl()
  const original = jsonl.create
  const restore = wrapPersistence(jsonl, new IncognitoStore())

  restore()

  assert.equal(jsonl.create, original)
  await jsonl.create({ id: INCOGNITO_ID })
  assert.deepEqual(jsonl.created, [INCOGNITO_ID]) // 卸载插件后，无痕前缀不再特殊
})

test('经过 cordis 式代理调用时，原方法拿到的是调用方传进来的 this', async () => {
  const jsonl = fakeJsonl()
  wrapPersistence(jsonl, new IncognitoStore())
  /** @type {any} */
  let seenThis
  const original = jsonl.created
  // 模拟 cordis：用一个「影子」对象当 this 来调用
  const shadow = Object.create(jsonl)
  jsonl.create.call(shadow, { id: NORMAL_ID }).then(() => {})
  await new Promise((r) => setImmediate(r))
  seenThis = shadow.created
  assert.equal(seenThis, original) // 影子对象读到的就是原对象的数组
  assert.deepEqual(jsonl.created, [NORMAL_ID])
})

test('包装没生效时直接报错，不假装装好了', () => {
  // 模拟 cordis 代理吞掉赋值：create 是只读属性
  const frozen = Object.freeze({ async create() {} })
  assert.throws(() => wrapPersistence(frozen, new IncognitoStore()))
})

test('草稿本：append 必须接着末尾的 seq', async () => {
  const handle = new MemoryHandle({ id: INCOGNITO_ID })

  await handle.append([event(0), event(1)])
  await assert.rejects(handle.append([event(5)]), { name: 'NonContiguousAppendError' })

  const { events } = await handle.read()
  assert.deepEqual(events.map((e) => e.seq), [0, 1])
})

test('草稿本：实时事件只收正好接上的', () => {
  const handle = new MemoryHandle({ id: INCOGNITO_ID })

  assert.equal(handle.receiveLive(event(0)), true)
  assert.equal(handle.receiveLive(event(0)), false) // 重复
  assert.equal(handle.receiveLive(event(3)), false) // 跳号
  assert.equal(handle.nextSeq, 1)
})

test('草稿本：read 的 offset / length', async () => {
  const handle = new MemoryHandle({ id: INCOGNITO_ID })
  await handle.append([event(0), event(1), event(2), event(3)])

  assert.deepEqual((await handle.read(1, 2)).events.map((e) => e.seq), [1, 2])
  assert.deepEqual((await handle.read(10)).events, [])
})

test('草稿本：关闭后清空内容、从仓库移除、再操作报错', async () => {
  const store = new IncognitoStore()
  const handle = store.create({ id: INCOGNITO_ID })
  await handle.append([event(0)])

  await handle.close()
  await handle.close() // 幂等：关两次不报错

  assert.equal(store.get(INCOGNITO_ID), undefined)
  assert.equal(handle.events.length, 0)
  await assert.rejects(handle.read(), { name: 'SessionHandleClosedError' })
})

test('拒绝无痕会话创建普通 ID 子会话，普通父会话仍可创建', async () => {
  const jsonl = fakeJsonl()
  wrapPersistence(jsonl, new IncognitoStore())
  await assert.rejects(jsonl.create({ id: 'child-ordinary-id', parentSession: INCOGNITO_ID }), /暂不支持/)
  assert.deepEqual(jsonl.created, [])
  await jsonl.create({ id: 'normal-child', parentSession: NORMAL_ID })
  assert.deepEqual(jsonl.created, ['normal-child'])
})
