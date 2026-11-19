import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { buildHeaders, SESSION_ID_RE } from '../lib/opencode-protocol.js'
import { createBunFetch, bunTransportAvailable } from '../lib/bun-transport.js'
import { summarizeWireRequest } from '../lib/request-diagnostics.js'

const recipe = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'public', userAgent: 'fixture', client: 'cli', project: 'global', extraHeaders: {} }
const own = 'x-opencode-session-id'
const parent = 'x-opencode-parent-session-id'
const otherParent = 'x-parent-session-id'
const aliases = ['x-opencode-session', 'x-session-affinity', 'x-session-id']
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

async function request(adapter, sessionId) {
  let finish
  for await (const chunk of adapter.stream({ provider: 'opencode-bridge', model: 'fixture', sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] }] })) {
    if (chunk.type === 'finish') finish = chunk.reason.kind
  }
  assert.equal(finish, 'stop')
}

test('six siblings have distinct own ids, share their direct parent affinity and never expose DSH ids', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `local-child-${i}`)
  const lineage = new Map(ids.map(id => [id, { parent: 'local-parent' }]))
  lineage.set('local-grandchild', { parent: ids[0], forkSource: 'local-parent' })
  lineage.set('local-fork', { forkSource: 'local-parent' })
  const received = new Map()
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 2000, getSessionLineage: id => lineage.get(id) })
  adapter.setTransport(async (_url, init) => {
    received.set(JSON.parse(init.body).messages.at(-1).content, new Headers(init.headers))
    return ok()
  })
  await Promise.all(ids.map(id => request(adapter, id)))
  await request(adapter, 'local-parent')
  await request(adapter, 'local-grandchild')
  await request(adapter, 'local-fork')
  const records = ids.map(id => received.get(id))
  const parentId = received.get('local-parent').get(own)
  assert.match(parentId, SESSION_ID_RE)
  assert.ok(!received.get('local-parent').has(parent))
  assert.equal(new Set(records.map(headers => headers.get(own))).size, 6)
  for (const headers of records) {
    assert.match(headers.get(own), SESSION_ID_RE)
    assert.notEqual(headers.get(own), parentId)
    for (const key of [parent, otherParent, ...aliases]) assert.equal(headers.get(key), parentId)
  }
  assert.equal(received.get('local-grandchild').get(parent), records[0].get(own))
  assert.equal(received.get('local-fork').get(aliases[0]), parentId)
  assert.ok(!received.get('local-fork').has(parent))
  const diagnostics = summarizeWireRequest({ endpoint: recipe.baseUrl, headers: Object.fromEntries(records[0]), configuredTransport: false, serializedBody: '{}' }).request
  assert.equal(diagnostics.hasParentSession, true)
  assert.equal(diagnostics.parentAffinityMatches, true)
  assert.equal(diagnostics.sessionAliasesEqual, false)
  assert.ok(!JSON.stringify(diagnostics).includes(parentId))
  const first = records[0].get(own)
  await request(adapter, ids[0])
  assert.equal(received.get(ids[0]).get(own), first)
})

test('native HTTP transport preserves both parent headers, without adding them to roots', async t => {
  if (!(await bunTransportAvailable())) return t.skip('native wreq is unavailable')
  const requests = []
  const server = createServer((req, res) => { requests.push(req.headers); req.resume(); res.end('ok') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const fetchImpl = await createBunFetch({ timeoutMs: 3000 })
  t.after(async () => { await fetchImpl.close?.() })
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const childOptions = { parentSessionId: 'encoded-parent' }
  for (const opts of [{}, childOptions]) {
    const response = await fetchImpl(endpoint, { method: 'POST', headers: buildHeaders(recipe, 'encoded-own', 'request', opts), body: '{}' })
    assert.equal(await response.text(), 'ok')
  }
  assert.equal(requests[0][parent], undefined)
  assert.equal(requests[1][own], 'encoded-own')
  for (const key of [parent, otherParent, ...aliases]) assert.equal(requests[1][key], 'encoded-parent')
})
