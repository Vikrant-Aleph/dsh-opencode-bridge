// Live multi-turn tool loop: the shape DSH actually drives.
//
// Opt-in: pass --run. It spends quota, so it is not part of `npm test`.
//
// Offline tests exercise one request at a time. What they cannot show is the loop:
// the model calls a tool, the host executes it, the result goes back, and the model
// continues — repeatedly — while the reasoning from earlier rounds is replayed.
//
// Usage: node tests/tool-loop-live.mjs --run [model] [--rounds 3]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { createBunFetch } from '../lib/bun-transport.js'
import { projectIdentityFor } from '../lib/project-identity.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'

const args = process.argv.slice(2)
if (!args.includes('--run')) {
  console.error('Usage: node tests/tool-loop-live.mjs --run [model] [--out <file>]')
  console.error('This test uses live quota, so it is opt-in.')
  process.exit(2)
}
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : null
const model = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? 'deepseek-v4.1-flash-free'
const isThinking = /deepseek/.test(model)
const TOKEN = 'LOOP_TOKEN_42'

const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-loop-'))
const dumpFile = path.join(dumpDir, 'requests.jsonl')

const str = { type: 'string' }
// One recognised name and two that need sanitizing, so the loop exercises the
// rename round trip on every round rather than once.
// Mirrors a real DSH declaration: several recognised names alongside ones that
// must be sanitized. A set with only one recognised name is refused by the gateway,
// which is a property of the gateway rather than of this test.
const tools = [
  { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { queries: str }, required: ['queries'], additionalProperties: false } },
  { name: 'todo_write', description: 'Record a todo item.', parameters: { type: 'object', properties: { item: str }, required: ['item'], additionalProperties: false } },
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: str }, required: ['file_path'], additionalProperties: false } },
  { name: 'write', description: 'Write a file.', parameters: { type: 'object', properties: { file_path: str, content: str }, required: ['file_path', 'content'], additionalProperties: false } },
  { name: 'edit', description: 'Edit a file.', parameters: { type: 'object', properties: { file_path: str }, required: ['file_path'], additionalProperties: false } },
  { name: 'glob', description: 'Find files.', parameters: { type: 'object', properties: { pattern: str }, required: ['pattern'], additionalProperties: false } },
  { name: 'grep', description: 'Search files.', parameters: { type: 'object', properties: { pattern: str }, required: ['pattern'], additionalProperties: false } },
]

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const transport = await createBunFetch({ timeoutMs: 120_000 })
const catalog = new FreeModelCatalog(
  'https://opencode.ai/inference/v1',
  { includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 },
  { debug() {}, info() {}, warn() {}, error() {} },
)
await catalog.refresh().catch(() => [])

const adapter = new OpenCodeFreeAdapter(catalog, {
  providerRoute: 'opencode-bridge',
  recipe: {
    baseUrl: 'https://opencode.ai/inference/v1',
    apiKey: 'public',
    userAgent: DEFAULT_PROTOCOL_USER_AGENT,
    client: 'cli',
    project: projectIdentityFor(process.cwd()) ?? 'global',
    extraHeaders: {},
  },
  requestTimeoutMs: 120_000,
  toolStrict: true,
  minOutputTokens: 32_000,
  tracing: true,
  dumpRequestsTo: dumpFile,
})
adapter.setTransport(transport)

const sessionId = `loop-${Date.now()}`
let history = []

async function turn(prompt) {
  history.push({ role: 'user', content: [{ type: 'text', text: prompt }] })
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'opencode-bridge', model, sessionId,
      system: 'You are a test harness. Follow the instruction exactly.',
      messages: history,
      tools,
    })) chunks.push(chunk)
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 160) }
  }
  const terminal = chunks.at(-1)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.textDelta ?? c.text ?? '').join('')
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block)
  const reasoning = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning').map((c) => c.block.text ?? '').join('')
  // Record the assistant turn exactly as the host would, so the next request
  // replays both the reasoning and the calls.
  history.push({
    role: 'assistant',
    content: [
      ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : []),
      ...calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      ...(text.trim() ? [{ type: 'text', text }] : []),
    ],
  })
  return { kind: terminal?.reason?.kind, code: terminal?.reason?.failure?.code, text: text.trim(), calls, reasoning }
}

function feedResults(calls, contentFor) {
  for (const call of calls) {
    history.push({ role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: contentFor(call) }] })
  }
}

// --- Round 1: the model must reach for a tool whose name needs sanitizing ------
const round1 = await turn('Call the web_search tool with queries set to "loop test". Call no other tool.')
check('round 1 reached a tool call', round1.kind === 'tool-calls' && (round1.calls?.length ?? 0) > 0, round1.error ?? `${round1.kind}${round1.code ? `/${round1.code}` : ''}`)
const call1 = round1.calls?.[0]
check('round 1 call carries the caller name', call1?.name === 'web_search', call1?.name ?? '(none)')
feedResults(round1.calls ?? [], () => `Search results: the secret token is ${TOKEN}.`)

// --- Round 2: the second turn must use the first turn's result -----------------
const round2 = await turn(`Now call the todo_write tool with item set to the secret token you were given (${TOKEN}). Call no other tool.`)
check('round 2 continued the loop', round2.kind === 'tool-calls' && (round2.calls?.length ?? 0) > 0, round2.error ?? `${round2.kind}${round2.code ? `/${round2.code}` : ''}`)
const call2 = round2.calls?.[0]
check('round 2 call carries the caller name', call2?.name === 'todo_write', call2?.name ?? '(none)')
check(
  'round 2 reused the token from round 1',
  String(call2?.arguments ?? '').includes(TOKEN),
  String(call2?.arguments ?? '').slice(0, 80),
)
feedResults(round2.calls ?? [], () => 'Todo recorded.')

// --- Round 3: a plain answer that depends on the earlier rounds ----------------
const round3 = await turn(`Reply with the secret token only, nothing else.`)
check('round 3 finished with a text answer', round3.kind === 'stop', round3.error ?? `${round3.kind}${round3.code ? `/${round3.code}` : ''}`)
check('round 3 answer carried the token', round3.text.includes(TOKEN), round3.text.includes(TOKEN) ? 'token present' : round3.text.slice(0, 60).replace(/\s+/g, ' '))

// --- The wire must replay reasoning on the later turns -------------------------
const bodies = fs.existsSync(dumpFile)
  ? fs.readFileSync(dumpFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).body)
  : []
check('every turn reached the wire', bodies.length >= 3, `${bodies.length} requests`)
const assistantRows = bodies.slice(1).flatMap((body) => (body.messages ?? []).filter((m) => m.role === 'assistant'))
check(
  'later turns replay the assistant turn',
  assistantRows.length > 0,
  `${assistantRows.length} assistant rows`,
)
if (isThinking) {
  check(
    'a thinking model replays reasoning_content',
    assistantRows.some((row) => Object.hasOwn(row, 'reasoning_content')),
    assistantRows.length ? Object.keys(assistantRows[0]).join(',') : 'none',
  )
} else {
  console.log(`SKIP  reasoning_content replay (${model} is not a thinking model)`)
}

if (typeof transport.close === 'function') await transport.close()
catalog.dispose()
fs.rmSync(dumpDir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
const report = { at: new Date().toISOString(), model, thinking: isThinking, passed: results.length - failed.length, failed: failed.length, results }
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
console.log(`\n${report.passed}/${results.length} checks passed`)
if (failed.length) {
  console.error('LOOP_FAILED:', failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
