import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { environmentBlock, planTools, READ_ANCHOR } from '../lib/opencode-protocol.js'

/**
 * Behaviour of the two gateway requirements, exercised through the adapter so the
 * whole request path is covered:
 *   - at least one declared tool (a placeholder when the caller has none)
 *   - an <env> block in the system prompt
 */
const str = { type: 'string' }
const read = { name: 'read', description: 'Host text reader', parameters: { type: 'object', properties: { file_path: str }, required: ['file_path'], additionalProperties: false } }
const pwsh = { name: 'pwsh', description: 'Shell', parameters: { type: 'object', properties: { command: str }, required: ['command'] } }
const recipe = { baseUrl: 'https://example.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }

function response(calls, finish = 'tool_calls') {
  const events = calls.map((call, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: call.arguments } }] } }] }))
  if (finish !== null) events.push({ choices: [{ delta: {}, finish_reason: finish }] })
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')
}

async function run(t, calls, { config = {}, input = {}, finish = 'tool_calls', system = 'System prompt.' } = {}) {
  let sent
  t.mock.method(globalThis, 'fetch', async (_url, init) => { sent = JSON.parse(init.body); return response(calls, finish) })
  const adapter = new OpenCodeFreeAdapter({ list: async () => [{ id: 'fake-free', name: 'Fake' }] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 5000, ...config,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'opencode-bridge', model: 'fake-free', system,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [read, pwsh],
    ...input,
  })) chunks.push(chunk)
  return { chunks, sent, terminal: chunks.at(-1) }
}
const toolBlocks = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call')

test('the request carries an environment block after the system prompt', async t => {
  const { sent } = await run(t, [{ name: 'pwsh', arguments: '{"command":"echo"}' }])
  const system = sent.messages[0]
  assert.equal(system.role, 'system')
  assert.ok(system.content.startsWith('System prompt.'), 'the caller prompt must lead')
  assert.ok(system.content.includes('<env>'), 'the gateway requires the block')
  assert.ok(system.content.includes('</env>'))
  assert.ok(system.content.indexOf('<env>') > system.content.indexOf('System prompt.'))
})

test('a caller tool satisfies the gateway, so no placeholder is declared', async t => {
  const { sent } = await run(t, [{ name: 'pwsh', arguments: '{"command":"echo"}' }])
  assert.deepEqual(sent.tools.map(t => t.function.name), ['read', 'pwsh'])
  // The caller really has read and pwsh, so nothing here is a placeholder.
  assert.equal(planTools([read, pwsh]).readAnchor, false)
})

test('a real read tool call is dispatched normally, not dropped', async t => {
  const { chunks, terminal } = await run(t, [{ name: 'read', arguments: '{"file_path":"a.txt"}' }], { input: { tools: [read, pwsh] } })
  assert.equal(toolBlocks(chunks).length, 1)
  assert.equal(toolBlocks(chunks)[0].block.name, 'read')
  assert.equal(terminal.reason.kind, 'tool-calls')
})

test('with no caller tools a placeholder is declared', async t => {
  const { sent } = await run(t, [{ name: 'read', arguments: '{"path":"a.txt"}' }], { input: { tools: [] } })
  assert.deepEqual(sent.tools.map(t => t.function.name), ['read'])
  // ...and its description tells the model not to call it.
  assert.match(sent.tools[0].function.description, /Do not call this tool/i)
})

test('a placeholder call is dropped and the turn still ends normally', async t => {
  const { chunks, terminal } = await run(t, [{ name: 'read', arguments: '{"path":"a.txt"}' }], { input: { tools: [] } })
  assert.equal(toolBlocks(chunks).length, 0, 'a placeholder call must never become dispatchable')
  assert.equal(terminal.reason.kind, 'stop', 'the turn must not fail')
  assert.doesNotMatch(JSON.stringify(chunks), /a\.txt/)
})

test('an auxiliary request still carries the environment block and a tool', async t => {
  const { sent } = await run(t, [{ name: 'read', arguments: '{"path":"x"}' }], { input: { tools: [], purpose: 'title' } })
  assert.ok(sent.messages[0].content.includes('<env>'))
  assert.equal(sent.tools.length >= 1, true)
})

test('a caller prompt that already contains an env block still sends one block from us', async t => {
  const { sent } = await run(t, [{ name: 'pwsh', arguments: '{"command":"echo"}' }], {
    system: `Prompt.\n\n${environmentBlock('/somewhere', false, 'linux')}`,
  })
  // The bridge does not try to de-duplicate; the gateway only needs one present,
  // and rewriting the caller's prompt would be worse than a second block.
  assert.ok(sent.messages[0].content.includes('<env>'))
  assert.equal(sent.messages[0].role, 'system')
})

test('an empty caller prompt still yields the environment block', async t => {
  const { sent } = await run(t, [{ name: 'pwsh', arguments: '{"command":"echo"}' }], { system: '' })
  assert.equal(sent.messages[0].role, 'system')
  assert.ok(sent.messages[0].content.startsWith('<env>'))
  assert.ok(sent.messages[0].content.endsWith('</env>'))
})

test('the placeholder name is stable and reserved', () => {
  assert.equal(READ_ANCHOR.function.name, 'read')
  assert.equal(READ_ANCHOR.function.strict, false)
})
