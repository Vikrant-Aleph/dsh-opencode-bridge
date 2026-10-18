import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'

function adapter() {
  return new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-free', recipe: { baseUrl: 'https://offline.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} },
    requestTimeoutMs: 5000, toolFingerprint: true, toolTranslation: true,
  })
}
const native = { name: 'pwsh', description: 'Host PowerShell', parameters: { type: 'object' } }
const events = [
  { choices: [{ delta: { content: 'synthetic text' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'pwsh', arguments: '{"command":"never execute"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]
const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
const options = signal => ({ provider: 'opencode-free', model: 'fixture-free', messages: [], tools: [native], signal })

test('cancellation while parsing one buffered SSE chunk never releases buffered tool calls', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  const chunks = []
  for await (const chunk of adapter().stream(options(controller.signal))) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') controller.abort()
  }
  assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false)
  assert.equal(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'), false)
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})
test('cancellation after tool block-start cannot complete that block', async t => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  const chunks = []
  for await (const chunk of adapter().stream(options(controller.signal))) {
    chunks.push(chunk)
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') controller.abort()
  }
  assert.equal(chunks.some(c => c.type === 'tool-call-delta'), false)
  assert.equal(chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'), false)
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})
test('an already cancelled request performs no POST', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(body) })
  const chunks = []
  for await (const chunk of adapter().stream(options(AbortSignal.abort()))) chunks.push(chunk)
  assert.equal(calls, 0)
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})
