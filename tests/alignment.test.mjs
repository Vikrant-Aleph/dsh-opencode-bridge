// Offline coverage for the 2026-11-12 alignment with OpenCode 2.x OpenAI Chat lowering.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { buildChatMessages, buildHeaders, planTools, requiresReasoningReplay } from '../lib/opencode-protocol.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'

const callerRead = { name: 'read', description: 'Synthetic reader', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const text = value => ({ type: 'text', text: value })
const assistant = content => ({ role: 'assistant', content })
const recipe = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'public', userAgent: DEFAULT_PROTOCOL_USER_AGENT, client: 'opencode', project: 'global', extraHeaders: {} }

test('2.x headers omit x-opencode-request unless the 1.x compat flag is set', () => {
  const modern = buildHeaders(recipe, 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'msg_bbbbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(Object.hasOwn(modern, 'x-opencode-request'), false)
  assert.equal(modern['x-opencode-client'], 'opencode')
  assert.equal(modern['x-opencode-session'], modern['x-session-affinity'])
  const legacy = buildHeaders(recipe, 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'msg_bbbbbbbbbbbbbbbbbbbbbbbbbb', { requestIdHeader: true })
  assert.equal(legacy['x-opencode-request'], 'msg_bbbbbbbbbbbbbbbbbbbbbbbbbb')
})

test('the declared tool set is exactly the caller tools, with strict:false', () => {
  const plan = planTools([callerRead], { strict: true })
  // Tool lists are user-configurable upstream, so the bridge declares only what
  // DSH can actually execute. See CAMOUFLAGE.us.md.
  assert.deepEqual(plan.tools.map(t => t.function.name), ['read'])
  for (const tool of plan.tools) assert.equal(tool.function.strict, false)
  assert.deepEqual(plan.tools[0].function.parameters, callerRead.parameters)
  const plain = planTools([callerRead], { strict: false })
  assert.equal(Object.hasOwn(plain.tools[0].function, 'strict'), false)
})

test('assistant text joins without separators and null content only with tool calls', () => {
  const plan = planTools([])
  const messages = buildChatMessages({ messages: [assistant([text('a'), text('b')])] }, plan)
  assert.equal(messages[0].content, 'ab')
  const toolOnly = buildChatMessages({ messages: [assistant([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }])] }, planTools([{ ...callerRead, name: 'read_client' }]))
  assert.equal(toolOnly[0].content, null)
})

test('reasoning_content is optional unless the model requires it', () => {
  const plan = planTools([])
  const history = [assistant([text('plain answer')])]
  assert.equal(Object.hasOwn(buildChatMessages({ messages: history }, plan)[0], 'reasoning_content'), false)
  const required = buildChatMessages({ messages: history }, plan, undefined, { requireReasoning: true })
  assert.equal(required[0].reasoning_content, '')
  const present = buildChatMessages({ messages: [assistant([{ type: 'reasoning', text: 'thought' }, text('x')])] }, plan)
  assert.equal(present[0].reasoning_content, 'thought')
})

test('requiresReasoningReplay mirrors the DeepSeek-only default', () => {
  assert.equal(requiresReasoningReplay({ id: 'deepseek-v4.1-flash-free' }, 'deepseek-v4.1-flash-free', 'https://opencode.ai/inference/v1'), true)
  assert.equal(requiresReasoningReplay({ id: 'glm-5.3-flash-free' }, 'glm-5.3-flash-free', 'https://opencode.ai/inference/v1'), false)
  assert.equal(requiresReasoningReplay(undefined, 'other-free', 'https://api.deepseek.com/v1'), true)
})

test('empty tool result is sent as an empty string, not a placeholder', () => {
  const plan = planTools([callerRead])
  const messages = buildChatMessages({ messages: [{ role: 'tool', toolCallId: 'c1', content: [] }] }, plan)
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: '' }])
})

test('adapter honours requestIdHeader and toolStrict options on the wire', async t => {
  let headers, body
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    headers = init.headers
    body = JSON.parse(init.body)
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const adapter = (extra) => new OpenCodeFreeAdapter({ list: async () => [] }, {
    providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 1000, ...extra,
  })
  const input = { provider: 'opencode-bridge', model: 'fixture-free', sessionId: 's', maxTokens: 16, tools: [callerRead], messages: [{ role: 'user', content: [text('hi')] }] }
  const drain = async (a) => { for await (const _ of a.stream(input)) { /* consume */ } }
  await drain(adapter({}))
  assert.equal(Object.hasOwn(headers, 'x-opencode-request'), false)
  assert.equal(body.tools.find(t => t.function.name === 'read').function.strict, false)
  await drain(adapter({ requestIdHeader: true, toolStrict: false }))
  assert.match(headers['x-opencode-request'], /^msg_/)
  assert.equal(Object.hasOwn(body.tools.find(t => t.function.name === 'read').function, 'strict'), false)
})
