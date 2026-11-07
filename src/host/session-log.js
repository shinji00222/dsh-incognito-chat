import { isIncognito } from './ids.js'

// Wrap the field provider itself, so its acceptance callback is never created
// for an incognito request. Other fields and ordinary requests are untouched.
export function patchSessionLog(registry) {
  if (!(registry?.providers instanceof Map) || typeof registry.register !== 'function' || typeof registry.prepare !== 'function') {
    throw new Error('unsupported DeepSeek extension registry')
  }
  const providers = registry.providers
  const originalRegister = registry.register
  const hadOwn = Object.hasOwn(registry, 'register')
  const wrappers = new WeakMap()
  const originals = new WeakMap()
  function protect(provider) {
    if (!provider || typeof provider.prepare !== 'function') throw new Error('unsupported session log provider')
    if (wrappers.has(provider)) return wrappers.get(provider)
    const wrapped = Object.create(provider)
    wrapped.prepare = function (request) {
      if (isIncognito(request?.sessionId)) return undefined
      return provider.prepare.call(provider, request)
    }
    wrappers.set(provider, wrapped)
    originals.set(wrapped, provider)
    return wrapped
  }
  const existing = providers.get('dsh_session_log')
  const guarded = existing === undefined ? undefined : protect(existing)
  function register(field, provider) {
    return originalRegister.call(this, field, field === 'dsh_session_log' ? protect(provider) : provider)
  }
  registry.register = register
  if (registry.register !== register) throw new Error('cannot protect DeepSeek extension registry')
  if (guarded) providers.set('dsh_session_log', guarded)
  return () => {
    if (registry.register === register) {
      if (hadOwn) registry.register = originalRegister
      else delete registry.register
    }
    const current = providers.get('dsh_session_log')
    if (current && originals.has(current)) providers.set('dsh_session_log', originals.get(current))
  }
}
