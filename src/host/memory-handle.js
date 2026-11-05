// 内存版 SessionHandle（「草稿本」）。
//
// 官方 agent-loop 每开一个会话，都会向 ctx.sessionPersistence 要一个写句柄，
// 之后靠句柄 read / append / flush / close。只要我们实现同样的方法，
// agent-loop 分不出拿到的是 JSONL 的真本子还是这个草稿本。
//
// 契约来自 @deepseek-ai/dsh-session-persistence 的 SessionHandle：
//   - read(offset, length)：offset 是起始 seq（会话事件 seq 从 0 连续递增）
//   - append(events)：第一条的 seq 必须等于当前末尾的下一个 seq
//   - flush()：持久化屏障。内存里没有「持久」，直接成功
//   - close()：幂等；关闭后的任何操作都要报错

export class HandleClosedError extends Error {
  /** @param {string} id @param {string} operation */
  constructor(id, operation) {
    super(`incognito session "${id}": cannot ${operation} a closed handle`)
    this.name = 'SessionHandleClosedError'
  }
}

export class NonContiguousAppendError extends Error {
  /** @param {string} id @param {number} expected @param {number} actual */
  constructor(id, expected, actual) {
    super(`incognito session "${id}": append must start at seq ${expected}, got ${actual}`)
    this.name = 'NonContiguousAppendError'
  }
}

export class MemoryHandle {
  /**
   * @param {{ id: string }} header 会话 header（官方 SessionHeader）
   * @param {number} [inheritedEventCount] fork 继承的前缀长度，普通会话为 0
   * @param {(handle: MemoryHandle) => void} [onClose] 关闭时通知仓库
   */
  constructor(header, inheritedEventCount = 0, onClose = () => {}) {
    this.id = header.id
    this.header = header
    this.inheritedEventCount = inheritedEventCount
    this.access = 'write'
    /** @type {any[]} */
    this.events = []
    this.closed = false
    this.onClose = onClose
  }

  /** 下一个应该追加的 seq */
  get nextSeq() {
    return this.events.length
  }

  /** @param {number} [offset] @param {number} [length] */
  async read(offset = 0, length) {
    this.assertOpen('read')
    const end = length === undefined ? undefined : offset + length
    return { eventState: 'detached', events: this.events.slice(offset, end) }
  }

  /** @param {readonly any[]} events */
  async append(events) {
    this.assertOpen('append')
    if (events.length === 0) return
    if (events[0].seq !== this.nextSeq) {
      throw new NonContiguousAppendError(this.id, this.nextSeq, events[0].seq)
    }
    this.events.push(...events)
  }

  /**
   * 会话发布以后，实时事件不经过 append，而是由后端监听 `session/event` 收进来。
   * 这里只收「正好接在末尾」的事件：重复的丢掉，跳号的也丢掉（不让日志出现空洞）。
   * @param {any} event
   * @returns {boolean} 是否收下
   */
  receiveLive(event) {
    if (this.closed || event?.seq !== this.nextSeq) return false
    this.events.push(event)
    return true
  }

  async flush() {
    this.assertOpen('flush')
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.events = []
    this.onClose(this)
  }

  async [Symbol.asyncDispose]() {
    await this.close()
  }

  /** @param {string} operation */
  assertOpen(operation) {
    if (this.closed) throw new HandleClosedError(this.id, operation)
  }
}
