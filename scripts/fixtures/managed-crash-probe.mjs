import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'managed-crash-probe'

export function apply(ctx) {
  const dir = process.env.DSH_MANAGED_CRASH_DIR
  if (!dir || fs.existsSync(path.join(dir, 'worker.pid'))) return
  const owner = 'session-incognito-11111111-1111-4111-8111-111111111111'
  const quote = name => "'" + path.join(dir, name).replaceAll("'", "''") + "'"
  const worker = [
    `[IO.File]::WriteAllText(${quote('worker.pid')}, [string]$PID)`,
    `$target = [IO.File]::ReadAllText(${quote('read-target.txt')})`,
    `for ($i = 0; $i -lt 600; $i++) { [IO.File]::WriteAllText(${quote('heartbeat.txt')}, [IO.File]::ReadAllText($target)); Start-Sleep -Milliseconds 100 }`,
  ].join('; ')
  const encodedWorker = Buffer.from(worker, 'utf16le').toString('base64')
  const command = [
    `[IO.File]::WriteAllText(${quote('shell.pid')}, [string]$PID)`,
    `$child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encodedWorker}' -WindowStyle Hidden -PassThru`,
    '$child.WaitForExit()',
  ].join('; ')

  ctx.inject(['shell', 'jobs', 'agents', 'agentPresets'], child => {
    child.effect(() => {
      void (async () => {
        const deadline = Date.now() + 15000
        while (!fs.existsSync(path.join(dir, 'read-target.txt'))) {
          if (Date.now() >= deadline) throw Error('synthetic attachment was not staged')
          await delay(50)
        }
        await child.agents.create({
          sessionId: owner,
          meta: { cwd: dir, agentPreset: 'standard' },
          setup: async agentCtx => { await child.agentPresets.mount(agentCtx, 'standard') },
        })
        const spec = child.shell.resolve({ command, workdir: dir, onExpiry: 'none' })
        child.jobs.start({
          kind: 'pwsh',
          label: 'Synthetic managed crash probe',
          owner,
          run() {
            const controller = new AbortController()
            const done = (async () => {
              const process = await child.shell.execute({ ...spec, signal: controller.signal })
              await process.result()
              return { status: 'completed' }
            })().catch(error => {
              fs.writeFileSync(path.join(dir, 'worker.error'), String(error))
              return { status: 'failed', error: String(error) }
            })
            return { done, cancel: () => controller.abort() }
          },
        })
      })().catch(error => fs.writeFileSync(path.join(dir, 'worker.error'), String(error)))
    }, 'managed-crash-probe')
  })
}
