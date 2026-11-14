// End-to-end smoke test against the live free tier.
//
// Opt-in: pass --run. It uses real quota, so it is not part of `pnpm test`.
//
// This exists because the offline suite once reported 418 passing tests while the
// plugin was refused on every real request: nothing exercised a realistic tool set
// against the gateway. The checks below are the ones that would have caught it.
//
// Usage: node tests/smoke.mjs --run [model] [--out <file>]
import fs from 'node:fs'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { createBunFetch } from '../lib/bun-transport.js'
import { projectIdentityFor } from '../lib/project-identity.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'
import { mintSessionId, mintRequestId, SESSION_ID_RE, planTools } from '../lib/opencode-protocol.js'

const args = process.argv.slice(2)
if (!args.includes('--run')) {
  console.error('Usage: node tests/smoke.mjs --run [model] [--out <file>]')
  console.error('This test uses live quota, so it is opt-in.')
  process.exit(2)
}
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : null
const model = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? 'glm-5.3-flash-free'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// --- 1. Protocol identity -----------------------------------------------------
const session = mintSessionId()
const request = mintRequestId()
check('session id shape', SESSION_ID_RE.test(session), session)
check('request id shape', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(request), request)

// --- 2. Tool names are separator-free ----------------------------------------
// DSH declares names like these; the gateway refuses separators outright and
// reports the refusal as a free-usage limit.
const dshStyle = [
  ['read', ['file_path']], ['write', ['file_path', 'content']], ['edit', ['file_path']],
  ['ask_user_question', ['question']], ['job_list', ['limit']], ['web_search', ['queries']],
  ['codex_sketch', ['prompt']], ['mcp__exa__web_search_exa', ['query']],
]
const str = { type: 'string' }
const callerTools = dshStyle.map(([name, props]) => ({
  name,
  description: `${name} tool`,
  parameters: {
    type: 'object',
    properties: Object.fromEntries(props.map((p) => [p, { type: str.type, description: `${p}.` }])),
    required: props,
    additionalProperties: false,
  },
}))
const plan = planTools(callerTools, { strict: true })
const wireNames = plan.tools.map((tool) => tool.function.name)
const offending = wireNames.filter((name) => !/^[a-z0-9]+$/.test(name))
check('declared names carry no separators', offending.length === 0, offending.join(',') || `${wireNames.length} names`)
const roundTrips = callerTools.every((tool) => {
  const wire = wireNames[plan.tools.findIndex((t) => plan.wireToCaller.get(t.function.name) === tool.name)]
  return Boolean(wire) && plan.wireToCaller.get(wire) === tool.name
})
check('every caller tool round-trips through its wire name', roundTrips)
check('a recognised name is present', wireNames.some((n) => ['read', 'write', 'edit', 'glob', 'grep', 'shell'].includes(n)))

// --- 3. Live catalog ----------------------------------------------------------
const transport = await createBunFetch({ timeoutMs: 120_000 })
const catalog = new FreeModelCatalog(
  'https://opencode.ai/inference/v1',
  { includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 },
  { debug() {}, info() {}, warn() {}, error() {} },
)
let models = []
try {
  models = [...(await catalog.refresh())]
} catch (error) {
  check('live model listing', false, String(error?.message ?? error).slice(0, 120))
}
if (models.length) check('live model listing', true, `${models.length} models`)

// --- 4. Live completion with the full tool set --------------------------------
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
})
adapter.setTransport(transport)

async function run(options) {
  const chunks = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 160), chunks }
  }
  const terminal = chunks.at(-1)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.textDelta ?? c.text ?? '').join('')
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block)
  return {
    kind: terminal?.reason?.kind,
    code: terminal?.reason?.failure?.code,
    text: text.trim(),
    calls,
    chunks,
  }
}

const base = {
  provider: 'opencode-bridge',
  model,
  sessionId: `smoke-${Date.now()}`,
  system: 'You are a test harness.',
  tools: callerTools,
}

const reply = await run({
  ...base,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly SMOKE_OK. Do not call tools.' }] }],
})
check(
  'live completion with the full tool set',
  reply.kind === 'stop' && reply.text.includes('SMOKE_OK'),
  reply.error ?? `${reply.kind}${reply.code ? `/${reply.code}` : ''} text=${JSON.stringify(reply.text.slice(0, 40))}`,
)

// --- 5. A tool call maps back to the caller's name ----------------------------
// This is the part that silently breaks: a sanitized name must be restored before
// the host dispatches it, or the host sees an unknown tool.
const toolTurn = await run({
  ...base,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the web_search tool with queries="smoke". Call nothing else.' }] }],
})
const calledNames = toolTurn.calls?.map((call) => call.name) ?? []
const restored = calledNames.every((name) => callerTools.some((tool) => tool.name === name))
check(
  'a returned tool call carries the caller name',
  toolTurn.kind === 'tool-calls' || toolTurn.kind === 'stop'
    ? calledNames.length === 0 || restored
    : false,
  calledNames.length ? calledNames.join(',') : `no call made (${toolTurn.kind ?? toolTurn.error})`,
)

if (typeof transport.close === 'function') await transport.close()
catalog.dispose()

const failed = results.filter((r) => !r.ok)
const report = { at: new Date().toISOString(), model, passed: results.length - failed.length, failed: failed.length, results }
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n')
console.log(`\n${report.passed}/${results.length} checks passed`)
if (failed.length) {
  console.error('SMOKE_FAILED:', failed.map((f) => f.name).join(', '))
  process.exitCode = 1
}
