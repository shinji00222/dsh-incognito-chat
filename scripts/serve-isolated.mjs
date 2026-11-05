// 用桌面版自带的 DSH 运行时，在隔离的 DSH_HOME（work/isolated-dsh）里启动 web profile。
// 不碰真实的 ~/.dsh。用法：node scripts/serve-isolated.mjs [port]
//
// DSH_DESKTOP_EXE 可以覆盖桌面版路径；默认是本机安装位置。

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const cli = path.join(path.dirname(exe), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const home = path.join(root, 'work/isolated-dsh')
mkdirSync(home, { recursive: true })

const port = process.argv[2] ?? '4517'
const child = spawn(exe, ['--expose-internals', cli, 'web', '--no-open', '--port', port], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, NODE_USE_SYSTEM_CA: '1', DSH_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
  windowsHide: true,
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
