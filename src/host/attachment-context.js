import { AsyncLocalStorage } from 'node:async_hooks'
import { isIncognito } from './ids.js'

// Caller ownership must be established before any attachment service can
// choose a temporary directory.
export class AttachmentContext {
  #context = new AsyncLocalStorage()

  current() { return this.#context.getStore() }

  run(sessionId, operation) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('attachment session is missing')
    return this.#context.run({ sessionId, incognito: isIncognito(sessionId) }, operation)
  }

  // Creating an async generator does not execute its body. Each iterator
  // operation, including cancellation, must run under the owning session.
  bindIterable(sessionId, result) {
    if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result
    const context = this
    return {
      [Symbol.asyncIterator]() {
        const iterator = context.run(sessionId, () => result[Symbol.asyncIterator]())
        const bound = { next: (...values) => context.run(sessionId, () => iterator.next(...values)) }
        if (typeof iterator.return === 'function') bound.return = (...values) => context.run(sessionId, () => iterator.return(...values))
        if (typeof iterator.throw === 'function') bound.throw = (...values) => context.run(sessionId, () => iterator.throw(...values))
        bound[Symbol.asyncIterator] = () => bound
        return bound
      },
    }
  }

  wrap(target, method, sessionIdOf) {
    const original = target?.[method]
    if (typeof original !== 'function') throw new Error(`missing attachment entry point: ${method}`)
    const context = this
    function wrapped(...args) {
      const sessionId = sessionIdOf(...args)
      const result = context.run(sessionId, () => original.apply(this, args))
      // Async generators execute on next(), not when they are constructed.
      // Re-enter the captured context for every iterator operation.
      return context.bindIterable(sessionId, result)
    }
    target[method] = wrapped
    if (target[method] !== wrapped) throw new Error(`could not wrap attachment entry point: ${method}`)
    return () => { if (target[method] === wrapped) target[method] = original }
  }

  // DSH prepareCall returns a frozen, one-shot object whose stream() receives
  // the actual sessionId only later. The driver may already be running under
  // another async context, so rebind on dispatch and on every iterator step.
  wrapPreparedCalls(target) {
    const original = target?.prepareCall
    if (typeof original !== 'function') throw new Error('missing attachment entry point: prepareCall')
    const context = this
    async function wrapped(...args) {
      const prepared = await original.apply(this, args)
      if (!prepared || typeof prepared.stream !== 'function') throw new Error('invalid prepared model call')
      return Object.freeze({
        ...prepared,
        stream(options) {
          const id = options?.sessionId
          const result = context.run(id, () => prepared.stream(options))
          return context.bindIterable(id, result)
        },
      })
    }
    target.prepareCall = wrapped
    if (target.prepareCall !== wrapped) throw new Error('could not wrap attachment entry point: prepareCall')
    return () => { if (target.prepareCall === wrapped) target.prepareCall = original }
  }
}
