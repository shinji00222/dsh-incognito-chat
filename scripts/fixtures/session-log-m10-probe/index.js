// M10 探针插件：在隔离的 DSH 里用真实 Agent 链路发一轮合成对话。
//
// 只创建两个 Session 并发一条用户消息：
//   - 普通 id（session-<uuid>）
//   - 无痕 id（session-incognito-<uuid>，由被测插件分流到内存）
// 请求是否带上 dsh_session_log 由本地模拟服务端记录，这里只负责把两轮对话跑起来。
// 全部输入来自环境变量；不含真实对话、凭据或 Cookie。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'session-log-m10-probe'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const dir = process.env.M10_RUN_DIR
  const normalId = process.env.M10_NORMAL_ID
  const incognitoId = process.env.M10_INCOGNITO_ID
  const normalProbe = process.env.M10_NORMAL_PROBE
  const incognitoProbe = process.env.M10_INCOGNITO_PROBE
  const cwd = process.env.M10_WORKSPACE
  const ids = new Set([normalId, incognitoId].filter(Boolean))

  const note = (label, value) => {
    try {
      fs.appendFileSync(path.join(dir, 'probe.log'), `${new Date().toISOString()} ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
    } catch {}
  }

  const done = (result) => {
    fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify(result, null, 2))
  }
  const fail = (error) => {
    ctx.logger?.warn?.(`[m10-probe] ${String(error?.stack ?? error)}`)
    try {
      done({ ok: false, error: String(error?.stack ?? error) })
    } catch {}
  }
  const waitForFile = async (file, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${file}`)
  }

  const createAgent = async (agents, sessionId, probe) => {
    let lastError
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const handle = await agents.create({
          sessionId,
          meta: { cwd },
          agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
        })
        note('agent.created', { sessionId, agentId: handle?.agent?.id, status: handle?.agent?.status })
        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: probe }],
          source: { kind: 'user' },
        }
        handle.agent.followup(message)
        note('agent.followup', { sessionId, probe })
        return
      } catch (error) {
        lastError = error
        await sleep(250)
      }
    }
    throw lastError
  }

  ctx.on('session/event', (session, event) => {
    if (!ids.has(session?.id)) return
    const interesting = event?.type === 'turn/end' || event?.type === 'assistant/attempt' || event?.type === 'turn/error'
    let data = ''
    if (interesting) {
      try {
        data = JSON.stringify(event?.data ?? null).slice(0, 800)
      } catch {
        data = '[unserializable]'
      }
    }
    note('session/event', { sessionId: session.id, type: event?.type, data })
  })
  ctx.on('agent/status', (info) => {
    if (info?.agent?.id !== undefined && ids.has(info?.agent?.id)) note('agent/status', info)
  })

  ctx.inject(['agents', 'llm'], (child) => {
    child.effect(() => {
      void (async () => {
        try {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const providers = child.get('llm')?.listProviders?.() ?? []
            if (providers.some((entry) => entry.id === 'deepseek-official')) break
            await sleep(100)
          }
          await sleep(500)
          const agents = child.get('agents')
          if (!agents?.create) throw new Error('agents.create unavailable')
          await createAgent(agents, normalId, normalProbe)
          await waitForFile(path.join(dir, 'requests', 'normal.json'), 30000)
          await createAgent(agents, incognitoId, incognitoProbe)
          await waitForFile(path.join(dir, 'requests', 'incognito.json'), 30000)
          done({ ok: true, normalId, incognitoId })
        } catch (error) {
          fail(error)
        }
      })()
    }, 'm10-probe.run')
  })
}
