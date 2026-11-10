// Per-session directory lifecycle for routed DSH attachments.
import { mkdir, mkdtemp, lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isIncognito } from './ids.js'

export class TemporaryAttachments {
  #base
  #sessions = new Map()
  #closed = new Set()
  #leases = new AsyncLocalStorage()

  constructor(base) {
    if (!path.isAbsolute(base)) throw new Error('temporary attachment root must be absolute')
    this.#base = path.resolve(base)
  }

  sessionIds() { return [...this.#sessions.keys()] }

  hasLease(id) {
    const lease = this.#leases.getStore()
    return lease?.id === id && lease.live
  }

  async #open(id) {
    await mkdir(this.#base, { recursive: true })
    const info = await lstat(this.#base)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe temporary attachment root')
    const base = await realpath(this.#base)
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    if (normalize(base) !== normalize(this.#base)) throw new Error('temporary attachment root traverses a link')
    const dir = await mkdtemp(path.join(base, 'session-'))
    const resolved = await realpath(dir)
    if (path.dirname(resolved) !== base) throw new Error('temporary directory escaped root')
    return { id, base, dir: resolved, active: 0, closing: false, drained: null, wake: null, references: new Map() }
  }

  // The plugin identifier is distinct from the upstream content hash.
  async register(id, relativePath, contentId) {
    return this.use(id, (dir, register) => register(relativePath, contentId))
  }

  async #register(entry, relativePath, contentId) {
      const { dir } = entry
      if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('invalid attachment path')
      const target = path.resolve(dir, relativePath)
      const relative = path.relative(dir, target)
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('attachment path escaped session directory')
      }
      const actual = await realpath(target)
      const actualRelative = path.relative(dir, actual)
      if (!actualRelative || actualRelative === '..' || actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative)) {
        throw new Error('attachment target escaped session directory')
      }
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('attachment target is not a regular file')
      if (typeof contentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(contentId)) throw new Error('invalid content identifier')
      const token = randomUUID()
      entry.references.set(token, { path: actual, contentId })
      return token
  }

  async access(id, token, operation) {
    return this.use(id, async () => {
      const entry = await this.#sessions.get(id)
      const ref = entry.references.get(token)
      if (!ref) throw new Error('attachment is not owned by this session')
      return operation({ ...ref })
    })
  }

  async use(id, operation) {
    if (!isIncognito(id)) throw new Error('invalid incognito session')
    const parent = this.#leases.getStore()
    if (parent?.id === id && parent.live) return this.#run(parent.entry, operation)
    if (this.#closed.has(id)) throw new Error('temporary attachment session is closed')
    let pending = this.#sessions.get(id)
    if (!pending) {
      pending = this.#open(id)
      this.#sessions.set(id, pending)
    }
    const entry = await pending
    // close() may have been called while filesystem setup was still pending.
    if (this.#closed.has(id) || entry.closing) throw new Error('temporary attachment session is closing')
    return this.#run(entry, operation)
  }

  async #run(entry, operation) {
    const lease = { id: entry.id, entry, live: true }
    entry.active++
    try {
      return await this.#leases.run(lease, () => operation(entry.dir, (relativePath, contentId) => this.#register(entry, relativePath, contentId)))
    } finally {
      lease.live = false
      entry.active--
      if (entry.active === 0 && entry.wake) entry.wake()
    }
  }

  async close(id) {
    if (!isIncognito(id)) throw new Error('invalid incognito session')
    this.#closed.add(id)
    const pending = this.#sessions.get(id)
    if (!pending) return false
    const entry = await pending
    if (entry.drained) return entry.drained
    entry.closing = true
    const cleanup = (async () => {
      if (entry.active) await new Promise(resolve => { entry.wake = resolve })
      const info = await lstat(entry.dir)
      const actual = await realpath(entry.dir)
      if (!info.isDirectory() || info.isSymbolicLink() || actual !== entry.dir || path.dirname(actual) !== entry.base) {
        throw new Error('unsafe temporary attachment cleanup target')
      }
      await rm(actual, { recursive: true })
      this.#sessions.delete(id)
      return true
    })()
    entry.drained = cleanup
    try {
      return await cleanup
    } catch (error) {
      if (entry.drained === cleanup) entry.drained = null
      throw error
    }
  }
}
