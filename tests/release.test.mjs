import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findEffect, releaseSession } from '../src/host/release.js'

const EFFECT = Symbol.for('cordis.effect')
const ID = 'session-incognito-22222222-2222-4222-8222-222222222222'

/** 造一个 cordis 式的 effect 清理函数：带 label，被调用时记下来 */
function effect(label, calls) {
  const fn = async () => { calls.push(label) }
  fn[EFFECT] = { label, children: [] }
  return fn
}

/** 假 registry：两个插件，各有一个 fiber */
function fakeRegistry(labels, calls) {
  const fibers = labels.map((group) => ({ _disposables: group.map((label) => effect(label, calls)) }))
  return new Map(fibers.map((fiber, i) => [`plugin-${i}`, { fibers: [fiber] }]))
}

test('优先走 lifecycle effect（完整释放）', async () => {
  const calls = []
  const registry = fakeRegistry([['other'], [`agentLoop.scope(${ID})`, `agentLoop.lifecycle(${ID})`]], calls)

  assert.equal(await releaseSession(registry, ID), 'lifecycle')
  assert.deepEqual(calls, [`agentLoop.lifecycle(${ID})`])
})

test('没有 lifecycle 时退到 scope effect', async () => {
  const calls = []
  const registry = fakeRegistry([[`agentLoop.scope(${ID})`]], calls)

  assert.equal(await releaseSession(registry, ID), 'scope')
})

test('都找不到时如实返回 not-found，不碰别的会话', async () => {
  const calls = []
  const registry = fakeRegistry([['agentLoop.lifecycle(session-other)']], calls)

  assert.equal(await releaseSession(registry, ID), 'not-found')
  assert.deepEqual(calls, [])
})

test('registry 形状不对时不报错', () => {
  assert.equal(findEffect(undefined, 'x'), undefined)
  assert.equal(findEffect(new Map([['p', {}]]), 'x'), undefined)
})
