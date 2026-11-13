import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'

/**
 * The Bun-shaped transport resolves asynchronously after the adapter exists. The
 * adapter must wait for it rather than quietly using the plain-fetch fallback on
 * the first request.
 */
const recipe = { baseUrl: 'https://relay.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }
const options = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [] }

const stream = () => new Response(
  'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } },
)

function makeAdapter() {
  return new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000,
  })
}

test('a request waits for a transport that is still resolving', async t => {
  let plainCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { plainCalls++; return stream() })

  const adapter = makeAdapter()
  let resolveTransport
  const pending = new Promise((resolve) => { resolveTransport = resolve })
  adapter.setTransport(pending)

  let transportCalls = 0
  const bunFetch = async () => { transportCalls++; return stream() }
  resolveTransport(bunFetch)

  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.equal(transportCalls, 1, 'the resolved transport must be used')
  assert.equal(plainCalls, 0, 'the plain-fetch fallback must not be used')
})

test('a rejected transport falls back to plain fetch', async t => {
  let plainCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { plainCalls++; return stream() })

  const adapter = makeAdapter()
  adapter.setTransport(Promise.reject(new Error('no native binding')))
  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.equal(plainCalls, 1)
})

test('an explicit undefined transport uses plain fetch', async t => {
  let plainCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { plainCalls++; return stream() })

  const adapter = makeAdapter()
  adapter.setTransport(undefined)
  for await (const _ of adapter.stream(options)) { /* drain */ }
  assert.equal(plainCalls, 1)
})
