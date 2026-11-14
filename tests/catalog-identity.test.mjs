import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreeModelCatalog } from '../lib/catalog.js'
import { buildHeaders, mintRequestId, mintSessionId, SESSION_ID_RE } from '../lib/opencode-protocol.js'

/**
 * The live model listing is served by the same gateway as inference, so it must carry
 * the same identity. A bare `user-agent` probe is a shape the official client never
 * sends, and polling it every minute invites the gateway to throttle the egress.
 */
const recipe = {
  baseUrl: 'https://opencode.ai/inference/v1',
  apiKey: 'public',
  userAgent: 'opencode/latest/2.2.0/cli',
  client: 'cli',
  project: 'abc123def456',
  extraHeaders: {},
}

function withStubbedFetch(t) {
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: { ...(init.headers ?? {}) } })
    if (String(url).includes('models.dev')) {
      return new Response(JSON.stringify({ opencode: { models: {} } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: [{ id: 'glm-5.3-flash-free' }] }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = real })
  return seen
}

test('the live model listing carries the same identity headers as inference', async (t) => {
  const seen = withStubbedFetch(t)
  const catalog = new FreeModelCatalog('https://opencode.ai/inference/v1', {
    includeDeprecated: false,
    extraModels: [],
    refreshIntervalMs: 0,
    liveHeaders: () => buildHeaders(recipe, mintSessionId(), mintRequestId(), { tracing: true }),
  })
  t.after(() => catalog.dispose())
  await catalog.refresh()

  const live = seen.find((entry) => entry.url.endsWith('/models'))
  assert.ok(live, 'the live listing must be requested')
  assert.equal(live.headers.authorization, 'Bearer public')
  assert.equal(live.headers['user-agent'], 'opencode/latest/2.2.0/cli')
  assert.equal(live.headers['x-opencode-client'], 'cli')
  assert.equal(live.headers['x-opencode-project'], 'abc123def456')
  assert.match(String(live.headers['x-opencode-session']), SESSION_ID_RE)
})

test('a failing header builder falls back to the minimal shape instead of breaking the listing', async (t) => {
  const seen = withStubbedFetch(t)
  const catalog = new FreeModelCatalog('https://opencode.ai/inference/v1', {
    includeDeprecated: false,
    extraModels: [],
    refreshIntervalMs: 0,
    liveHeaders: () => { throw new Error('identity unavailable') },
  })
  t.after(() => catalog.dispose())
  const models = await catalog.refresh()

  assert.equal(models.length, 1, 'the listing still resolves')
  const live = seen.find((entry) => entry.url.endsWith('/models'))
  assert.equal(live.headers['user-agent'], 'opencode/latest/2.2.0/cli')
  assert.equal(live.headers.authorization, undefined)
})
