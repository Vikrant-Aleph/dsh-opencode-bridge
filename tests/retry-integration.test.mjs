import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { ProxyPool, fetchWithPool, EgressCoolingError, redactProxyUrl } from '../lib/proxy-pool.js'
import { ProxyService } from '../lib/proxy-service.js'
import { retryAfterMs } from '../lib/retry-after.js'

// Offline contract tests only. The runner below models the inspected Host normal
// eligibility/budget/delay contract; it does NOT execute or claim to test DSH Host.
const epoch = Date.parse('2026-10-19T12:00:00Z')
const recipe = { baseUrl: 'https://offline.invalid/v1', apiKey: 'public', userAgent: 'fixture', client: 'cli', project: 'global', extraHeaders: {} }
const input = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [] }
const terminal = chunks => chunks.at(-1).reason
async function collect(adapter, extra = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({ ...input, ...extra })) chunks.push(chunk)
  return chunks
}
function fixture(t, config = {}) {
  let clock = epoch
  t.mock.method(Date, 'now', () => clock)
  const logs = []
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]))
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: input.provider, recipe, requestTimeoutMs: 5000, toolFingerprint: false, toolTranslation: false, logger, dispatcherFor: () => ({}), ...config })
  return { adapter, logs, advance(ms) { clock += ms }, now: () => clock }
}
function pool(now = () => epoch, extra = {}) {
  return new ProxyPool(['direct', 'http://user:PROXY_PASSWORD@proxy.invalid:8080'], { random: () => 0, ...extra }, now)
}
function rejected(type = 'RateLimitError', message = 'Too many requests', headers = {}) {
  return Response.json({ error: { type, message } }, { status: 429, headers })
}
function ok() { return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function brokenStream(kind, error) {
  let sent = false
  return new Response(new ReadableStream({ pull(c) {
    if (sent) { c.error(error); return }
    sent = true
    c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { [kind]: 'visible' } }] })}\n\n`))
  } }))
}
async function normalContract(adapter, advance, extra = {}) {
  const policy = adapter.providerRetryPolicy(input.provider)
  const delays = []
  let calls = 0
  for (;;) {
    calls++
    const reason = terminal(await collect(adapter, extra))
    if (reason.kind !== 'error' || !policy.retryableCodes.includes(reason.failure.code) || delays.length >= policy.maxRetries) return { reason, calls, delays }
    const hint = reason.failure.providerRetryAfterMs
    if (hint > policy.maxDelayMs) return { reason, calls, delays }
    const wait = hint > 0 ? hint : Math.min(policy.initialDelayMs * 2 ** delays.length, policy.maxDelayMs)
    delays.push(wait)
    advance(wait) // controlled clock, no sleep/timer/network
  }
}

test('adapter supplies exact bounded normal policy and excludes replay-prone errors', t => {
  const { adapter } = fixture(t)
  assert.deepEqual(adapter.providerRetryPolicy(input.provider), { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT', 'EGRESS_COOLING', 'REQUEST_COOLING'], initialDelayMs: 2000, maxDelayMs: 120000, jitterRatio: .2 })
  for (const code of ['TIMEOUT', 'TRANSPORT', 'PARTIAL_STREAM_ERROR', 'PROVIDER_STREAM_ERROR', 'STREAM_FAILED', 'TOOL_BRIDGE_REJECTED', 'TOOL_BRIDGE_INCOMPLETE', 'ABORTED']) assert.equal(adapter.providerRetryPolicy(input.provider).retryableCodes.includes(code), false)
})
test('normal contract simulation stops after two retries, without plugin timers', async t => {
  const f = fixture(t); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => { sent++; return rejected() })
  const out = await normalContract(f.adapter, f.advance)
  assert.equal(sent, 3); assert.equal(out.calls, 3); assert.deepEqual(out.delays, [2000, 4000])
})
test('normal contract simulation uses server wait verbatim, not jitter', async t => {
  const f = fixture(t); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => ++sent === 1 ? rejected('RateLimitError', 'Too many requests', { 'retry-after-ms': '60000' }) : ok())
  const out = await normalContract(f.adapter, f.advance)
  assert.deepEqual(out.delays, [60000]); assert.equal(sent, 2); assert.equal(out.reason.kind, 'stop')
})
test('over-policy-cap hint terminates normal contract without shortening', async t => {
  const f = fixture(t); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => { sent++; return rejected('RateLimitError', 'Too many requests', { 'retry-after': '3600' }) })
  const out = await normalContract(f.adapter, f.advance)
  assert.deepEqual(out.delays, []); assert.equal(sent, 1); assert.equal(out.reason.failure.providerRetryAfterMs, 3600000)
})
test('all-cold pool refuses network and dispatchers with remaining deadline', async () => {
  const p = pool(); p.rateLimited(0, 60000); p.rateLimited(1, 90000)
  assert.equal(p.acquire(), null)
  await assert.rejects(fetchWithPool({ pool: p, url: 'https://offline.invalid', init: {}, fetchImpl: () => assert.fail('network'), dispatcherFor: () => assert.fail('dispatcher') }), e => e instanceof EgressCoolingError && e.retryAfterMs === 60000)
})
test('cooling exact boundary becomes ready, never one millisecond early', () => {
  let now = epoch; const p = pool(() => now); p.rateLimited(0, 60000); p.rateLimited(1, 90000)
  now += 59999; assert.equal(p.acquire(), null)
  now++; assert.equal(p.acquire().index, 0)
})
test('server cooldown exceeds fallback cap without shortening or jitter', () => {
  const p = pool(() => epoch, { maxCooldownMs: 60000, random: () => 1 })
  p.rateLimited(0, 3600000)
  assert.equal(p.waitAt(0), 3600000)
})
test('fallback jitter is non-negative and capped only for fallback', () => {
  const p = pool(() => epoch, { cooldownMs: 60000, maxCooldownMs: 100000, random: () => 1 })
  p.rateLimited(0); assert.equal(p.waitAt(0), 72000)
  p.rateLimited(0); assert.equal(p.waitAt(0), 100000)
})
test('success, transport failure and shorter quota hint cannot erase concurrent cooldown', () => {
  const p = pool(); p.rateLimited(0, 3600000)
  p.succeeded(0); p.failed(0, 'TIMEOUT'); p.rateLimited(0, 1000)
  assert.equal(p.waitAt(0), 3600000)
})
test('request-scoped throttle never rotates or cools an IP', async () => {
  const p = pool(); let sent = 0
  const res = await fetchWithPool({ pool: p, url: 'https://offline.invalid', init: {}, throttleScope: async () => 'request', fetchImpl: async () => { sent++; return rejected() } })
  assert.equal(res.status, 429); assert.equal(sent, 1); assert.ok(p.health().every(h => h.state === 'ready'))
})
test('positive server hint ends even explicitly egress-scoped failover', async () => {
  const p = pool(); let sent = 0
  await fetchWithPool({ pool: p, url: 'https://offline.invalid', init: {}, throttleScope: async () => 'egress', fetchImpl: async () => { sent++; return rejected('FreeUsageLimitError', 'Quota exceeded', { 'retry-after': '60' }) } })
  assert.equal(sent, 1); assert.equal(p.waitAt(0), 60000); assert.equal(p.waitAt(1), 0)
})
test('explicit no-hint egress quota can fail over to a ready exit once', async t => {
  const p = pool(); const f = fixture(t, { pool: p }); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => ++sent === 1 ? rejected('FreeUsageLimitError', 'Quota exceeded') : ok())
  assert.equal(terminal(await collect(f.adapter)).kind, 'stop'); assert.equal(sent, 2); assert.equal(p.waitAt(0), 60000)
})
for (const [label, type, message] of [['unknown', 'UnknownError', 'unknown upstream condition'], ['endpoint', 'FreeUsageLimitError', 'Endpoint is unavailable.']]) {
  test(`${label} 429 does not rotate or punish egress`, async t => {
    const p = pool(); const f = fixture(t, { pool: p }); let sent = 0
    t.mock.method(globalThis, 'fetch', async () => { sent++; return rejected(type, message) })
    assert.equal(terminal(await collect(f.adapter)).failure.code, 'RATE_LIMIT')
    assert.equal(sent, 1); assert.ok(p.health().every(h => h.state === 'ready'))
  })
}
test('manual same-model call cannot bypass request hint, other models remain independent', async t => {
  const f = fixture(t); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => { sent++; return rejected('RateLimitError', 'Too many requests', { 'retry-after': '60' }) })
  await collect(f.adapter)
  f.advance(59999)
  assert.equal(terminal(await collect(f.adapter)).failure.code, 'REQUEST_COOLING'); assert.equal(sent, 1)
  await collect(f.adapter, { model: 'other-free' }); assert.equal(sent, 2)
  f.advance(1); await collect(f.adapter); assert.equal(sent, 3)
})
test('HTTP-date hint honors server Date clock skew and strict malformed boundaries', () => {
  const date = new Date(epoch).toUTCString(); const target = new Date(epoch + 60000).toUTCString()
  assert.equal(retryAfterMs(new Response('', { headers: { date, 'retry-after': target } }), epoch + 86400000), 60000)
  for (const value of ['0', '-1', 'Infinity', '2026-10-19', date]) assert.equal(retryAfterMs(new Response('', { headers: { 'retry-after': value } }), epoch), undefined)
})
test('huge hints remain safe finite deadlines and exceed Node timer maximum', () => {
  const wait = retryAfterMs(new Response('', { headers: { 'retry-after': '9'.repeat(400) } }), epoch)
  assert.ok(Number.isSafeInteger(wait)); assert.ok(wait > 2147483647); assert.ok(Number.isSafeInteger(epoch + wait))
})
test('concurrent successful response cannot clear remembered request hint', async t => {
  const f = fixture(t); const pending = deferred(); const dispatched = deferred(); let sent = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++sent === 1) { dispatched.resolve(); return pending.promise }
    return rejected('RateLimitError', 'Too many requests', { 'retry-after': '60' })
  })
  const successful = collect(f.adapter)
  await dispatched.promise
  await collect(f.adapter); pending.resolve(ok()); await successful
  assert.equal(terminal(await collect(f.adapter)).failure.code, 'REQUEST_COOLING'); assert.equal(sent, 2)
})
test('in-flight result maps by stable ID after live pool reorder', async () => {
  const p = pool(); const first = p.entryAt(0).id; const second = p.entryAt(1).id
  await fetchWithPool({ pool: p, url: 'https://offline.invalid', init: {}, throttleScope: async () => 'egress', fetchImpl: async () => { p.replace([...p.urls()].reverse()); return rejected('FreeUsageLimitError', 'Quota exceeded', { 'retry-after': '60' }) } })
  assert.equal(p.waitAt(p.indexOf(first)), 60000); assert.equal(p.waitAt(p.indexOf(second)), 0)
})
for (const kind of ['content', 'reasoning_content']) for (const code of ['TIMEOUT', 'TRANSPORT']) {
  test(`${kind} followed by ${code} closes output and forbids automatic replay`, async t => {
    const f = fixture(t)
    t.mock.method(globalThis, 'fetch', async () => brokenStream(kind, new LlmError('SECRET_STREAM', code)))
    const chunks = await collect(f.adapter)
    assert.equal(terminal(chunks).failure.code, 'PARTIAL_STREAM_ERROR')
    assert.equal(chunks.filter(c => c.type === 'block-end').length, 1)
    assert.equal(f.adapter.providerRetryPolicy(input.provider).retryableCodes.includes(terminal(chunks).failure.code), false)
    assert.ok(f.logs.some(log => log.args[2]?.originalCode === code)); assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_STREAM/)
  })
}
test('pre-cancelled invocation performs zero network and remains ABORTED', async t => {
  const f = fixture(t); const controller = new AbortController(); controller.abort(new Error('cancelled'))
  t.mock.method(globalThis, 'fetch', () => assert.fail('cancelled request sent'))
  assert.equal(terminal(await collect(f.adapter, { signal: controller.signal })).failure.code, 'ABORTED')
})
test('error body and proxy credentials never enter persistent diagnostics', async t => {
  const p = pool(); p.rateLimited(0, 60000)
  const f = fixture(t, { pool: p, recipe: { ...recipe, baseUrl: 'https://user:ENDPOINT_PASSWORD@offline.invalid/v1/private?key=QUERY_SECRET' } })
  t.mock.method(globalThis, 'fetch', async () => rejected('UnknownError', 'SECRET_BODY bearer SECRET_TOKEN', { 'x-opencode-log-id': 'req_safe_123' }))
  await collect(f.adapter)
  const text = JSON.stringify(f.logs)
  assert.doesNotMatch(text, /SECRET_BODY|SECRET_TOKEN|PROXY_PASSWORD|ENDPOINT_PASSWORD|QUERY_SECRET/)
  assert.match(text, /req_safe_123/); assert.ok(f.logs.some(log => log.level === 'warn' && log.args[1] === 'request deferred'))
  assert.equal(redactProxyUrl('http://user:PROXY_PASSWORD@proxy.invalid:8080'), 'http://proxy.invalid:8080')
})
test('failover attempts every stable ID at most once even with live reorder', async () => {
  const p = pool(); const seen = []
  await assert.rejects(fetchWithPool({ pool: p, url: 'https://offline.invalid', init: {}, dispatcherFor: () => ({}), fetchImpl: async (_url, init) => {
    seen.push(init.dispatcher ? 'proxy' : 'direct')
    p.replace([...p.urls()].reverse())
    throw new Error('offline transport')
  } }), /offline transport/)
  assert.deepEqual(seen.sort(), ['direct', 'proxy'])
})
test('successful in-flight probe cannot erase a concurrently imposed hint', async t => {
  const p = new ProxyPool(['direct'], { random: () => 0 }, () => epoch)
  const service = new ProxyService(p, { storePath: 'unused-offline-path', baseUrl: 'https://offline.invalid' })
  const pending = deferred(); const dispatched = deferred()
  t.mock.method(globalThis, 'fetch', () => { dispatched.resolve(); return pending.promise })
  const probe = service.test(); await dispatched.promise
  p.rateLimited(0, 3600000); pending.resolve(new Response('{}'))
  await probe
  assert.equal(p.waitAt(0), 3600000)
})
test('ProxyService probe skips cooling entries without network or cooldown reset', async t => {
  const p = new ProxyPool(['direct'], { random: () => 0 }, () => epoch); p.rateLimited(0, 60000)
  const service = new ProxyService(p, { storePath: 'unused-offline-path', baseUrl: 'https://offline.invalid' })
  t.mock.method(globalThis, 'fetch', () => assert.fail('cooling probe sent'))
  const result = await service.test()
  assert.equal(result.results[0].code, 'EGRESS_COOLING'); assert.equal(result.results[0].retryAfterMs, 60000); assert.equal(p.waitAt(0), 60000)
})
