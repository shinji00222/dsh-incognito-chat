// M11 探针：在隔离 DSH 里用真实 Agent/Subagent 服务验证无痕父会话的子 Agent 限制。
//
// 创建两个真实 host Agent（普通 session-<uuid>、无痕 session-incognito-<uuid>），然后：
//   1. 无痕父会话调用 subagents.startActivation（真实工具使用的同一入口），记录拒绝和会话文件数
//   2. 直接调用 sessionPersistence.create 带无痕 parentSession，验证第二层持久化保护
//   3. 普通父会话调用同一 startActivation，确认能通过保护并创建子会话
// 全部输入来自环境变量；只用合成内容。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { snapshotSessionFiles, observeSessionChanges } from './snapshot.js'

export const name = 'subagent-guard-probe'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function listSessionFiles(root) {
  const files = []
  const walk = (dir, prefix) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file, relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  walk(root, '')
  return files.sort()
}

export function apply(ctx) {
  const dir = process.env.M11_RUN_DIR
  const normalId = process.env.M11_NORMAL_ID
  const incognitoId = process.env.M11_INCOGNITO_ID
  const cwd = process.env.M11_WORKSPACE
  const sessionsRoot = path.join(process.env.DSH_HOME, 'sessions')
  const note = (label, value) => {
    try {
      fs.appendFileSync(path.join(dir, 'probe.log'), `${new Date().toISOString()} ${label} ${JSON.stringify(value)}\n`)
    } catch {}
  }
  const done = (result) => fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify(result, null, 2))
  const fail = (error) => {
    ctx.logger?.warn?.(`[m11-probe] ${String(error?.stack ?? error)}`)
    try { done({ ok: false, error: String(error?.stack ?? error) }) } catch {}
  }

  ctx.inject(['agents', 'subagents', 'sessions'], (child) => {
    child.effect(() => {
      void (async () => {
        try {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            if (child.get('subagents')?.getProvider?.('spawn')) break
            await sleep(100)
          }
          const agents = child.get('agents')
          const subagents = child.get('subagents')
          const persistence = child.get('sessionPersistence') ?? ctx.get('sessionPersistence')
          const externalName = 'm11-external-probe'
          const externalReached = 'M11_EXTERNAL_START_REACHED'
          let externalStarts = 0
          // A provider without prepareContinuable takes DSH's external branch.
          // Stop at the provider boundary before executing any external command.
          subagents.registerProvider({
            name: externalName,
            capabilities: {},
            start() {
              externalStarts++
              throw new Error(externalReached)
            },
          })
          const probeExternalStart = async parent => {
            try {
              await subagents.startActivation({
                provider: externalName,
                label: 'M11 synthetic external child',
                request: { parent, cwd, prompt: [{ type: 'text', text: 'M11-SYNTHETIC-EXTERNAL-CHILD' }] },
                signal: new AbortController().signal,
                delivery: 'caller',
              })
              return null
            } catch (error) {
              return String(error?.message ?? error)
            }
          }
          const create = async (sessionId) => {
            for (let attempt = 0; attempt < 40; attempt += 1) {
              try {
                return await agents.create({
                  sessionId,
                  meta: { cwd },
                  agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
                })
              } catch {
                await sleep(250)
              }
            }
            throw new Error(`could not create agent ${sessionId}`)
          }

          const incognito = await create(incognitoId)
          await sleep(300)

          const before = listSessionFiles(sessionsRoot)
          const beforeSnapshot = snapshotSessionFiles(sessionsRoot)
          let incognitoRejected = false
          let incognitoError = null
          try {
            await subagents.startActivation({
              provider: 'spawn',
              label: 'M11 synthetic incognito child',
              request: {
                prompt: [{ type: 'text', text: 'M11-SYNTHETIC-INCOGNITO-CHILD' }],
                parent: incognito.agent,
                maxDepth: 1,
              },
              signal: new AbortController().signal,
              delivery: 'parent',
            })
          } catch (error) {
            incognitoError = String(error?.message ?? error)
            incognitoRejected = incognitoError.includes('无痕对话暂不支持启动子 agent')
          }
          const incognitoExternalError = await probeExternalStart(incognito.agent)
          const incognitoExternalStarts = externalStarts
          const incognitoFileChanges = await observeSessionChanges(sessionsRoot, beforeSnapshot)
          const afterIncognito = listSessionFiles(sessionsRoot)
          const incognitoUnexpectedSessionFiles = afterIncognito
            .filter(file => !before.includes(file))

          const persistenceSnapshot = snapshotSessionFiles(sessionsRoot)
          let persistenceRejected = false
          let persistenceError = null
          try {
            await persistence.create({
              id: `session-${randomUUID()}`,
              parentSession: incognitoId,
              version: 4,
              createdAt: Date.now(),
            }, {})
          } catch (error) {
            persistenceError = String(error?.message ?? error)
            persistenceRejected = persistenceError.includes('无痕对话暂不支持创建子会话')
          }
          const persistenceFileChanges = await observeSessionChanges(sessionsRoot, persistenceSnapshot)
          const afterPersistence = listSessionFiles(sessionsRoot)
          const persistenceUnexpectedSessionFiles = afterPersistence
            .filter(file => !afterIncognito.includes(file))

          const normal = await create(normalId)
          let normalChildId = null
          let normalError = null
          let normalLive = false
          let normalParentSession = null
          let normalPersisted = null
          try {
            const started = await subagents.startActivation({
              provider: 'spawn',
              label: 'M11 synthetic normal child',
              request: {
                prompt: [{ type: 'text', text: 'M11-SYNTHETIC-NORMAL-CHILD' }],
                parent: normal.agent,
                maxDepth: 1,
              },
              signal: new AbortController().signal,
              delivery: 'parent',
            })
            normalChildId = started.childId
            await sleep(500)
            const live = child.get('sessions')?.get?.(normalChildId)
            normalLive = live !== undefined
            const stored = typeof persistence?.stat === 'function'
              ? await persistence.stat(normalChildId).then(value => value ?? null, () => null)
              : null
            normalPersisted = stored !== null
            normalParentSession = stored?.header?.parentSession ?? live?.header?.parentSession ?? null
            // Do not await teardown: the isolated process is killed after the
            // probe writes its result. Awaiting it here could wait for a turn.
            void started.dispose?.().catch?.(() => {})
          } catch (error) {
            normalError = String(error?.message ?? error)
          }
          await sleep(300)
          const afterNormal = listSessionFiles(sessionsRoot)
          const normalChildSessionFiles = normalChildId === null
            ? []
            : afterNormal.filter(file => !afterPersistence.includes(file) && file.includes(normalChildId))
          const normalExternalError = await probeExternalStart(normal.agent)

          const result = {
            ok: true,
            normalId,
            incognitoId,
            incognitoRejected,
            incognitoError,
            sessionFilesBefore: before.length,
            sessionFilesAfterIncognito: afterIncognito.length,
            incognitoNewSessionFiles: afterIncognito.filter(file => !before.includes(file)),
            incognitoUnexpectedSessionFiles,
            incognitoFileChanges,
            incognitoExternalError,
            incognitoExternalStarts,
            normalExternalError,
            normalExternalStarts: externalStarts - incognitoExternalStarts,
            persistenceRejected,
            persistenceError,
            sessionFilesAfterPersistence: afterPersistence.length,
            persistenceUnexpectedSessionFiles,
            persistenceFileChanges,
            normalChildId,
            normalError,
            normalLive,
            normalParentSession,
            normalPersisted,
            sessionFilesAfterNormal: afterNormal.length,
            normalChildSessionFiles,
          }
          note('result', result)
          done(result)
        } catch (error) {
          fail(error)
        }
      })()
    }, 'm11-probe.run')
  })
}
