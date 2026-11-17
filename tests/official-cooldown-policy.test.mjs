import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { httpError, MAX_PROVIDER_RETRY_AFTER_MS } from '../lib/http-errors.js'
import { RequestWaitStore } from '../lib/request-waits.js'
import { ProxyPool } from '../lib/proxy-pool.js'
import { ProxyService } from '../lib/proxy-service.js'

const recipe = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'public', userAgent: 'fixture', client: 'cli', project: 'global', extraHeaders: {} }
const input = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [] }
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
const quota = () => Response.json({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }, { status: 429, headers: { 'retry-after': '54000' } })
const adapter = options => new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: input.provider, recipe, requestTimeoutMs: 5000, ...options })
async function collect(a) { const chunks = []; for await (const chunk of a.stream(input)) chunks.push(chunk); return chunks.at(-1).reason }

test('typed quota denial preserves the raw hint only as diagnostics, not as a retry delay', async () => {
  const error = await httpError(quota())
  assert.equal(error.failure.code, 'FREE_USAGE_LIMIT')
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  assert.equal(error.diagnostics.retryAfterMs, 54_000_000)
  assert.equal(adapter().providerRetryPolicy(input.provider).retryableCodes.includes('FREE_USAGE_LIMIT'), false)
})

test('a new manual request reaches upstream immediately after a quota denial', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? quota() : ok())
  const a = adapter({ requestWaitState: {
    remaining() { assert.fail('legacy model waits must not block a new request') },
    remember() { assert.fail('new quota failures must not create persisted model waits') },
  } })
  const first = await collect(a)
  assert.equal(first.failure.code, 'FREE_USAGE_LIMIT')
  assert.doesNotMatch(first.failure.message, /Retry after at least/)
  assert.equal((await collect(a)).kind, 'stop')
  assert.equal(requests, 2)
})

test('transient hints are capped at the official fifteen minutes without a cross-request lockout', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? Response.json({ error: { type: 'RateLimitError', message: 'Too many requests' } }, { status: 429, headers: { 'retry-after': '7200' } })
    : ok())
  const a = adapter()
  const first = await collect(a)
  assert.equal(first.failure.code, 'RATE_LIMIT')
  assert.equal(first.failure.providerRetryAfterMs, MAX_PROVIDER_RETRY_AFTER_MS)
  assert.equal(a.providerRetryPolicy(input.provider).maxDelayMs, MAX_PROVIDER_RETRY_AFTER_MS)
  assert.equal((await collect(a)).kind, 'stop')
  assert.equal(requests, 2)
})

test('clear cooldowns retires live pool state and legacy disk state on the same instances', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-all-cooldowns-'))
  t.after(() => { const actual = fs.realpathSync(directory); assert.equal(actual, path.resolve(directory)); fs.rmSync(actual, { recursive: true, force: true }) })
  const store = new RequestWaitStore(path.join(directory, 'waits.json'))
  store.remember('fixture-free', 54_000_000, 'direct (this machine)')
  const pool = new ProxyPool(['direct'])
  pool.rateLimited(0, 54_000_000)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return ok() })
  const a = adapter({ pool, requestWaitState: store })
  assert.equal((await collect(a)).failure.code, 'EGRESS_COOLING')
  assert.equal(requests, 0)
  const service = new ProxyService(pool, { baseUrl: recipe.baseUrl, storePath: path.join(directory, 'proxies.json'), clearCooldowns: () => store.clear() })
  const identities = pool.urls()
  assert.equal(service.clearCooldowns(), 2)
  assert.deepEqual(pool.urls(), identities)
  assert.equal(store.remaining('fixture-free'), 0)
  assert.equal(pool.waitMs(), 0)
  assert.equal(pool.health()[0].failures, 0)
  assert.equal((await collect(a)).kind, 'stop')
  assert.equal(requests, 1, 'the same adapter must send without a process restart')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'waits.json'), 'utf8')).waits, [])
})

test('an old persisted model wait is not consulted even before the user clears it', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return ok() })
  const a = adapter({ requestWaitState: { remaining: () => 54_000_000, remember() {} } })
  assert.equal((await collect(a)).kind, 'stop')
  assert.equal(requests, 1)
})
