// M11（模型工具入口）探针：在隔离 DSH 内，用真实模型工具调用链触发 `subagent` 工具。
//
// 做三件事：
//   1. 用 `agents.create` + 标准 preset 创建真实会话（无痕 id / 普通 id 各一个），
//      与 API Session Controller 的创建方式一致（meta.agentPreset + setup 挂载 preset）。
//   2. 发一条合成用户消息；本地模拟模型返回真正的 `subagent` 工具调用（tool_use）。
//      工具执行、参数校验、拒绝/成功都发生在 DSH 自己的工具链里，探针不直接调用
//      `subagents.startActivation`。
//   3. 记录会话事件里的 assistant/message、tool/call、tool/result，以及无痕阶段
//      sessions 目录快照；普通对照还记录子会话 id、持久化 header 和新增会话文件。
//
// 全部输入来自环境变量；只用合成内容。本探针只负责取证，判定在
// scripts/verify-subagent-tool-call.mjs。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { snapshotSessionFiles, observeSessionChanges } from './snapshot.js'

export const name = 'subagent-tool-call-probe'

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
  const normalMarker = process.env.M11_NORMAL_MARKER
  const incognitoMarker = process.env.M11_INCOGNITO_MARKER
  const normalCallId = process.env.M11_NORMAL_CALL_ID
  const incognitoCallId = process.env.M11_INCOGNITO_CALL_ID
  const normalChildPrompt = process.env.M11_NORMAL_CHILD_PROMPT
  const incognitoChildPrompt = process.env.M11_INCOGNITO_CHILD_PROMPT
  const cwd = process.env.M11_WORKSPACE
  const provider = process.env.M11_AGENT_PROVIDER ?? 'deepseek-official'
  const model = process.env.M11_AGENT_MODEL ?? 'deepseek-flash'
  const sessionsRoot = path.join(process.env.DSH_HOME, 'sessions')

  const note = (label, value) => {
    try {
      const line = typeof value === 'string' ? value : JSON.stringify(value)
      fs.appendFileSync(path.join(dir, 'probe.log'), `${new Date().toISOString()} ${label} ${line}\n`)
    } catch {}
  }
  const done = (result) => fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify(result, null, 2))
  const fail = (error) => {
    ctx.logger?.warn?.(`[m11-tool-probe] ${String(error?.stack ?? error)}`)
    try { done({ ok: false, error: String(error?.stack ?? error) }) } catch {}
  }

  const tracked = new Set([normalId, incognitoId])
  /** @type {{sessionId: string, type: string, data: any}[]} */
  const events = []
  /** @type {Map<string, Set<(event: any) => void>>} */
  const waiters = new Map()

  const waitFor = (sessionId, predicate, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.get(sessionId)?.delete(check)
      reject(new Error(`timed out waiting for event on ${sessionId}`))
    }, timeoutMs)
    const check = (event) => {
      let matched = false
      try { matched = predicate(event) === true } catch { matched = false }
      if (!matched) return
      clearTimeout(timer)
      waiters.get(sessionId)?.delete(check)
      resolve(event)
    }
    if (!waiters.has(sessionId)) waiters.set(sessionId, new Set())
    waiters.get(sessionId).add(check)
  })

  ctx.on('session/event', (session, event) => {
    if (session?.id === undefined || !tracked.has(session.id)) return
    const record = { sessionId: session.id, type: event?.type, data: event?.data }
    events.push(record)
    for (const waiter of [...(waiters.get(session.id) ?? [])]) waiter(record)
  })

  ctx.inject(['agents', 'agentPresets', 'subagents', 'tools', 'sessionPersistence'], (child) => {
    child.effect(() => {
      void (async () => {
        try {
          const agents = child.get('agents')
          const presets = child.get('agentPresets')
          const subagents = child.get('subagents')
          const tools = child.get('tools')
          const persistence = child.get('sessionPersistence')
          for (let attempt = 0; attempt < 120; attempt += 1) {
            if (subagents?.getProvider?.('spawn') !== undefined && presets !== undefined && typeof agents?.create === 'function' && tools?.get !== undefined) break
            await sleep(100)
          }
          if (typeof agents?.create !== 'function') throw new Error('agents.create unavailable')
          if (presets === undefined) throw new Error('agentPresets service unavailable')
          if (subagents?.getProvider?.('spawn') === undefined) throw new Error('spawn subagent provider unavailable')
          if (typeof tools?.get !== 'function') throw new Error('tools.get unavailable')

          const rawSubagents = subagents?.[Symbol.for('cordis.original')] ?? subagents
          const startActivationSource = String(rawSubagents?.startActivation ?? '')
          const guardInstalled = startActivationSource.includes('无痕对话暂不支持启动子 agent')
          note('guardInstalled', { guardInstalled })

          const preset = await presets.resolve(undefined)
          note('preset', preset)
          if (preset?.broken !== undefined) throw new Error(`default agent preset is broken: ${preset.broken}`)

          const createAgent = async (sessionId) => agents.create({
            sessionId,
            agentOptions: { provider, model },
            meta: { cwd, agentPreset: preset.id },
            setup: async (agentCtx) => {
              await presets.mount(agentCtx, preset.id)
            },
          })

          const waitToolVisible = async (handle) => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (tools.get('subagent', handle.agent) !== undefined) return true
              await sleep(100)
            }
            return false
          }
          const visibleToolNames = (handle) => {
            try {
              return tools.schemas(handle.agent).map((schema) => schema.name).sort()
            } catch (error) {
              note('schemas.failed', String(error?.message ?? error))
              return []
            }
          }
          const followup = (handle, text) => {
            handle.agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            })
          }

          const summarizeEvents = (sessionId) => events
            .filter((event) => event.sessionId === sessionId)
            .map((event) => {
              if (event.type === 'tool/call') return {
                type: event.type,
                callId: event.data?.callId,
                name: event.data?.name,
                arguments: event.data?.arguments,
              }
              if (event.type === 'tool/result') {
                const text = (event.data?.message?.content ?? [])
                  .filter((block) => block?.type === 'text')
                  .map((block) => block.text)
                  .join('\n')
                return {
                  type: event.type,
                  callId: event.data?.message?.toolCallId,
                  isError: event.data?.message?.isError,
                  text,
                  error: event.data?.error ?? null,
                }
              }
              if (event.type === 'assistant/message') {
                const calls = (event.data?.message?.content ?? [])
                  .filter((block) => block?.type === 'tool-call')
                  .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
                return { type: event.type, toolCalls: calls }
              }
              if (event.type === 'turn/end' || event.type === 'turn/error') {
                return { type: event.type, turn: event.data?.turn }
              }
              return undefined
            })
            .filter((event) => event !== undefined)

          // ── 无痕父会话：模型返回 subagent 工具调用，期望被 guard 拒绝 ─────────
          // DSH 的 in-process spawn 子会话 id 是裸 UUID（没有 `session-` 前缀）。
          // Provider 的 presentation 文本就是 `started subagent <uuid>`。
          const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          const incognito = await createAgent(incognitoId)
          const incognitoToolVisible = await waitToolVisible(incognito)
          const incognitoToolNames = visibleToolNames(incognito)
          const sessionsBefore = listSessionFiles(sessionsRoot)
          const incognitoSnapshot = snapshotSessionFiles(sessionsRoot)
          let incognitoTurnEnd = null
          let incognitoTurnError = null
          const incognitoTurn = waitFor(incognitoId, (event) => event.type === 'turn/end' || event.type === 'turn/error', 90000)
          followup(incognito, incognitoMarker)
          try {
            const event = await incognitoTurn
            if (event.type === 'turn/error') incognitoTurnError = event
            else incognitoTurnEnd = event
          } catch (error) {
            incognitoTurnError = { type: 'timeout', data: String(error?.message ?? error) }
          }
          await sleep(300)
          const incognitoObservedChanges = await observeSessionChanges(sessionsRoot, incognitoSnapshot)
          const incognitoSessionsAfter = listSessionFiles(sessionsRoot)
          const incognitoEvents = summarizeEvents(incognitoId)
          const incognitoResult = incognitoEvents.find((event) => event.type === 'tool/result' && event.callId === incognitoCallId)
          let incognitoChildId = null
          const incognitoChildMatch = typeof incognitoResult?.text === 'string'
            ? incognitoResult.text.match(new RegExp(`started subagent (${UUID})`))
            : null
          if (incognitoChildMatch !== null) incognitoChildId = incognitoChildMatch[1]
          let incognitoChildStat = null
          if (incognitoChildId !== null) {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              try {
                const value = await persistence.stat(incognitoChildId)
                if (value !== undefined) { incognitoChildStat = value; break }
              } catch {}
              await sleep(100)
            }
          }
          const incognitoChildSessionFiles = incognitoChildId === null
            ? []
            : listSessionFiles(sessionsRoot).filter((file) => file.includes(incognitoChildId))
          const incognitoParentSessionFiles = incognitoSessionsAfter.filter((file) => file.includes(incognitoId))

          // ── 普通父会话：同样的工具调用，期望子 agent 正常启动并落盘 ──────────
          const normal = await createAgent(normalId)
          const normalToolVisible = await waitToolVisible(normal)
          const normalToolNames = visibleToolNames(normal)
          const normalSessionsBefore = listSessionFiles(sessionsRoot)
          const normalSnapshot = snapshotSessionFiles(sessionsRoot)
          let normalTurnEnd = null
          let normalTurnError = null
          const normalTurn = waitFor(normalId, (event) => event.type === 'turn/end' || event.type === 'turn/error', 90000)
          followup(normal, normalMarker)
          try {
            const event = await normalTurn
            if (event.type === 'turn/error') normalTurnError = event
            else normalTurnEnd = event
          } catch (error) {
            normalTurnError = { type: 'timeout', data: String(error?.message ?? error) }
          }
          await sleep(800)

          const normalEvents = summarizeEvents(normalId)
          const normalResult = normalEvents.find((event) => event.type === 'tool/result' && event.callId === normalCallId)
          let normalChildId = null
          const match = typeof normalResult?.text === 'string' ? normalResult.text.match(new RegExp(`started subagent (${UUID})`)) : null
          if (match !== null) normalChildId = match[1]
          if (normalChildId === null) {
            // Presentation text is the primary evidence; fall back to a new session
            // directory named by a bare UUID (the parent id carries a `session-` prefix).
            for (let attempt = 0; attempt < 50 && normalChildId === null; attempt += 1) {
              const newFiles = listSessionFiles(sessionsRoot).filter((file) => !normalSessionsBefore.includes(file))
              for (const file of newFiles) {
                const childMatch = file.match(new RegExp(`(?:^|/)(${UUID})(?:/|$)`))
                if (childMatch !== null) {
                  normalChildId = childMatch[1]
                  break
                }
              }
              if (normalChildId === null) await sleep(100)
            }
          }

          let childStat = null
          let childStatError = null
          if (normalChildId !== null) {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              try {
                const value = await persistence.stat(normalChildId)
                if (value !== undefined) { childStat = value; break }
              } catch (error) {
                childStatError = String(error?.message ?? error)
              }
              await sleep(100)
            }
          }
          const normalObservedChanges = await observeSessionChanges(sessionsRoot, normalSnapshot)
          const normalSessionsAfter = listSessionFiles(sessionsRoot)
          const normalNewSessionFiles = normalSessionsAfter.filter((file) => !normalSessionsBefore.includes(file))
          const normalParentSessionFiles = normalSessionsAfter.filter((file) => file.includes(normalId))
          const childSessionFiles = normalChildId === null
            ? []
            : normalSessionsAfter.filter((file) => file.includes(normalChildId))

          const result = {
            ok: true,
            guardInstalled,
            preset: { id: preset?.id ?? null, broken: preset?.broken ?? null },
            provider,
            model,
            normalId,
            incognitoId,
            normalMarker,
            incognitoMarker,
            normalCallId,
            incognitoCallId,
            normalChildPrompt,
            incognitoChildPrompt,
            incognitoToolVisible,
            normalToolVisible,
            incognitoToolNames,
            normalToolNames,
            sessionsBefore,
            incognitoSessionsAfter,
            incognitoNewSessionFiles: incognitoSessionsAfter.filter((file) => !sessionsBefore.includes(file)),
            incognitoObservedChanges,
            incognitoTurnEnd,
            incognitoTurnError,
            incognitoEvents,
            incognitoChildId,
            incognitoChildStat: incognitoChildStat === null ? null : {
              id: incognitoChildStat?.header?.id ?? incognitoChildStat?.id ?? null,
              header: incognitoChildStat?.header ?? null,
            },
            incognitoParentSessionFiles,
            incognitoChildSessionFiles,
            normalSessionsBefore,
            normalSessionsAfter,
            normalNewSessionFiles,
            normalObservedChanges,
            normalTurnEnd,
            normalTurnError,
            normalEvents,
            normalChildId,
            childStat: childStat === null ? null : {
              id: childStat?.header?.id ?? childStat?.id ?? null,
              header: childStat?.header ?? null,
            },
            childStatError,
            normalParentSessionFiles,
            childSessionFiles,
          }
          note('result', { ok: true, guardInstalled, incognitoToolVisible, normalToolVisible, normalChildId })
          done(result)
        } catch (error) {
          fail(error)
        }
      })()
    }, 'm11-tool-probe.run')
  })
}
