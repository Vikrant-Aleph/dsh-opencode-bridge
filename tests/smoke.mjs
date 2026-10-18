// End-to-end smoke test: exercise the adapter against the live free tier.
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { mintSessionId, mintRequestId, SESSION_ID_RE, planTools, normalizeToolCall } from '../lib/opencode-protocol.js'

const log = (m) => console.log(`[smoke] ${m}`)
// Minimal LoggerLike so the smoke run exercises the same call shapes as the host.
const logger = {
  debug: (scope, msg, data) => log(`DEBUG ${scope}: ${msg} ${data ? JSON.stringify(data) : ''}`),
  info: (scope, msg, data) => log(`INFO  ${scope}: ${msg} ${data ? JSON.stringify(data) : ''}`),
  warn: (scope, msg, data) => log(`WARN  ${scope}: ${msg} ${data ? JSON.stringify(data) : ''}`),
  error: (scope, msg, data) => log(`ERROR ${scope}: ${msg} ${data ? JSON.stringify(data) : ''}`),
}

// 1. Protocol unit checks
const ses = mintSessionId()
const msg = mintRequestId()
console.log('session id:', ses, 'valid=', SESSION_ID_RE.test(ses))
console.log('request id:', msg, 'valid=', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(msg))
const lowBits = (BigInt('0x' + ses.slice(4, 16)) & 0xFFFn).toString(16)
console.log('session low 12 bits (expect ffe):', lowBits)

const plan = planTools([
  { name: 'read', description: 'different description', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'pwsh', description: 'run powershell', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'todo_write', description: 'todos', parameters: { type: 'object', properties: {} } },
])
console.log('planned tools:', plan.tools.map((t) => t.function.name).join(', '))
console.log('aliases:', [...plan.aliasToOriginal].map(([a, o]) => `${a}->${o}`).join(', '))
console.log('decoys:', [...plan.decoys].join(', '))
try {
  normalizeToolCall({ id: 'x', name: 'shell', arguments: '{"command":"ls -la","workdir":"/tmp"}' }, plan)
  throw new Error('Injected executable shell must not be translated')
} catch (error) {
  if (error.reason !== 'EXECUTABLE_DECOY') throw error
  console.log('injected shell correctly refused:', error.reason)
}
const translated = normalizeToolCall({ id: 'x', name: 'read', arguments: '{"path":"fixture.txt"}' }, plan)
console.log('read translated ->', translated.name, translated.arguments)

// 2. Live model catalog
const catalog = new FreeModelCatalog('https://opencode.ai/inference/v1', { includeDeprecated: false, extraModels: [] }, logger)
const models = await catalog.list()
console.log('models:', models.map((m) => m.id).join(', '))

// 3. Live streaming call
const adapter = new OpenCodeFreeAdapter(catalog, {
  providerRoute: 'opencode-bridge',
  recipe: {
    baseUrl: 'https://opencode.ai/inference/v1',
    apiKey: 'public',
    userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    client: 'cli',
    project: 'global',
    extraHeaders: {},
  },
  requestTimeoutMs: 120_000,
  toolFingerprint: true,
  toolTranslation: true,
  logger,
})

const messageId = 'ses_smoke'
const options = {
  provider: 'opencode-bridge',
  model: process.argv[2] ?? 'glm-5.3-flash-free',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: SMOKE_OK' }], id: 'm1', source: { kind: 'user' } }],
  system: 'You are a test harness.',
  // Caller contracts only; the adapter itself adds admission declarations.
  tools: [...plan.callerTools.values()],
  sessionId: messageId,
  maxTokens: 200,
}

let text = ''
let terminal
for await (const chunk of adapter.stream(options)) {
  if (chunk.type === 'text-delta') text += chunk.text
  else if (chunk.type === 'finish') { terminal = chunk.reason; console.log('finish:', JSON.stringify(chunk.reason)) }
  else if (chunk.type === 'usage') console.log('usage:', JSON.stringify(chunk.usage))
  else if (chunk.type === 'block-end') console.log('block-end:', JSON.stringify(chunk.block).slice(0, 160))
}
console.log('text:', JSON.stringify(text))
if (terminal?.kind !== 'stop' || text.trim() !== 'SMOKE_OK') {
  console.error('SMOKE_FAILED: expected a completed SMOKE_OK text reply')
  process.exitCode = 1
}
