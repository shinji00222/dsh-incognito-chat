import os from 'node:os'
import path from 'node:path'
import { realpath, rmdir } from 'node:fs/promises'
import { openAttachmentProcessRoot, cleanupExitedAttachmentRoots } from './attachment-crash-cleanup.js'
import { AttachmentStorePool } from './attachment-store-pool.js'
import { installAttachmentHooks } from './attachment-hooks.js'
import { unwrapService } from './unwrap.js'
import { trackJobProducers } from './attachment-jobs.js'
import { isIncognito } from './ids.js'

// The caller must treat any missing or failed attachment hook as not ready.
export function installExperimentalAttachments(ctx, warn, log) {
  const state = { status: 'missing', pool: null, jobs: null }
  ctx.inject(['attachments', 'sessionController', 'fileUploads', 'commands', 'llm', 'tools', 'jobs'], async child => {
    let root
    let hooks
    let jobs
    try {
      const base = path.join(await realpath(os.tmpdir()), 'dsh-incognito-chat-attachments-v1')
      root = await openAttachmentProcessRoot(base)
      await cleanupExitedAttachmentRoots(root.base)
      const original = unwrapService(child.attachments)
      if (original.constructor?.name !== 'LocalAttachmentStore' || !original.ctx?.constructor || !original.imageLimits || !original.normalizationPolicy) {
        throw new Error('unsupported attachment backend')
      }
      const limits = original.imageLimits
      const normalization = original.normalizationPolicy
      const pool = new AttachmentStorePool(root.current, dir => new original.constructor(new original.ctx.constructor(), {
        dshHome: dir,
        maxImageBytes: limits.maxImageBytes,
        maxImagesPerMessage: limits.maxImagesPerMessage,
        maxMessageImageBytes: limits.maxMessageImageBytes,
        maxImagePixels: limits.maxImagePixels,
        maxImageDimension: limits.maxImageDimension,
        normalizedImageMaxPixels: normalization.maxPixels,
        normalizedImageMaxDimension: normalization.maxDimension,
        normalizedImageMaxBytes: normalization.maxBytes,
        imageCompressionConcurrency: original.imageCompressionConcurrency,
      }))
      hooks = installAttachmentHooks({
        attachments: original,
        sessionController: unwrapService(child.sessionController),
        fileUploads: unwrapService(child.fileUploads),
        commands: unwrapService(child.commands),
        llm: unwrapService(child.llm),
        tools: unwrapService(child.tools),
        pool,
      })
      jobs = trackJobProducers(unwrapService(child.jobs), isIncognito, () => hooks.context.current())
      state.pool = pool
      state.jobs = jobs
      state.status = 'ok'
      log('experimental attachment routing enabled')
      child.effect(() => async () => {
        state.status = 'missing'
        hooks.restore()
        jobs.restore()
        await pool.closeAll()
        await rmdir(root.current)
        state.pool = null
        state.jobs = null
      }, 'incognito-chat.attachments')
    } catch (error) {
      hooks?.restore()
      jobs?.restore()
      state.status = 'failed'
      if (root) await rmdir(root.current).catch(() => {})
      warn(`experimental attachment routing failed: ${String(error)}`)
    }
  })
  return state
}
