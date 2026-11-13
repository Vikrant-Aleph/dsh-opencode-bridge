import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'
import { httpError } from '../lib/http-errors.js'
import { ProxyPool } from '../lib/proxy-pool.js'

const recipe = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'public', userAgent: DEFAULT_PROTOCOL_USER_AGENT, client: 'cli', project: 'global', extraHeaders: {} }
const input = { provider: 'opencode-bridge', model: 'fixture-free', sessionId: 'synthetic-current-protocol', maxTokens: 128, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], tools: [] }
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n')
async function collect(adapter, extra = {}) { const chunks = []; for await (const chunk of adapter.stream({ ...input, ...extra })) chunks.push(chunk); return chunks }
function adapter(extra = {}) { return new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: input.provider, recipe, requestTimeoutMs: 1000, ...extra }) }

test('current Chat generation shape matches the observed official encoder without claiming its tool authority', async t => {
  let body, headers
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); headers = init.headers; return ok() })
  const chunks = await collect(adapter())
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(body.max_completion_tokens, 128)
  assert.deepEqual(body.stream_options, { include_usage: true })
  for (const absent of ['max_tokens', 'prompt_cache_key', 'tool_choice']) assert.equal(Object.hasOwn(body, absent), false, absent)
  // The gateway refuses a request that declares no tools, so the read anchor is
  // always present even when the caller supplies none.
  assert.deepEqual(body.tools.map((t) => t.function.name), ['read'])
  assert.equal(headers['user-agent'], 'opencode/latest/2.2.0/cli')
  assert.doesNotMatch(headers['user-agent'], /deepseek-harness/)
  assert.equal(headers['x-opencode-session'], headers['x-session-affinity'])
  assert.equal(headers.authorization, 'Bearer public')
})

test('the DSH attribution token is opt-in', async t => {
  let headers
  t.mock.method(globalThis, 'fetch', async (_url, init) => { headers = init.headers; return ok() })
  await collect(adapter({ userAgentAttribution: true }))
  assert.match(headers['user-agent'], /^opencode\/latest\/2\.2\.0\/cli /)
  assert.match(headers['user-agent'], /deepseek-harness/)
})

test('custom user-agent and extra headers remain explicit user choices', async t => {
  let headers
  t.mock.method(globalThis, 'fetch', async (_url, init) => { headers = init.headers; return ok() })
  await collect(adapter({ recipe: { ...recipe, userAgent: 'custom-compatibility-client', extraHeaders: { 'x-fixture': 'safe' } } }))
  assert.equal(headers['user-agent'], 'custom-compatibility-client')
  assert.equal(headers['x-fixture'], 'safe')
})

test('typed free-usage denial remains distinct from transient throttling with the exact server hint', async () => {
  const e = await httpError(Response.json({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }, { status: 429, headers: { 'retry-after': '54965' } }))
  assert.equal(e.failure.code, 'FREE_USAGE_LIMIT')
  assert.equal(e.failure.status, 429)
  assert.equal(e.failure.providerRetryAfterMs, 54_965_000)
  const outage = await httpError(Response.json({ error: { type: 'FreeUsageLimitError', message: 'Endpoint is unavailable.' } }, { status: 429 }))
  assert.equal(outage.failure.code, 'RATE_LIMIT')
  assert.equal(outage.diagnostics.reason, 'endpoint_unavailable')
})

test('free-usage server wait is preserved for the affected model without locking unrelated models or metadata egress', async t => {
  const pool = new ProxyPool(['direct'])
  let posts = 0
  t.mock.method(globalThis, 'fetch', async () => ++posts === 1
    ? Response.json({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }, { status: 429, headers: { 'retry-after': '54965' } })
    : ok())
  const a = adapter({ pool })
  const first = await collect(a)
  assert.equal(first.at(-1).reason.failure.code, 'FREE_USAGE_LIMIT')
  assert.equal(first.at(-1).reason.failure.providerRetryAfterMs, 54_965_000)
  assert.equal(a.providerRetryPolicy(input.provider).retryableCodes.includes('FREE_USAGE_LIMIT'), false)
  const deferred = await collect(a)
  assert.equal(deferred.at(-1).reason.failure.code, 'REQUEST_COOLING')
  assert.equal(posts, 1, 'same-model manual call cannot shorten the server wait')
  assert.equal(pool.health()[0].state, 'ready', 'usage type alone does not establish an IP quota')
  const other = await collect(a, { model: 'other-fixture-free' })
  assert.equal(other.at(-1).reason.kind, 'stop')
  assert.equal(posts, 2)
})
