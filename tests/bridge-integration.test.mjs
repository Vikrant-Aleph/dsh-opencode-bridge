// Adapter wire behaviour under the simplified design: the declared tool list is
// exactly the caller's tools, and a returned call keeps its own name and
// argument bytes. DSH itself owns name lookup and argument parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { planTools, normalizeToolCall, buildChatMessages } from '../lib/opencode-protocol.js'

const str = { type: 'string' }
const read = { name: 'read', description: 'Read text', parameters: { type: 'object', properties: { file_path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['file_path'], additionalProperties: false } }
const pwsh = { name: 'pwsh', description: 'PowerShell only', parameters: { type: 'object', properties: { command: str, description: str }, required: ['command', 'description'] } }
const recipe = { baseUrl: 'https://example.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }
const options = { provider: 'opencode-bridge', model: 'fake-free', messages: [], tools: [read, pwsh] }

function response(calls, finish = 'tool_calls') {
  const events = calls.map((call, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: call.arguments } }] } }] }))
  if (finish !== null) events.push({ choices: [{ delta: {}, finish_reason: finish }] })
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')
}
async function run(t, calls, config = {}, input = {}, finish = 'tool_calls') {
  let sent
  const logs = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent = JSON.parse(init.body); return response(calls, finish) })
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push(args)]))
  const adapter = new OpenCodeFreeAdapter({ list: async () => [{ id: 'fake-free', name: 'Fake' }] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000, logger, ...config,
  })
  const chunks = []
  for await (const chunk of adapter.stream({ ...options, ...input })) chunks.push(chunk)
  return { chunks, sent, logs, terminal: chunks.at(-1) }
}
const toolChunks = chunks => chunks.filter(c => c.type === 'tool-call-delta' || (c.type === 'block-start' && c.blockType === 'tool-call') || (c.type === 'block-end' && c.block.type === 'tool-call'))

test('declarations are exactly the caller tools, order preserved', () => {
  const p = planTools([read, pwsh])
  assert.deepEqual(p.tools.map(t => t.function.name), ['read', 'pwsh'])
  assert.deepEqual(p.callerNames, new Set(['read', 'pwsh']))
  assert.deepEqual(p.tools.find(t => t.function.name === 'read').function.parameters, read.parameters)
})
test('duplicate caller names are rejected', () => {
  assert.throws(() => planTools([read, read]), /Duplicate caller tool names/)
})
test('a caller tool named shell is declared as-is and stays native', () => {
  const shell = { name: 'shell', description: 'Run a shell', parameters: { type: 'object', properties: { command: str }, required: ['command'] } }
  const p = planTools([shell])
  // A caller tool satisfies the gateway's "at least one tool" requirement by
  // itself, so no decoy is added.
  assert.deepEqual(p.tools.map(t => t.function.name), ['shell'])
  assert.equal(p.readAnchor, false)
  const call = { id: 'x', name: 'shell', arguments: '{"command":"echo test"}' }
  assert.equal(normalizeToolCall(call).name, 'shell')
})
test('a placeholder is declared only when the caller declares no tools', () => {
  // Any tool name satisfies the gateway, so the caller's own tools are enough.
  assert.equal(planTools([pwsh]).readAnchor, false)
  assert.deepEqual(planTools([pwsh]).tools.map(t => t.function.name), ['pwsh'])
  // With no caller tools at all, one placeholder is required: an empty list is
  // refused (research/any-tool-vs-read.json).
  const empty = planTools([])
  assert.deepEqual(empty.tools.map(t => t.function.name), ['read'])
  assert.equal(empty.readAnchor, true)
})
test('a call to the placeholder is dropped, not dispatched and not fatal', async t => {
  // No caller tools, so the placeholder is the only declaration the model saw.
  const out = await run(t, [{ name: 'read', arguments: '{"path":"secret.txt"}' }], {}, { tools: [] })
  // The call never becomes a dispatchable tool block...
  assert.equal(out.chunks.some(c => c.type === 'block-end' && c.block.type === 'tool-call'), false)
  // ...and the turn still ends normally rather than failing.
  assert.equal(out.terminal.reason.kind, 'stop')
  assert.doesNotMatch(JSON.stringify(out.chunks), /secret\.txt/)
})
test('normalizeToolCall preserves id, name and raw argument bytes', () => {
  const raw = '  { "file_path" : "a\\\\b", "n": 1e+2 }\r\n'
  const call = { id: 'call/一', name: 'read', arguments: raw }
  assert.deepEqual(normalizeToolCall(call), call)
})
test('history replays the caller name used by the request', () => {
  const p = planTools([read, pwsh])
  const messages = buildChatMessages({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{"file_path":"a"}' }] }] }, p)
  assert.equal(messages[0].tool_calls[0].function.name, 'read')
})
test('a returned call is emitted unchanged for DSH to resolve', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"file_path":"fixture.txt","offset":2}' }])
  const block = out.chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block
  assert.equal(block.name, 'read')
  assert.deepEqual(JSON.parse(block.arguments), { file_path: 'fixture.txt', offset: 2 })
  assert.equal(out.terminal.reason.kind, 'tool-calls')
})
test('the declared tool list is exactly what DSH can execute', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"file_path":"fixture.txt"}' }])
  assert.deepEqual(out.sent.tools.map(t => t.function.name), ['read', 'pwsh'])
  assert.equal(out.terminal.reason.kind, 'tool-calls')
})
test('an unknown name is passed through, not invented into authority', async t => {
  // The bridge no longer filters names: DSH rejects a tool it never declared.
  const out = await run(t, [{ name: 'invented_executor', arguments: '{}' }])
  const block = out.chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(block.block.name, 'invented_executor')
  assert.ok(!out.sent.tools.some(t => t.function.name === 'invented_executor'))
})
test('auxiliary requests still carry the anchor, because zero tools is refused', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"file_path":"fixture.txt"}' }], {}, { purpose: 'title' })
  assert.deepEqual(out.sent.tools.map(t => t.function.name), ['read'])
})
for (const finish of [null, 'length', 'stop']) {
  test(`incomplete tool batch (${finish}) is never dispatched`, async t => {
    const out = await run(t, [{ name: 'pwsh', arguments: '{"command":"SECRET_INCOMPLETE"}' }], {}, {}, finish)
    assert.equal(toolChunks(out.chunks).length, 0)
    assert.equal(out.terminal.reason.failure.code, 'TOOL_BRIDGE_INCOMPLETE')
    assert.doesNotMatch(JSON.stringify(out.chunks), /SECRET/)
  })
}
