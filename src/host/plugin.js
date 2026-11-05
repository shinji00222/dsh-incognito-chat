// dsh-incognito-chat host 入口。
//
// 装三样东西：
//   1. 持久化分流（persistence.js）：无痕会话只进内存
//   2. 投影缓存跳过（projcache.js）：不在 storages/ 里留标题等检查点
//   3. RPC（/api/incognito-chat/*）：前端查状态、丢弃无痕会话
//
// 任何一层没装上，status 就报 ready=false，前端把无痕开关变灰。
// 宁可不能用，也不让用户以为是无痕、其实写了盘。

import { isIncognito } from './ids.js'
import { IncognitoStore, isWrapped, wrapPersistence } from './persistence.js'
import { patchProjectionCache } from './projcache.js'
import { unwrapService } from './unwrap.js'
import { detachIncognito } from './workspace.js'

export const name = 'dsh-incognito-chat'

export const API_PREFIX = '/api/incognito-chat'

/** @param {any} ctx */
export function apply(ctx) {
  const store = new IncognitoStore()
  const state = {
    persistence: /** @type {'missing'|'ok'|'failed'} */ ('missing'),
    projectionCache: /** @type {'absent'|'ok'|'failed'} */ ('absent'),
    errors: /** @type {string[]} */ ([]),
  }
  const log = (/** @type {string} */ message) => ctx.logger?.info?.(`[incognito-chat] ${message}`)
  const warn = (/** @type {string} */ message) => {
    state.errors.push(message)
    ctx.logger?.warn?.(`[incognito-chat] ${message}`)
  }

  // ── 1. 持久化分流 ─────────────────────────────────────────────────────
  ctx.inject(['sessionPersistence'], (/** @type {any} */ child) => {
    const persistence = unwrapService(child.sessionPersistence)
    try {
      const restore = wrapPersistence(persistence, store)
      if (!isWrapped(persistence)) {
        restore()
        throw new Error('wrap marker missing after wrapPersistence')
      }
      state.persistence = 'ok'
      log('session persistence wrapped')
      child.effect(() => () => {
        restore()
        state.persistence = 'missing'
      }, 'incognito-chat.persistence')
    } catch (error) {
      state.persistence = 'failed'
      warn(`cannot wrap session persistence: ${String(error)}`)
    }
  })

  // ── 2. 投影缓存跳过（没挂这个服务就不需要拦）────────────────────────
  ctx.inject(['sessionProjectionCache'], (/** @type {any} */ child) => {
    const restore = patchProjectionCache(unwrapService(child.sessionProjectionCache))
    if (restore === false) {
      state.projectionCache = 'failed'
      warn('sessionProjectionCache.put not found; this DSH version is not supported')
      return
    }
    state.projectionCache = 'ok'
    log('projection cache patched')
    child.effect(() => () => {
      restore()
      state.projectionCache = 'absent'
    }, 'incognito-chat.projcache')
  })

  // ── 实时事件收进草稿本；会话销毁时关掉草稿本 ───────────────────────
  ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    store.get(session?.id)?.receiveLive(event)
  })
  ctx.on('session/disposed', (/** @type {any} */ session) => {
    store.get(session?.id)?.close()
  })

  const status = () => ({
    ready: state.persistence === 'ok' && state.projectionCache !== 'failed',
    persistence: state.persistence,
    projectionCache: state.projectionCache,
    liveSessions: store.size,
    liveIds: [...store.handles.keys()],
    errors: [...state.errors],
  })

  /** 丢弃一个无痕会话：停掉它正在跑的回合、后台任务、子 agent，清空草稿本。 */
  async function discard(/** @type {unknown} */ sessionId) {
    if (!isIncognito(sessionId)) return { discarded: false, reason: 'not-incognito' }
    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      warn(`stop ${String(sessionId)} failed: ${String(error)}`)
    }
    const handle = store.get(/** @type {string} */ (sessionId))
    await handle?.close()
    const registry = ctx.get('workspaceRegistry')
    const detached = registry ? await detachIncognito(registry, (id) => id === sessionId) : []
    return { discarded: handle !== undefined, detached: detached.length }
  }

  // ── 4. 启动时清掉工作区里残留的无痕 id（DSH 崩溃、强退后留下的）────
  ctx.inject(['workspaceRegistry'], async (/** @type {any} */ child) => {
    try {
      const removed = await detachIncognito(child.workspaceRegistry, (id) => store.get(id) === undefined)
      if (removed.length > 0) log(`removed ${removed.length} stale incognito id(s) from workspaces`)
    } catch (error) {
      warn(`workspace cleanup failed: ${String(error)}`)
    }
  })

  // ── 3. HTTP 接口：POST /api/incognito-chat/status、/api/incognito-chat/discard ──
  // 用官方的 connection.fetch.register（精确路由，自带登录校验，只允许本人访问）。
  // 踩过的坑：
  //   - rpc.intercept('/api')：0.2.x 里 /api 只允许一个拦截器，已被官方网关占用；
  //     抢先注册会让网关失败，整个 DSH 接口全部 404（dsh-incognito 就是这么写的）。
  //   - rpc.handle(自定义通道)：官方没人用，实测路由挂不上，请求落到静态页返回 405。
  ctx.inject(['connection'], (/** @type {any} */ child) => {
    /** @param {(body: any) => Promise<any> | any} run */
    const route = (run) => async (/** @type {Request} */ request) => {
      try {
        const body = await request.json().catch(() => ({}))
        return Response.json({ ok: true, value: await run(body) }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 })
      }
    }
    child.connection.fetch.register({
      path: `${API_PREFIX}/status`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(() => status()),
    })
    child.connection.fetch.register({
      path: `${API_PREFIX}/discard`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route((body) => discard(body?.sessionId)),
    })
  })

  ctx.effect(() => () => {
    store.closeAll()
  }, 'incognito-chat.store')
}
