// 「前台」：包住官方的 ctx.sessionPersistence（JSONL 档案员）。
//
// 只拦 create 一个方法：
//   - 无痕 id → 返回内存草稿本，JSONL 完全不知道这个会话存在
//   - 普通 id → 原样交给 JSONL
//
// 为什么只拦 create 就够了：
//   JSONL 的实时写入是 `writers.get(session.id)?.enqueueLive(event)`，
//   它只给自己发出的写句柄写盘。无痕会话从没在 JSONL 拿过句柄，
//   所以后续的消息、工具调用都不会落盘；open / stat / list 也查不到它，
//   于是它天然不在历史列表里，重启后也无法恢复（这正是无痕想要的）。

import { isIncognito } from './ids.js'
import { MemoryHandle } from './memory-handle.js'

export class IncognitoExistsError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`incognito session "${id}" already exists`)
    this.name = 'SessionAlreadyExistsError'
  }
}

/** 进程内所有活着的无痕会话：id → 草稿本。 */
export class IncognitoStore {
  constructor() {
    /** @type {Map<string, MemoryHandle>} */
    this.handles = new Map()
  }

  /** @param {any} header @param {number} [inheritedEventCount] */
  create(header, inheritedEventCount = 0) {
    if (this.handles.has(header.id)) throw new IncognitoExistsError(header.id)
    const handle = new MemoryHandle(header, inheritedEventCount, (closed) => {
      if (this.handles.get(closed.id) === closed) this.handles.delete(closed.id)
    })
    this.handles.set(header.id, handle)
    return handle
  }

  /** @param {string} id */
  get(id) {
    return this.handles.get(id)
  }

  get size() {
    return this.handles.size
  }

  /** 关掉全部草稿本（插件卸载 / 进程退出时） */
  async closeAll() {
    await Promise.allSettled([...this.handles.values()].map((handle) => handle.close()))
  }
}

const WRAPPED = Symbol.for('dsh-incognito-chat.wrapped')

/**
 * 给官方持久化服务装上无痕分流。
 * @param {any} persistence ctx.sessionPersistence
 * @param {IncognitoStore} store
 * @returns {() => void} 还原函数（插件卸载时调用）
 */
export function wrapPersistence(persistence, store) {
  if (persistence[WRAPPED]) throw new Error('sessionPersistence is already wrapped by dsh-incognito-chat')
  const hadOwn = Object.prototype.hasOwnProperty.call(persistence, 'create')
  const original = persistence.create

  /**
   * 用 `this` 而不是 persistence 调原方法：经 cordis 代理调用时 this 是带调用方上下文的影子对象。
   * @this {any} @param {any} header @param {any} [options]
   */
  async function create(header, options) {
    if (isIncognito(header?.parentSession)) {
      throw new Error('无痕对话暂不支持创建子会话，避免子会话留下记录')
    }
    if (!isIncognito(header?.id)) return original.call(this ?? persistence, header, options)
    options?.signal?.throwIfAborted()
    return store.create(header, options?.inheritedEventCount ?? 0)
  }

  persistence.create = create
  persistence[WRAPPED] = true
  // cordis 的服务代理有可能吞掉属性赋值；没生效就当失败，绝不假装装好了
  if (persistence.create !== create) {
    delete persistence[WRAPPED]
    throw new Error('assignment to sessionPersistence.create did not take effect')
  }

  return () => {
    if (persistence.create === create) {
      if (hadOwn) persistence.create = original
      else delete persistence.create
    }
    delete persistence[WRAPPED]
  }
}

/**
 * 检查包装是否真的生效（cordis 的服务代理有可能拦住属性赋值）。
 * @param {any} persistence
 */
export function isWrapped(persistence) {
  return persistence?.[WRAPPED] === true
}
