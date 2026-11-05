import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function fixture() {
  class Storage {
    constructor() { this.disk = new Map() }
    getItem(k) { return this.disk.get(String(k)) ?? null }
    setItem(k, v) { this.disk.set(String(k), String(v)) }
    removeItem(k) { this.disk.delete(String(k)) }
  }
  const localStorage = new Storage(), sessionStorage = new Storage()
  const window = { localStorage, __ModuleLoader__: { load() {} } }
  const source = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')
    .replace('  window.__ModuleLoader__.load({', '  window.installDraftGuard = installDraftGuard; window.switchAwayFrom = switchAwayFrom\n  window.__ModuleLoader__.load({')
  vm.runInNewContext(source, { window })
  return { localStorage, sessionStorage, guard: window.installDraftGuard(), switchAwayFrom: window.switchAwayFrom }
}

test('无痕草稿只进入内存，普通会话和 sessionStorage 照常持久化', () => {
  const { localStorage: s, sessionStorage: other, guard } = fixture()
  const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
  const key = 'dsh.conversation.' + id
  assert.equal(guard.ready(), true)
  s.setItem(key, 'private probe')
  s.setItem('dsh.conversation.session-normal', 'ordinary')
  other.setItem(key, 'other storage')
  assert.equal(s.getItem(key), 'private probe')
  assert.equal(s.disk.has(key), false)
  assert.equal(s.disk.get('dsh.conversation.session-normal'), 'ordinary')
  assert.equal(other.disk.get(key), 'other storage')
  guard.close(id)
  s.setItem(key, 'late write')
  assert.equal(s.getItem(key), null)
  assert.equal(s.disk.has(key), false)
})

test('保护被替换时检测失效', () => {
  const { localStorage: s, guard } = fixture()
  Object.getPrototypeOf(s).setItem = function () {}
  assert.equal(guard.ready(), false)
})

test('只在正在查看无痕会话时打开新的普通会话', async () => {
  const { switchAwayFrom } = fixture()
  const id = 'session-incognito-11111111-1111-4111-8111-111111111111'
  let state = { byId: { [id]: { retainedBy: { mainView: 1 } } } }
  let opened = false
  const ctx = {
    sessions: { list: { getSnapshot: () => state }, create: async () => 'session-normal' },
    uiWorkspace: { openSession(next) { opened = next === 'session-normal'; state = { byId: { [next]: { retainedBy: { mainView: 1 } } } } } },
  }
  await switchAwayFrom(ctx, id, 'workspace')
  assert.equal(opened, true)
  state = { byId: { [id]: { retainedBy: {} } } }; opened = false
  await switchAwayFrom(ctx, id, 'workspace')
  assert.equal(opened, false)
  state = { byId: {} }
  await assert.rejects(switchAwayFrom(ctx, id, 'workspace'), /无法确认/)
})
