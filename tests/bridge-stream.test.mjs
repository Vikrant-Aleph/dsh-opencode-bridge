import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'

const callerRead = { name: 'read', description: 'Host text reader', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const callerPwsh = { name: 'pwsh', description: 'Host PowerShell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
const base = {
  providerRoute: 'opencode-bridge', recipe: { baseUrl: 'https://offline.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} },
  requestTimeoutMs: 5000,
}
const options = { provider: 'opencode-bridge', model: 'fixture-free', messages: [], tools: [callerRead, callerPwsh] }
const finish = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
function delta(index, name, args, id = `c${index}`) {
  return { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] }
}
async function collect(t, events, input = options) {
  let payload
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    payload = JSON.parse(init.body)
    // One byte per chunk also exercises arbitrary UTF-8 / line boundaries.
    const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n')
    let i = 0
    return new Response(new ReadableStream({ pull(controller) { if (i === bytes.length) controller.close(); else controller.enqueue(bytes.slice(i, ++i)) } }))
  })
  const adapter = new OpenCodeFreeAdapter({ list: async () => [] }, base)
  const chunks = []
  for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  return { chunks, payload }
}
const blocks = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)

test('fragmented names and UTF-8 arguments are assembled into one call', async t => {
  const { chunks } = await collect(t, [delta(0, 're', '{"file_path":'), delta(0, 'ad', '"测试.txt"}'), finish])
  assert.deepEqual(blocks(chunks).map(b => [b.name, JSON.parse(b.arguments)]), [['read', { file_path: '测试.txt' }]])
})
test('out-of-order wire slots still emit in slot order', async t => {
  const { chunks } = await collect(t, [delta(1, 'pwsh', '{"command":"b"}'), delta(0, 'read', '{"file_path":"a"}'), finish])
  assert.deepEqual(blocks(chunks).map(b => b.name), ['read', 'pwsh'])
})
test('a stream that ends before the tool batch is complete emits nothing', async t => {
  // No finish_reason: the batch never completed, so nothing may be dispatched.
  const { chunks } = await collect(t, [delta(0, 'pwsh', '{"command":"SECRET_COMMAND"}')])
  assert.equal(blocks(chunks).length, 0)
  assert.equal(chunks.at(-1).reason.failure.code, 'TOOL_BRIDGE_INCOMPLETE')
  assert.doesNotMatch(JSON.stringify(chunks), /SECRET/)
})
test('no tool guidance is injected: declarations speak for themselves', async t => {
  const { payload } = await collect(t, [finish])
  assert.deepEqual(payload.tools.map(t => t.function.name), ['read', 'pwsh'])
  assert.ok(!payload.messages.some(m => m.role === 'system' && /Tool bridge policy|caller alias/i.test(String(m.content ?? ''))))
})
