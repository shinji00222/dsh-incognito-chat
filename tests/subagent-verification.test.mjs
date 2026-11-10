import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { snapshotSessionFiles, changedSessionFiles, observeSessionChanges } from '../scripts/fixtures/subagent-guard-probe/snapshot.js'

test('拒绝已有目录、work 外路径以及嵌套路径', () => {
  const existing = mkdtempSync(path.join(path.resolve('work'), 'm11-path-test-'))
  const marker = path.join(existing, 'marker')
  try {
    writeFileSync(marker, 'preserve')
    for (const target of [existing, path.resolve('docs'), path.join(existing, 'nested')]) {
      const result = spawnSync(process.execPath, ['scripts/verify-subagent-guard.mjs', '--run-dir', target], { encoding: 'utf8', timeout: 10000 })
      assert.notEqual(result.status, 0)
    }
    assert.equal(readFileSync(marker, 'utf8'), 'preserve')
  } finally { rmSync(existing, { recursive: true, force: true }) }
})

test('检查文件新增、原有文件内容修改和删除', () => {
  const dir = mkdtempSync(path.join(path.resolve('work'), 'm11-snapshot-test-'))
  try {
    writeFileSync(path.join(dir, 'existing'), 'old')
    writeFileSync(path.join(dir, 'removed'), 'before')
    const before = snapshotSessionFiles(dir)
    writeFileSync(path.join(dir, 'existing'), 'new')
    writeFileSync(path.join(dir, 'added'), 'new')
    rmSync(path.join(dir, 'removed'))
    assert.deepEqual(changedSessionFiles(before, snapshotSessionFiles(dir)), ['added', 'existing', 'removed'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('观察期间延迟发生的文件写入会被发现', async () => {
  const dir = mkdtempSync(path.join(path.resolve('work'), 'm11-observe-test-'))
  try {
    const baseline = snapshotSessionFiles(dir)
    const delayed = setTimeout(() => writeFileSync(path.join(dir, 'late'), 'probe'), 30)
    try { assert.deepEqual(await observeSessionChanges(dir, baseline, { durationMs: 150, intervalMs: 10 }), ['late']) }
    finally { clearTimeout(delayed) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
