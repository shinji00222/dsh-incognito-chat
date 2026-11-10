import { mkdir, lstat, realpath, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const processDirectory = /^process-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const deferredRemovalCodes = new Set(['EACCES', 'EBUSY', 'EPERM', 'ENOTEMPTY'])

function definitelyExited(pid) {
  try { process.kill(pid, 0); return false } catch (error) {
    // Permission errors and unknown errors do not prove that a process exited.
    return error?.code === 'ESRCH'
  }
}

// A shared plugin-only root contains one directory per process, so a restart
// never wipes a second running DSH. A reused PID conservatively postpones
// cleanup rather than risking another process's data.
export async function openAttachmentProcessRoot(base) {
  if (!path.isAbsolute(base)) throw new Error('temporary attachment root must be absolute')
  base = path.resolve(base)
  await mkdir(base, { recursive: true })
  const info = await lstat(base)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe temporary attachment root')
  const actualBase = await realpath(base)
  if (normalized(actualBase) !== normalized(base)) throw new Error('temporary attachment root traverses a link')
  const current = path.join(actualBase, `process-${process.pid}-${randomUUID()}`)
  await mkdir(current)
  return { base: actualBase, current }
}

export async function cleanupExitedAttachmentRoots(base, { onDeferred = () => {} } = {}) {
  const info = await lstat(base)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe temporary attachment root')
  const actualBase = await realpath(base)
  if (normalized(actualBase) !== normalized(base)) throw new Error('temporary attachment root traverses a link')
  let removed = 0
  for (const child of await readdir(actualBase, { withFileTypes: true })) {
    const match = processDirectory.exec(child.name)
    if (!match || !child.isDirectory() || child.isSymbolicLink()) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || !definitelyExited(pid)) continue
    const target = path.join(actualBase, child.name)
    try {
      const targetInfo = await lstat(target)
      const actual = await realpath(target)
      if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink() || normalized(path.dirname(actual)) !== normalized(actualBase) || normalized(actual) !== normalized(target)) continue
      if (!definitelyExited(pid)) continue
      await rm(actual, { recursive: true })
      removed++
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      if (!deferredRemovalCodes.has(error?.code)) throw error
      onDeferred(child.name, error.code)
    }
  }
  return removed
}
