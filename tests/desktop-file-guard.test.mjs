import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const privateId = 'session-incognito-11111111-1111-4111-8111-111111111111'
function fixture() {
  const listeners = new Map()
  const alerts = []
  let byId = {}
  class FileCopy {
    constructor(parts, name, options) { this.parts = parts; this.name = name; Object.assign(this, options) }
  }
  class Transfer {
    constructor() {
      this.files = []
      this.items = { add: file => this.files.push(file) }
    }
  }
  const document = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  }
  const window = {
    __DSH_HOST_PATHS__: { pathFor: file => file instanceof FileCopy ? '' : 'C:/original' },
    __ModuleLoader__: { load() {} },
    alert: message => alerts.push(message),
  }
  const source = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')
    .replace('  window.__ModuleLoader__.load({', '  window.installDesktopFileGuard = installDesktopFileGuard\n  window.__ModuleLoader__.load({')
  vm.runInNewContext(source, { window, document, File: FileCopy, DataTransfer: Transfer })
  const guard = window.installDesktopFileGuard({ sessions: { list: { getSnapshot: () => ({ byId }) } } })
  return { guard, listeners, alerts, setOwner: id => { byId = id ? { [id]: { retainedBy: { mainView: 1 } } } : {} }, FileCopy }
}
function event(target, extra = {}) {
  return { target, ...extra, prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
}
test('桌面无痕选择文件转换成无宿主路径副本，普通对话不变', () => {
  const f = fixture()
  const original = { name: 'test.txt', type: 'text/plain', lastModified: 2 }
  const target = { type: 'file', files: [original], matches: () => true }
  f.setOwner(privateId)
  f.listeners.get('change')(event(target))
  assert.ok(target.files[0] instanceof f.FileCopy)
  assert.equal(target.files[0].parts[0], original)
  assert.equal(target.files[0].name, original.name)
  f.setOwner('ordinary')
  target.files = [original]
  f.listeners.get('change')(event(target))
  assert.equal(target.files[0], original)
  f.guard.dispose()
  assert.equal(f.listeners.size, 0)
})
test('无痕拖入与粘贴文件转换副本，未知归属和目录被拒绝', () => {
  const f = fixture()
  const file = { name: 'one.txt', type: 'text/plain', lastModified: 1 }
  f.setOwner(privateId)
  for (const [name, property] of [['drop', 'dataTransfer'], ['paste', 'clipboardData']]) {
    const e = event({}, { [property]: { files: [file], items: [] } })
    f.listeners.get(name)(e)
    assert.ok(e[property].files[0] instanceof f.FileCopy)
    assert.equal(e.prevented, false)
  }
  const directory = event({}, { dataTransfer: { files: [file], items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] } })
  f.listeners.get('drop')(directory)
  assert.equal(directory.prevented, true)
  assert.equal(directory.stopped, true)
  f.setOwner(null)
  const unknown = event({ type: 'file', files: [file], matches: () => true, value: 'x' })
  f.listeners.get('change')(unknown)
  assert.equal(unknown.prevented, true)
  assert.equal(unknown.target.value, '')
})
