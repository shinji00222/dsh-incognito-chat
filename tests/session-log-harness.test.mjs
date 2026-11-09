import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { recordCapturedRequest, checkCaptureCounts } from '../scripts/lib/session-log-request-check.mjs'

test('重复无痕请求即使第二次携带日志也不能算通过', () => {
  const captures = { normal: [], incognito: [], unclassified: 0 }
  recordCapturedRequest(captures, 'NORMAL', {}, 'NORMAL', 'INCOGNITO')
  recordCapturedRequest(captures, 'INCOGNITO', {}, 'NORMAL', 'INCOGNITO')
  recordCapturedRequest(captures, 'INCOGNITO', { dsh_session_log: {} }, 'NORMAL', 'INCOGNITO')
  assert.ok(checkCaptureCounts(captures).some(entry => entry.code === 'REQUEST_COUNT'))
})

test('无法归属或包含两个探针的请求不能忽略', () => {
  const captures = { normal: [], incognito: [], unclassified: 0 }
  recordCapturedRequest(captures, 'neither', {}, 'NORMAL', 'INCOGNITO')
  recordCapturedRequest(captures, 'NORMAL INCOGNITO', {}, 'NORMAL', 'INCOGNITO')
  assert.equal(captures.unclassified, 2)
  assert.ok(checkCaptureCounts(captures).some(entry => entry.code === 'UNCLASSIFIED_REQUEST'))
})

test('拒绝工作目录之外或已经存在的运行目录', () => {
  const work = path.resolve('work')
  const existing = mkdtempSync(path.join(work, 'm10-path-test-'))
  const marker = path.join(existing, 'marker')
  try {
    writeFileSync(marker, 'preserve')
    for (const target of [existing, path.resolve('docs'), path.join(existing, 'nested')]) {
      const result = spawnSync(process.execPath, ['scripts/verify-session-log-request.mjs', '--run-dir', target], { encoding: 'utf8', timeout: 10000 })
      assert.notEqual(result.status, 0)
    }
    assert.equal(readFileSync(marker, 'utf8'), 'preserve')
  } finally { rmSync(existing, { recursive: true, force: true }) }
})
