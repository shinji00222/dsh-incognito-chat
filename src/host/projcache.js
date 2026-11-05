// 让官方「投影缓存」跳过无痕会话。
//
// @deepseek-ai/dsh-session-projection-cache 会把每个会话的标题、待办、用量等
// 检查点写进 ~/.dsh/storages/session_projcache/，所有写入都经过 put(id, ...)。
// 这里只拦 put：无痕 id 直接跳过，其他照常。
//
// 注意：这是官方内部方法，不是公开接口。DSH 升级后如果 put 改名或换签名，
// patchProjectionCache 会返回 false，插件据此把无痕开关变灰，不会悄悄落盘。

import { isIncognito } from './ids.js'

const WRAPPED = Symbol.for('dsh-incognito-chat.projcache')

/**
 * @param {any} cache ctx.sessionProjectionCache
 * @returns {(() => void) | false} 成功返回还原函数；接口对不上返回 false
 */
export function patchProjectionCache(cache) {
  if (typeof cache?.put !== 'function' || cache.put.length < 2) return false
  if (cache[WRAPPED]) return false
  const hadOwn = Object.prototype.hasOwnProperty.call(cache, 'put')
  const original = cache.put

  /** @this {any} @param {string} id @param {...any} rest */
  async function put(id, ...rest) {
    if (isIncognito(id)) return
    return original.call(this ?? cache, id, ...rest)
  }

  cache.put = put
  cache[WRAPPED] = true
  if (cache.put !== put) return false

  return () => {
    if (cache.put === put) {
      if (hadOwn) cache.put = original
      else delete cache.put
    }
    delete cache[WRAPPED]
  }
}
