// Live egress verification: proves the CONNECT tunnel carries real relay
// traffic, then runs one synthetic completion through the pool.
//
// Usage: node tests/proxy-live.mjs [proxyUrl] [model-id]
// Sends no user content: the prompt asks for a fixed marker string.
import { ProxyPool, dispatcherFor } from '../lib/proxy-pool.js'
import { ProxyService } from '../lib/proxy-service.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { FreeModelCatalog } from '../lib/catalog.js'

const proxyUrl = process.argv[2] ?? 'http://127.0.0.1:10808'
const model = process.argv[3] ?? 'glm-5.3-flash-free'
const baseUrl = 'https://opencode.ai/inference/v1'
const log = (m) => console.log(`[proxy-live] ${m}`)
const silent = { debug() {}, info() {}, warn() {}, error() {} }

const pool = new ProxyPool([proxyUrl, 'direct'], { cooldownMs: 60_000 })
const service = new ProxyService(pool, { storePath: '', baseUrl, dispatcherFor })

log(`pool: ${pool.health().map((e) => e.display).join(' -> ')}`)

// 1. Probe each egress with the relay's own listing (no prompt, no quota).
const probe = await service.test()
for (const result of probe.results) {
  log(`probe ${result.display}: ${result.ok ? 'OK' : result.code} ${result.ms}ms status=${result.status ?? '-'}`)
}
if (probe.reachable === 0) {
  console.error('PROXY_LIVE_FAILED: no egress reached the relay')
  process.exit(1)
}

// 2. One synthetic completion, ordered proxy-first so the tunnel must carry it.
const catalog = new FreeModelCatalog(baseUrl, { includeDeprecated: false, extraModels: [], pool, dispatcherFor }, silent)
const adapter = new OpenCodeFreeAdapter(catalog, {
  providerRoute: 'opencode-bridge',
  recipe: { baseUrl, apiKey: 'public', userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', client: 'cli', project: 'global', extraHeaders: {} },
  requestTimeoutMs: 120_000,
  toolFingerprint: true,
  toolTranslation: true,
  logger: silent,
  pool,
  dispatcherFor,
})

let text = ''
let terminal
for await (const chunk of adapter.stream({
  provider: 'opencode-bridge',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PROXY_OK' }], id: 'm1', source: { kind: 'user' } }],
  system: 'You are a test harness.',
  tools: [],
  sessionId: 'proxy-live',
  maxTokens: 40,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') { terminal = chunk.reason; log(`finish ${JSON.stringify(chunk.reason)}`) }
}

log(`egress state: ${pool.health().map((e) => `${e.display}=${e.state}${e.lastCode ? `(${e.lastCode})` : ''}`).join(', ')}`)
log(`text: ${JSON.stringify(text)}`)
if (terminal?.kind !== 'stop' || text.trim() !== 'PROXY_OK') {
  console.error('PROXY_LIVE_FAILED: expected a completed PROXY_OK reply')
  process.exitCode = 1
}
