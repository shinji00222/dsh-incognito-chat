import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function snapshotSessionFiles(root) {
  const files = {}
  function walk(dir, prefix = '') {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT' && dir === root) return; throw error }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, relative)
      else if (entry.isFile()) files[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      else throw new Error(`unexpected session storage entry: ${relative}`)
    }
  }
  walk(root)
  return files
}

export function changedSessionFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => before[name] !== after[name]).sort()
}

// Polling detects persistent and observed transient changes, not writes between polls.
export async function observeSessionChanges(root, baseline, { durationMs = 1500, intervalMs = 50 } = {}) {
  const changes = new Set()
  const until = Date.now() + durationMs
  do {
    for (const file of changedSessionFiles(baseline, snapshotSessionFiles(root))) changes.add(file)
    if (Date.now() < until) await new Promise(resolve => setTimeout(resolve, intervalMs))
  } while (Date.now() < until)
  for (const file of changedSessionFiles(baseline, snapshotSessionFiles(root))) changes.add(file)
  return [...changes].sort()
}
