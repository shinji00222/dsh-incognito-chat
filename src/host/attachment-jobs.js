// DSH's session-stop requests cancellation but does not wait for jobs to
// settle. Keep attachments until the registry confirms all owned jobs ended.
export async function waitForSessionJobs(jobs, sessionId, timeoutMs = 30000) {
  if (typeof jobs?.list !== 'function' || typeof jobs.wait !== 'function') throw new Error('无法确认后台任务状态，附件尚未删除')
  const deadline = Date.now() + timeoutMs
  while (true) {
    const active = jobs.list(sessionId).filter(job => job.owner === sessionId && (job.status === 'running' || job.status === 'stopping'))
    if (!active.length) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('后台任务尚未结束，附件尚未删除')
    await Promise.all(active.map(job => jobs.wait(job.id, remaining, sessionId)))
  }
}

// Registry status can be forced to terminal before the producer's done promise
// settles. Track that original promise independently of the registry record.
export function trackJobProducers(jobs, isPrivate, currentOwner = () => null) {
  const original = jobs?.start
  if (typeof original !== 'function') throw new Error('missing background job start lifecycle')
  const sessions = new Map()
  const closing = new Set()
  function wrapped(spec) {
    const id = spec?.owner
    const current = currentOwner()
    if (current?.incognito && id !== current.sessionId) throw new Error('无法确认无痕后台任务的对话归属')
    if (!isPrivate(id)) return original.call(this, spec)
    if (closing.has(id)) throw new Error('无痕对话正在关闭，不能启动后台任务')
    if (typeof spec.run !== 'function') throw new Error('missing background job producer')
    const run = spec.run
    return original.call(this, { ...spec, run(handle) {
      let pending = sessions.get(id)
      if (!pending) sessions.set(id, pending = new Set())
      // The starter may launch work before throwing or returning invalid hooks.
      // In either case its termination is unknown, so keep cleanup blocked.
      const entry = { done: null, failed: true }
      pending.add(entry)
      const hooks = run.call(this, handle)
      if (!hooks?.done || typeof hooks.done.then !== 'function') throw new Error('missing background job completion promise')
      entry.failed = false
      entry.done = Promise.resolve(hooks.done).then(() => { pending.delete(entry) }, () => { entry.failed = true })
      return hooks
    } })
  }
  jobs.start = wrapped
  if (jobs.start !== wrapped) throw new Error('could not wrap background job lifecycle')
  return {
    beginClose(id) { closing.add(id) },
    async wait(id, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs
      while (sessions.get(id)?.size) {
        const pending = [...sessions.get(id)]
        if (pending.some(entry => entry.failed)) throw new Error('后台任务结束状态无法确认，附件尚未删除')
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('后台任务尚未结束，附件尚未删除')
        let timer
        try {
          await Promise.race([
            Promise.all(pending.map(entry => entry.done)),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('后台任务尚未结束，附件尚未删除')), remaining) }),
          ])
        } finally { clearTimeout(timer) }
      }
      sessions.delete(id)
    },
    restore() { if (jobs.start === wrapped) jobs.start = original },
  }
}
