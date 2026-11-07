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
import { releaseSession } from './release.js'
import { installExperimentalAttachments } from './attachment-runtime.js'
import { waitForSessionJobs } from './attachment-jobs.js'
import { patchSessionLog } from './session-log.js'

export const name = 'dsh-incognito-chat'

export const API_PREFIX = '/api/incognito-chat'

/** @param {any} ctx */
export function apply(ctx) {
  const store = new IncognitoStore()
  const state = {
    persistence: /** @type {'missing'|'ok'|'failed'} */ ('missing'),
    projectionCache: /** @type {'absent'|'ok'|'failed'} */ ('absent'),
    sessionLog: /** @type {'absent'|'ok'|'failed'} */ ('absent'),
    errors: /** @type {string[]} */ ([]),
  }
  const log = (/** @type {string} */ message) => ctx.logger?.info?.(`[incognito-chat] ${message}`)
  const warn = (/** @type {string} */ message) => {
    state.errors.push(message)
    ctx.logger?.warn?.(`[incognito-chat] ${message}`)
  }
  // Fail closed when the attachment routing cannot be installed.
  const attachmentState = installExperimentalAttachments(ctx, warn, log)

  ctx.inject(['deepseekLlmApiExtensions'], (child) => {
    try {
      const restore = patchSessionLog(unwrapService(child.deepseekLlmApiExtensions))
      state.sessionLog = 'ok'
      child.effect(() => () => { restore(); state.sessionLog = 'absent' }, 'incognito-chat.session-log')
    } catch (error) {
      state.sessionLog = 'failed'
      warn(`cannot protect session log: ${String(error)}`)
    }
  })

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
    ready: state.persistence === 'ok' && state.projectionCache !== 'failed' && state.sessionLog !== 'failed' && attachmentState.status === 'ok',
    persistence: state.persistence,
    projectionCache: state.projectionCache,
    sessionLog: state.sessionLog,
    attachments: attachmentState?.status ?? 'unprotected',
    liveSessions: store.size,
    liveIds: [...store.handles.keys()],
    errors: [...state.errors],
  })

  /**
   * 删除一个无痕会话（用户手动点删除时调用）：
   *   1. 停掉它正在跑的回合、后台任务、子 agent
   *   2. 销毁 agent 的 scope —— 官方 agent-loop 会跟着做完整 teardown：
   *      取消回合、关句柄、把 agent 和会话从内存注册表里摘掉
   *   3. 清空草稿本、从工作区记录里移除 id
   *   4. 检查会话是否真的从 DSH 内存里消失了（released），如实返回
   */
  async function discard(/** @type {unknown} */ sessionId) {
    if (!isIncognito(sessionId)) return { discarded: false, reason: 'not-incognito' }
    const id = /** @type {string} */ (sessionId)
    attachmentState?.jobs?.beginClose(id)
    try {
      await ctx.parallel('workspace/session-stop', { sessionId: id })
    } catch (error) {
      warn(`stop ${id} failed: ${String(error)}`)
      if (attachmentState) throw new Error('无法停止会话任务，附件尚未删除')
    }

    if (attachmentState?.pool) await waitForSessionJobs(ctx.get('jobs'), id)
    if (attachmentState?.pool) await attachmentState.jobs.wait(id)

    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    let releasedVia = 'not-found'
    try {
      releasedVia = await releaseSession(ctx.registry ?? ctx.root?.registry, id)
    } catch (error) {
      warn(`release ${id} failed: ${String(error)}`)
    }

    const handle = store.get(id)
    await handle?.close()
    const registry = ctx.get('workspaceRegistry')
    const detached = registry ? await detachIncognito(registry, (x) => x === id) : []
    const released = agents?.get?.(id) === undefined && sessions?.get?.(id) === undefined
    if (!released) {
      warn(`${id} is still held in DSH memory after delete; it will be gone when DSH exits`)
      return { discarded: false, released, releasedVia, detached: detached.length, reason: '会话仍在运行，附件尚未清理；请退出 DSH 后重新启动' }
    }
    if (released && attachmentState?.pool) await attachmentState.pool.close(id)
    return { discarded: true, released, releasedVia, detached: detached.length }
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
