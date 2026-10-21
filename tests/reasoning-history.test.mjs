// Synthetic, offline protocol coverage only: no Host dispatch or real model reasoning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildChatMessages, planTools } from '../lib/opencode-protocol.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { PluginLogger } from '../lib/logger.js'

const callerRead = { name: 'read', description: 'Synthetic reader', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const callerOther = { ...callerRead, name: 'read_client' }
const text = value => ({ type: 'text', text: value })
const reasoning = value => ({ type: 'reasoning', text: value })
const call = (id = 'call-raw', name = 'read', args = '{ "file_path" : "fixture.txt" }\n') => ({ type: 'tool-call', id, name, arguments: args })
const assistant = content => ({ role: 'assistant', content })
const wire = (messages, tools = [callerRead], extra = {}) => buildChatMessages({ messages, ...extra }, planTools(tools))
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('text-only assistant explicitly replays empty reasoning and joins text with newlines', () => {
  assert.deepEqual(wire([assistant([text(' first '), text('second\n')])]), [
    { role: 'assistant', content: ' first \nsecond\n', reasoning_content: '' },
  ])
})
test('reasoning-only assistant preserves whitespace, Unicode and CRLF without a body', () => {
  assert.deepEqual(wire([assistant([reasoning(' \t思考🙂\r\n ')])]), [
    { role: 'assistant', content: null, reasoning_content: ' \t思考🙂\r\n ' },
  ])
})
test('tool-only assistant has explicit empty reasoning and null body', () => {
  const [message] = wire([assistant([call()])])
  assert.equal(message.reasoning_content, '')
  assert.equal(message.content, null)
  assert.equal(message.tool_calls.length, 1)
})
test('explicitly empty reasoning is retained as an own empty field', () => {
  const [message] = wire([assistant([reasoning(''), text('answer')])])
  assert.equal(own(message, 'reasoning_content'), true)
  assert.equal(message.reasoning_content, '')
  assert.equal(message.content, 'answer')
})
test('empty assistant remains an assistant with null body and explicit empty reasoning', () => {
  assert.deepEqual(wire([assistant([])]), [{ role: 'assistant', content: null, reasoning_content: '' }])
})
test('body still uses join-newline-or-null rather than trimming', () => {
  const messages = wire([assistant([text('')]), assistant([text(''), text('')]), assistant([text('  ')])])
  assert.deepEqual(messages.map(m => m.content), [null, '\n', '  '])
  assert.deepEqual(messages.map(m => m.reasoning_content), ['', '', ''])
})
test('mixed reasoning, text and tools preserve block order and all original string bytes', () => {
  const argsA = ' { "file_path" : "a\\\\b.txt", "n":1e+2 }\r\n'
  const argsB = '{"file_path":"二.txt","escaped":"\\u0041"} '
  const [message] = wire([assistant([
    reasoning(' \r\nR1'), text('T1\n'), call('id-一', 'read', argsA), reasoning(''),
    reasoning('\tR2🙂'), text(' T2 '), call('id-二', 'read', argsB), reasoning('\nEND '),
  ])])
  assert.deepEqual(message, {
    role: 'assistant', content: 'T1\n\n T2 ', reasoning_content: ' \r\nR1\tR2🙂\nEND ',
    tool_calls: [
      { id: 'id-一', type: 'function', function: { name: 'read_client', arguments: argsA } },
      { id: 'id-二', type: 'function', function: { name: 'read_client', arguments: argsB } },
    ],
  })
})
test('each assistant owns its reasoning field without borrowing adjacent history', () => {
  const messages = wire([assistant([reasoning('A')]), { role: 'user', content: [text('next')] }, assistant([text('plain')]), assistant([reasoning('B'), reasoning('C')]), assistant([])])
  assert.deepEqual(messages.filter(m => m.role === 'assistant').map(m => m.reasoning_content), ['A', '', 'BC', ''])
  for (const message of messages.filter(m => m.role === 'assistant')) assert.equal(own(message, 'reasoning_content'), true)
})
test('non-assistant roles never acquire reasoning_content and developer is still omitted', () => {
  const messages = wire([
    { role: 'system', content: [text('system'), reasoning('system-note')] },
    { role: 'developer', content: [text('not projected')] },
    { role: 'user', content: [text('user'), reasoning('not replayed')] },
    { role: 'tool', toolCallId: 'c1', content: [text('tool'), reasoning('tool-note')] },
  ], [], { system: 'top system' })
  assert.deepEqual(messages, [
    { role: 'system', content: 'top system' },
    { role: 'system', content: 'system\nsystem-note' },
    { role: 'user', content: 'user' },
    { role: 'tool', tool_call_id: 'c1', content: 'tool\ntool-note' },
  ])
  for (const message of messages) assert.equal(own(message, 'reasoning_content'), false)
})
test('deep-frozen options, blocks and caller schemas are not mutated', () => {
  const options = deepFreeze({ system: 'fixed', tools: [structuredClone(callerRead)], messages: [assistant([reasoning(' r '), text('body'), call()]), { role: 'tool', toolCallId: 'call-raw', content: [text('result')] }] })
  const before = structuredClone(options)
  const plan = planTools(options.tools)
  const aliasesBefore = [...plan.aliasToOriginal]
  assert.doesNotThrow(() => buildChatMessages(options, plan))
  assert.deepEqual(options, before)
  assert.deepEqual([...plan.aliasToOriginal], aliasesBefore)
})
test('read history uses read_client while preserving id and arguments', () => {
  const original = call('unaltered/id', 'read', '\n{ "file_path":"a", "value": 1.00 }\t')
  const [message] = wire([assistant([reasoning('r'), original])])
  assert.deepEqual(message.tool_calls[0], { id: original.id, type: 'function', function: { name: 'read_client', arguments: original.arguments } })
})
test('read_client collisions replay distinct caller names in either declaration order', () => {
  for (const tools of [[callerRead, callerOther], [callerOther, callerRead]]) {
    const [message] = wire([assistant([reasoning('r'), call('a', 'read'), call('b', 'read_client')])], tools)
    assert.deepEqual(message.tool_calls.map(c => c.function.name), ['read_client2', 'read_client'])
    assert.deepEqual(message.tool_calls.map(c => c.id), ['a', 'b'])
    assert.equal(message.reasoning_content, 'r')
  }
})
test('multiple calls and matching tool_call_id values retain exact ordering and result bytes', () => {
  const a = call('id A/🙂', 'read', ' {"file_path":"a"}\n')
  const b = call('id B:2', 'read', '\t{"file_path":"b"} ')
  const messages = wire([assistant([a, reasoning('R'), b]), { role: 'tool', toolCallId: a.id, content: [text(' result A\r\n')] }, { role: 'tool', toolCallId: b.id, content: [text('result B ')] }])
  assert.deepEqual(messages[0].tool_calls.map(c => [c.id, c.function.arguments]), [[a.id, a.arguments], [b.id, b.arguments]])
  assert.deepEqual(messages.slice(1), [{ role: 'tool', tool_call_id: a.id, content: ' result A\r\n' }, { role: 'tool', tool_call_id: b.id, content: 'result B ' }])
})
test('history projection never parses or reserializes original arguments', () => {
  const raw = '{ intentionally incomplete historical bytes\r\n'
  const [message] = wire([assistant([reasoning('r'), call('historical', 'read', raw)])])
  assert.equal(message.tool_calls[0].function.arguments, raw)
})

const REASON_SENTINEL = 'SYNTHETIC_REASONING_SENTINEL_思考🙂'
const RESULT_SENTINEL = 'SYNTHETIC_TOOL_RESULT_SENTINEL_结果'
const fragments = [' \r\n', REASON_SENTINEL, '\tfinal fragment\n ']
const rawArguments = '\n{ "file_path" : "synthetic\\\\fixture.txt" }\t'
const callId = 'synthetic-call/原始-42'
const baseOptions = { provider: 'opencode-bridge', model: 'synthetic-free', sessionId: 'synthetic-session', messages: [{ role: 'user', content: [text('synthetic request')] }], tools: [callerRead] }
const model = { id: 'synthetic-free', name: 'Synthetic offline', efforts: [{ id: 'high', name: 'High' }] }
const delta = value => ({ choices: [{ delta: value }] })
const finish = reason => ({ choices: [{ delta: {}, finish_reason: reason }] })
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n')
  let index = 0
  // Deliberately split UTF-8 and SSE line boundaries, not only JSON fragments.
  return new Response(new ReadableStream({ pull(controller) {
    if (index === bytes.length) controller.close()
    else { const end = Math.min(index + 7, bytes.length); controller.enqueue(bytes.slice(index, end)); index = end }
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
function makeAdapter(logger, meta = model) {
  return new OpenCodeFreeAdapter({ list: async () => [meta] }, {
    providerRoute: 'opencode-bridge', recipe: { baseUrl: 'https://offline.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} },
    requestTimeoutMs: 5000, toolFingerprint: true, toolTranslation: true, logger,
  })
}
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}
async function twoSteps(t, { withReasoning = true, logger, effort = 'high', meta = model } = {}) {
  const posts = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://offline.invalid/v1/chat/completions')
    assert.equal(init.method, 'POST')
    posts.push(JSON.parse(init.body))
    assert.ok(posts.length <= 2, 'unexpected extra request')
    if (posts.length === 2) return sse([delta({ content: 'OK' }), finish('stop')])
    return sse([
      ...(withReasoning ? [delta({ reasoning_content: fragments[0] }), delta({ reasoning_content: fragments[1] }), delta({ content: 'before tool' }), delta({ reasoning_content: fragments[2] })] : []),
      delta({ tool_calls: [{ index: 0, id: callId, function: { name: 'read_', arguments: rawArguments.slice(0, 9) } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'client', arguments: rawArguments.slice(9) } }] }), finish('tool_calls'),
    ])
  })
  const adapter = makeAdapter(logger, meta)
  const input = { ...baseOptions, ...(effort ? { reasoningEffort: effort } : {}) }
  const first = await collect(adapter, input)
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  // Assemble only completed DSH blocks, as the caller would; no invented reasoning.
  const content = first.filter(c => c.type === 'block-end').map(c => c.block)
  const tool = content.find(b => b.type === 'tool-call')
  assert.deepEqual(tool, call(callId, 'read', rawArguments))
  const history = [...input.messages, assistant(content), { role: 'tool', toolCallId: tool.id, content: [text(RESULT_SENTINEL)] }]
  const second = await collect(adapter, { ...input, messages: history })
  assert.equal(posts.length, 2)
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.deepEqual(second.filter(c => c.type === 'block-end').map(c => c.block), [text('OK')])
  const replay = posts[1].messages.find(m => m.role === 'assistant')
  assert.equal(own(replay, 'reasoning_content'), true)
  assert.equal(replay.reasoning_content, withReasoning ? fragments.join('') : '')
  assert.equal(replay.content, withReasoning ? 'before tool' : null)
  assert.deepEqual(replay.tool_calls, [{ id: callId, type: 'function', function: { name: 'read_client', arguments: rawArguments } }])
  assert.deepEqual(posts[1].messages.find(m => m.role === 'tool'), { role: 'tool', tool_call_id: callId, content: RESULT_SENTINEL })
  for (const post of posts) {
    assert.equal(post.tools.some(t => t.function.name === 'read_client'), true)
    for (const message of post.messages.filter(m => m.role !== 'assistant')) assert.equal(own(message, 'reasoning_content'), false)
  }
  return { posts, first }
}

test('two-step high-effort fake SSE replays completed reasoning fragments, alias, id and raw arguments', async t => {
  const { posts, first } = await twoSteps(t)
  assert.deepEqual(first.filter(c => c.type === 'reasoning-delta').map(c => c.text), fragments)
  assert.deepEqual(first.filter(c => c.type === 'block-end' && c.block.type === 'reasoning').map(c => c.block.text), [fragments[0] + fragments[1], fragments[2]])
  assert.deepEqual(posts.map(p => p.reasoning_effort), ['high', 'high'])
})
test('two-step high-effort tool call without incoming reasoning replays an explicit empty field', async t => {
  const { posts, first } = await twoSteps(t, { withReasoning: false })
  assert.equal(first.some(c => c.type === 'reasoning-delta'), false)
  assert.deepEqual(posts.map(p => p.reasoning_effort), ['high', 'high'])
})
test('ordinary non-thinking history still sends empty reasoning without reasoning_effort', async t => {
  const { posts } = await twoSteps(t, { withReasoning: false, effort: null })
  for (const post of posts) assert.equal(own(post, 'reasoning_effort'), false)
  assert.equal(posts[1].messages.find(m => m.role === 'assistant').reasoning_content, '')
})
test('unsupported effort is omitted while synthetic reasoning history is still replayed', async t => {
  const { posts } = await twoSteps(t, { effort: 'high', meta: { id: model.id, name: model.name } })
  for (const post of posts) assert.equal(own(post, 'reasoning_effort'), false)
})

for (const level of ['debug', 'info', 'warn', 'error', 'off']) {
  test(`logs at ${level} never include synthetic reasoning or tool result contents`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-history-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const mirrored = []
    const logger = new PluginLogger({ level, dir, maxBytes: 65536, maxFiles: 1, mirror: line => mirrored.push(line) })
    // Capture every call before logger filtering/redaction as well as persisted lines.
    const rawLogs = []
    const observedLogger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(method => [method, (...args) => { rawLogs.push({ method, args }); logger[method](...args) }]))
    const { posts } = await twoSteps(t, { logger: observedLogger })
    assert.ok(JSON.stringify(posts[1]).includes(REASON_SENTINEL))
    assert.ok(JSON.stringify(posts[1]).includes(RESULT_SENTINEL))
    const history = { ...baseOptions, messages: [assistant([reasoning(REASON_SENTINEL)]), { role: 'tool', toolCallId: callId, content: [text(RESULT_SENTINEL)] }] }
    t.mock.method(globalThis, 'fetch', async () => sse([{ error: { message: REASON_SENTINEL + RESULT_SENTINEL } }]))
    assert.equal((await collect(makeAdapter(observedLogger), history)).at(-1).reason.kind, 'error')
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: REASON_SENTINEL + RESULT_SENTINEL } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    assert.equal((await collect(makeAdapter(observedLogger), history)).at(-1).reason.kind, 'error')
    assert.deepEqual(new Set(rawLogs.map(entry => entry.method)), new Set(['debug', 'info', 'warn', 'error']))
    for (const output of [JSON.stringify(rawLogs), logger.read({ limit: 5000 }).lines.join('\n'), mirrored.join('\n')]) {
      assert.equal(output.includes(REASON_SENTINEL), false)
      assert.equal(output.includes(RESULT_SENTINEL), false)
      assert.equal(output.includes('final fragment'), false)
    }
    if (level === 'off') assert.deepEqual(logger.read().lines, [])
    else assert.ok(logger.read().lines.length > 0)
  })
}
