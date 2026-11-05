// 打包当前代码，装进隔离 DSH_HOME（work/isolated-dsh）里一个全新的 web profile。
// 每次都删掉旧 profile 重建：同版本号的 tgz 会被 pnpm 复用旧安装，改了代码也不生效。
// 用法：node scripts/install-isolated.mjs   然后 node scripts/serve-isolated.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = path.join(root, 'work/isolated-dsh')
const profile = path.join(home, 'profiles/web')
if (!profile.startsWith(path.join(root, 'work') + path.sep)) throw new Error('unsafe profile path')

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
mkdirSync(path.join(root, 'artifacts'), { recursive: true })
execFileSync('npm', ['pack', '--pack-destination', 'artifacts'], { cwd: root, stdio: 'ignore', shell: true })
const tarball = path.join(root, 'artifacts', `${pkg.name}-${pkg.version}.tgz`)

rmSync(profile, { recursive: true, force: true })

const exe = process.env.DSH_DESKTOP_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/DeepSeek Harness.exe')
const cli = path.join(path.dirname(exe), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
const result = spawnSync(exe, ['--expose-internals', cli, 'plugin', '--profile', 'web', 'add', tarball], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 300_000,
})
if (result.status !== 0) {
  console.error(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}
console.log(`installed ${path.basename(tarball)} into ${profile}`)
