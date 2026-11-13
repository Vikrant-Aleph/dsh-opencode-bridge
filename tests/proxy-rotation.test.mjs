import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { ProxyPool } from '../lib/proxy-pool.js'

const recipe = { baseUrl: 'https://relay.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }
const options = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [] }

function streamOf(text) {
  const events = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function makeAdapter(t, pool, behaviour) {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const egress = init.dispatcher?.url ?? 'direct'
    seen.push(egress)
    return behaviour(egress, seen.length)
  })
  const logs = []
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => logs.push(args)]))
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000, logger, pool,
    dispatcherFor: (url) => ({ url }),
  })
  return { adapter, seen, logs }
}

async function run(adapter) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return { chunks, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), terminal: chunks.at(-1) }
}

test('free usage rejection without a server wait never rotates identities or infers IP scope', async (t) => {
  const pool = new ProxyPool(['direct', 'http://proxy-a:8080', 'http://proxy-b:8080'], { cooldownMs: 60_000 })
  const { adapter, seen, logs } = makeAdapter(t, pool, () =>
    new Response('{"error":{"type":"FreeUsageLimitError","message":"Usage limit exceeded"}}', { status: 429 }))
  const result = await run(adapter)
  assert.equal(result.text, '')
  assert.equal(result.terminal.reason.kind, 'error')
  assert.equal(result.terminal.reason.failure.code, 'FREE_USAGE_LIMIT')
  assert.deepEqual(seen, ['direct'])
  assert.ok(pool.health().every(entry => entry.state === 'ready'))
  assert.ok(logs.some((entry) => String(entry[1]).includes('egress attempt')))
  assert.equal(adapter.providerRetryPolicy(options.provider).retryableCodes.includes('FREE_USAGE_LIMIT'), false)
})

test('rotation never duplicates streamed text when the first egress fails mid-stream', async (t) => {
  const pool = new ProxyPool(['direct', 'http://proxy-a:8080'])
  const { adapter } = makeAdapter(t, pool, (egress) => {
    if (egress === 'direct') {
      // Headers OK, then the body fails after one chunk: a retry here would
      // repeat that chunk, so the adapter must surface the failure instead.
      let sent = false
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n'))
            return
          }
          controller.error(new Error('reset'))
        },
      }), { status: 200 })
    }
    return new Response(streamOf('SECOND'), { status: 200 })
  })
  const result = await run(adapter)
  assert.equal(result.text, 'PARTIAL')
  assert.equal(result.chunks.some((c) => c.type === 'text-delta' && c.text === 'SECOND'), false)
  assert.equal(result.terminal.reason.kind, 'error')
})

test('free usage denial is surfaced once instead of exhausting every configured egress', async (t) => {
  const pool = new ProxyPool(['direct', 'http://proxy-a:8080'], { cooldownMs: 60_000 })
  const { adapter, seen } = makeAdapter(t, pool, () => new Response('{"error":{"type":"FreeUsageLimitError","message":"Usage limit exceeded"}}', { status: 429 }))
  const result = await run(adapter)
  assert.equal(seen.length, 1)
  assert.equal(result.terminal.reason.kind, 'error')
  assert.equal(result.terminal.reason.failure.code, 'FREE_USAGE_LIMIT')
  assert.equal(result.text, '')
})

test('an unreachable proxy is retired and the request still succeeds on the next egress', async (t) => {
  const pool = new ProxyPool(['http://dead:1', 'direct'], { cooldownMs: 60_000 })
  const { adapter, seen } = makeAdapter(t, pool, (egress) => {
    if (egress === 'http://dead:1') {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNREFUSED' }
      throw error
    }
    return new Response(streamOf('DIRECT_OK'), { status: 200 })
  })
  const result = await run(adapter)
  assert.equal(result.text, 'DIRECT_OK')
  assert.deepEqual(seen, ['http://dead:1', 'direct'])
  assert.equal(pool.health()[0].lastCode, 'ECONNREFUSED')
})

test('a throttled egress is skipped by the next request while cooling', async (t) => {
  const pool = new ProxyPool(['direct', 'http://proxy-a:8080'], { cooldownMs: 60_000 })
  pool.rateLimited(0)
  const { adapter, seen } = makeAdapter(t, pool, () => new Response(streamOf('A'), { status: 200 }))
  await run(adapter)
  assert.deepEqual(seen, ['http://proxy-a:8080'])
})

test('without a pool the adapter still uses a plain fetch', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(init.dispatcher ?? 'none')
    return new Response(streamOf('PLAIN'), { status: 200 })
  })
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000,
  })
  const result = await run(adapter)
  assert.equal(result.text, 'PLAIN')
  assert.deepEqual(seen, ['none'])
})
