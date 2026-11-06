import { AttachmentContext } from './attachment-context.js'
import { patchAttachmentStore } from './attachment-router.js'
import { isIncognito } from './ids.js'

export function patchToolDispatch(tools, context, pool) {
  const original = tools?.dispatchScheduledExecution
  if (typeof original !== 'function') throw new Error('missing tool dispatch lifecycle')
  async function wrapped(exec) {
    const id = exec?.agent?.session?.id
    if (typeof id !== 'string' || !id) throw new Error('tool session is missing')
    if (!isIncognito(id)) return original.call(this, exec)
    return pool.withToolExecution(id, () => context.run(id, () => original.call(this, exec)))
  }
  tools.dispatchScheduledExecution = wrapped
  if (tools.dispatchScheduledExecution !== wrapped) throw new Error('could not wrap tool dispatch lifecycle')
  return () => { if (tools.dispatchScheduledExecution === wrapped) tools.dispatchScheduledExecution = original }
}

// Patch as one transaction: partial routing must never be treated as ready.
export function installAttachmentHooks({ attachments, sessionController, fileUploads, commands, llm, tools, pool }) {
  const context = new AttachmentContext()
  const undo = []
  try {
    undo.push(patchAttachmentStore(attachments, context, pool))
    for (const method of ['prompt', 'attachment', 'updateQueue']) {
      undo.push(context.wrap(sessionController, method, request => request?.sessionId))
    }
    undo.push(context.wrap(fileUploads, 'upload', agent => agent?.session?.id))
    undo.push(context.wrap(fileUploads, 'uploadStream', request => request?.sessionId))
    undo.push(context.wrap(commands, 'execute', agent => agent?.session?.id))
    undo.push(context.wrap(llm, 'stream', options => options?.sessionId))
    undo.push(context.wrapPreparedCalls(llm))
    undo.push(patchToolDispatch(tools, context, pool))
  } catch (error) {
    for (const restore of undo.reverse()) restore()
    throw error
  }
  return { context, restore() { for (const restore of undo.reverse()) restore() } }
}
