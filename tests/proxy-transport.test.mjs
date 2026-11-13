import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { ProxyPool } from '../lib/proxy-pool.js'

/**
 * The pool selects an egress per attempt. `dispatcher` is undici-specific, so the
 * selected proxy URL must also travel as `proxyUrl` for a transport that does not
 * understand undici dispatchers 鈥?otherwise proxy rotation silently stops working
 * whenever the Bun-shaped transport is active.
 */
const recipe = { baseUrl: 'https://relay.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }

function streamOf(text) {
  const events = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function adapterWith(t, pool, seen) {
  // Stand-in transport that behaves like the Bun one: it ignores `dispatcher`
  // and only understands `proxyUrl`.
  const bunFetch = async (_url, init) => {
    seen.push({ proxyUrl: init.proxyUrl ?? null, hasDispatcher: Boolean(init.dispatcher) })
    return new Response(streamOf('OK'), { headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000, pool,
    dispatcherFor: (url) => ({ url }),
  })
  adapter.setTransport(bunFetch)
  return adapter
}

const options = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [] }

test('the selected proxy URL reaches a non-undici transport', async t => {
  const seen = []
  const pool = new ProxyPool(['http://127.0.0.1:9001'], { cooldownMs: 60_000 })
  const adapter = adapterWith(t, pool, seen)
  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].proxyUrl, 'http://127.0.0.1:9001')
})

test('a direct egress carries no proxy URL', async t => {
  const seen = []
  const pool = new ProxyPool(['direct'], { cooldownMs: 60_000 })
  const adapter = adapterWith(t, pool, seen)
  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].proxyUrl, null)
})

test('failover to a second egress carries that egress URL', async t => {
  const seen = []
  const pool = new ProxyPool(['http://127.0.0.1:9101', 'http://127.0.0.1:9102'], { cooldownMs: 60_000 })
  let attempt = 0
  const bunFetch = async (_url, init) => {
    seen.push(init.proxyUrl ?? null)
    attempt++
    if (attempt === 1) throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    return new Response(streamOf('OK'), { headers: { 'content-type': 'text/event-stream' } })
  }
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000, pool,
    dispatcherFor: (url) => ({ url }),
  })
  adapter.setTransport(bunFetch)
  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.deepEqual(seen, ['http://127.0.0.1:9101', 'http://127.0.0.1:9102'])
})
