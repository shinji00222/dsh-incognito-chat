import path from 'node:path'
import { TemporaryAttachments } from './temporary-attachments.js'

// Per-session DSH-compatible attachment stores.
export class AttachmentStorePool {
  #temporary
  #createStore
  #stores = new Map()
  #resolvedStores = new Map()
  #references = new Map()
  #closing = new Set()

  constructor(base, createStore) {
    if (typeof createStore !== 'function') throw new Error('attachment store factory is required')
    this.#temporary = new TemporaryAttachments(base)
    this.#createStore = createStore
  }

  // A tool may receive a host path and read it without calling the attachment
  // service again. Keep the directory alive for the whole dispatched body.
  withToolExecution(id, operation) {
    return this.#temporary.use(id, () => operation())
  }

  async #use(id, operation) {
    return this.#temporary.use(id, async (dir, register) => {
      let pending = this.#stores.get(id)
      if (!pending) {
        pending = Promise.resolve().then(() => this.#createStore(dir))
        this.#stores.set(id, pending)
      }
      const store = await pending
      this.#resolvedStores.set(id, store)
      return operation(store, dir, register)
    })
  }

  async #register(id, dir, store, kind, ref, register) {
    const file = kind === 'image' ? store.imageHostPath(ref) : store.fileHostPath(ref)
    if (typeof file !== 'string') throw new Error('attachment store is not host-file-backed')
    const token = await register(path.relative(dir, file), String(ref.attachmentId))
    let refs = this.#references.get(id)
    if (!refs) this.#references.set(id, refs = new Map())
    refs.set(`${kind}:${String(ref.attachmentId)}`, { token, path: path.resolve(file) })
    return { token, ref }
  }

  async saveImage(id, input) {
    return this.#use(id, async (store, dir, register) => {
      const ref = await store.saveImage(input)
      return this.#register(id, dir, store, 'image', ref, register)
    })
  }

  async saveImages(id, inputs) {
    return this.#use(id, async (store, dir, register) => {
      const refs = await store.saveImages(inputs)
      const result = []
      for (const ref of refs) result.push(await this.#register(id, dir, store, 'image', ref, register))
      return result
    })
  }

  async saveFile(id, input) {
    return this.#use(id, async (store, dir, register) => {
      const ref = await store.saveFile(input)
      return this.#register(id, dir, store, 'file', ref, register)
    })
  }

  async saveFileStream(id, input) {
    return this.#use(id, async (store, dir, register) => {
      const ref = await store.saveFileStream(input)
      return this.#register(id, dir, store, 'file', ref, register)
    })
  }

  reference(id, kind, ref) {
    if (kind !== 'image' && kind !== 'file') throw new Error('invalid attachment kind')
    if (this.#closing.has(id) && !this.#temporary.hasLease(id)) throw new Error('temporary attachment session is closing')
    const entry = this.#references.get(id)?.get(`${kind}:${String(ref?.attachmentId)}`)
    if (!entry || !this.#resolvedStores.has(id)) throw new Error('attachment is not owned by this session')
    return { ...entry }
  }

  async readImage(id, token, ref, signal) {
    return this.#temporary.access(id, token, async owner => {
      if (owner.contentId !== String(ref?.attachmentId)) throw new Error('attachment content identifier mismatch')
      const store = await this.#stores.get(id)
      if (!store || path.resolve(store.imageHostPath(ref)) !== owner.path) throw new Error('attachment location mismatch')
      return store.readImage(ref, signal)
    })
  }

  async readImageRequest(id, token, ref, target, signal) {
    return this.#temporary.access(id, token, async owner => {
      if (owner.contentId !== String(ref?.attachmentId)) throw new Error('attachment content identifier mismatch')
      const store = await this.#stores.get(id)
      if (!store || path.resolve(store.imageHostPath(ref)) !== owner.path) throw new Error('attachment location mismatch')
      return store.readImageRequest(ref, target, signal)
    })
  }

  // The caller consumes the stream inside the lease, so closing the session
  // waits for the complete read rather than just stream construction.
  async withFileStream(id, token, ref, consume, signal) {
    if (typeof consume !== 'function') throw new Error('file stream consumer is required')
    return this.#temporary.access(id, token, async owner => {
      if (owner.contentId !== String(ref?.attachmentId)) throw new Error('attachment content identifier mismatch')
      const store = await this.#stores.get(id)
      if (!store || path.resolve(store.fileHostPath(ref)) !== owner.path) throw new Error('attachment location mismatch')
      return consume(store.readFileStream(ref, signal))
    })
  }

  // Keep the lease until the consumer has finished, failed or cancelled the
  // iterator. Merely returning an iterator from use() would release it early.
  async *readFileStream(id, token, ref, signal) {
    let release
    let readyResolve
    let readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const finished = new Promise(resolve => { release = resolve })
    const lease = this.withFileStream(id, token, ref, async stream => {
      const iterator = stream[Symbol.asyncIterator]()
      readyResolve(iterator)
      try { await finished } finally { await iterator.return?.() }
    }, signal)
    lease.catch(readyReject)
    try {
      const iterator = await ready
      while (true) {
        const value = await iterator.next()
        if (value.done) return
        yield value.value
      }
    } finally {
      release()
      await lease
    }
  }

  async close(id) {
    this.#closing.add(id)
    const result = await this.#temporary.close(id)
    this.#stores.delete(id)
    this.#resolvedStores.delete(id)
    this.#references.delete(id)
    return result
  }

  async closeAll() {
    const results = await Promise.allSettled(this.#temporary.sessionIds().map(id => this.close(id)))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'temporary attachment cleanup failed')
  }
}
