import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detachIncognito } from '../src/host/workspace.js'

const NORMAL = 'session-11111111-1111-4111-8111-111111111111'
const A = 'session-incognito-22222222-2222-4222-8222-222222222222'
const B = 'session-incognito-33333333-3333-4333-8333-333333333333'

/** 假工作区：record.sessionIds 是原始列表，detachSession 从里面删掉 */
function fakeWorkspace(ids) {
  return {
    record: { sessionIds: [...ids] },
    async detachSession(id) {
      this.record.sessionIds = this.record.sessionIds.filter((x) => x !== id)
    },
  }
}

test('只移除无痕 id，普通会话不动', async () => {
  const ws = fakeWorkspace([A, NORMAL, B])
  const removed = await detachIncognito({ list: () => [ws] })

  assert.deepEqual(removed.sort(), [A, B].sort())
  assert.deepEqual(ws.record.sessionIds, [NORMAL])
})

test('可以只移除指定的那一个', async () => {
  const ws = fakeWorkspace([A, B])
  await detachIncognito({ list: () => [ws] }, (id) => id === A)

  assert.deepEqual(ws.record.sessionIds, [B])
})

test('归档、置顶列表里的无痕 id 也会移除', async () => {
  const registry = {
    archivedSessionIds: [A, NORMAL],
    pinnedSessionIds: [B],
    list: () => [],
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter((x) => x !== id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter((x) => x !== id) },
  }
  await detachIncognito(registry)

  assert.deepEqual(registry.archivedSessionIds, [NORMAL])
  assert.deepEqual(registry.pinnedSessionIds, [])
})

test('registry 形状不对时什么也不做，不报错', async () => {
  assert.deepEqual(await detachIncognito(undefined), [])
  assert.deepEqual(await detachIncognito({ list: () => [{}] }), [])
})
