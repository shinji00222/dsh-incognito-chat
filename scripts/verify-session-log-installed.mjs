import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { patchSessionLog } from '../src/host/session-log.js'
const file = path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/app.asar')
const fd = fs.openSync(file, 'r')
const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, 0)
const size = header.readUInt32LE(4), jsonSize = header.readUInt32LE(12)
const json = Buffer.alloc(jsonSize); fs.readSync(fd, json, 0, jsonSize, 16)
const tree = JSON.parse(json.toString())
function source(pkg) {
  let x = tree
  for (const part of `dsh/node_modules/@deepseek-ai/${pkg}/lib/index.js`.split('/')) x = x.files[part]
  const data = Buffer.alloc(x.size); fs.readSync(fd, data, 0, x.size, 8 + size + Number(x.offset))
  return data.toString()
}
const registrySource = source('dsh-deepseek-llm-api-extensions').replace('import { Service } from "@deepseek-ai/cordis";', 'class Service { constructor(ctx) { this.ctx = ctx } }')
const logSource = source('dsh-session-log-deepseek')
 .replace('import z from "@deepseek-ai/schemastery";', 'const chain = new Proxy(function(){}, { get: () => chain, apply: () => chain }); const z = chain;')
 .replace('import { brandString } from "@deepseek-ai/dsh-brand";', 'const brandString = x => x;')
 .replace('import { KNOWN_SESSION_EVENT_TYPES, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";', 'const KNOWN_SESSION_EVENT_TYPES = new Set(); const SessionLogOffset = x => x; const SessionSeq = x => x;')
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const { DeepSeekLlmApiExtensionRegistry } = await load(registrySource)
const { apply } = await load(logSource)
const ctx = { effect: fn => fn(), logger: { warn() {} } }
const registry = new DeepSeekLlmApiExtensionRegistry(ctx)
const ids = ['session-incognito-11111111-1111-4111-8111-111111111111', 'session-11111111-1111-4111-8111-111111111111']
const event = { seq: 0, time: '2026-11-07T00:00:00Z', type: 'synthetic/probe', data: { text: 'SYNTHETIC-LOG-PROBE' }, ignorable: true }
const sessions = new Map(ids.map(id => [id, { id, seq: 1, header: { version: 1, id, createdAt: '2026-11-07T00:00:00Z' }, eventAt: () => event, snapshotEvents: () => [event], append() {} }]))
apply({ deepseekLlmApiExtensions: registry, sessions, logger: ctx.logger }, { enabled: { get: () => true }, maxBytes: 100000 })
const make = id => registry.prepare({ sessionId: id, body: {}, signal: new AbortController().signal })
const before = await make(ids[0]); assert.match(JSON.stringify(before.fields), /SYNTHETIC-LOG-PROBE/)
patchSessionLog(registry)
const privateFields = await make(ids[0]), normalFields = await make(ids[1])
assert.equal(Object.hasOwn(privateFields.fields, 'dsh_session_log'), false)
assert.match(JSON.stringify(normalFields.fields), /SYNTHETIC-LOG-PROBE/)
console.log('PASS: installed DSH registry and provider: unpatched incognito includes probe; patched incognito omits field; ordinary retains probe')
fs.closeSync(fd)
