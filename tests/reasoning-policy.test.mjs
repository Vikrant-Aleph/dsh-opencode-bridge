import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { buildChatMessages, planTools } from '../lib/opencode-protocol.js'
import { initialCompletedReasoningState, reduceCompletedReasoning, trimCompletedReasoning, reasoningFingerprint, completedReasoningForRequest, completedReasoningProjection, completedReasoningStateSchema } from '../lib/reasoning-policy.js'

const thought = text => ({ type: 'reasoning', text })
const text = text => ({ type: 'text', text })
const call = id => ({ type: 'tool-call', id, name: 'read', arguments: '{}' })
const assistant = (id, content) => ({ id, role: 'assistant', source: { kind: 'model', provider: 'offline', model: 'fixture' }, content })
const start = turn => ({ type: 'turn/start', data: { turn } })
const message = (turn, value, extra = {}) => ({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: value, ...extra } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const result = (turn, id) => ({ type: 'tool/result', data: { turn, step: 1, message: { role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, id: `result-${id}`, content: [text('fixed tool data')] } } })
const old = assistant('old', [thought('SYNTHETIC_PRIVATE_OLD'), text('answer')])
const current = assistant('current', [thought('SYNTHETIC_CURRENT'), call('call-A')])
const fold = events => events.reduce(reduceCompletedReasoning, initialCompletedReasoningState())
const completed = () => fold([start(1), message(1, old), end(1)])

 test('only an explicit completed canonical turn with a final assistant authorizes trimming', () => {
  const state = completed()
  assert.equal(state.completed.length, 1)
  const out = trimCompletedReasoning([old, current], state.completed)
  assert.equal(out.trimmedMessages, 1)
  assert.equal(out.messages[0].content.length, 1)
  assert.equal(out.messages[1], current)
  assert.equal(old.content[0].text, 'SYNTHETIC_PRIVATE_OLD')
  assert.equal(JSON.stringify(state).includes('SYNTHETIC'), false)
})
for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'forked']) test(`turn/end ${kind} never makes reasoning eligible`, () => {
  const state = fold([start(1), message(1, old), end(1, kind)])
  assert.equal(state.completed.length, 0)
  assert.equal(trimCompletedReasoning([old], state.completed).messages[0], old)
})
test('a new user/context/goal message cannot complete a turn or trim the active tool chain', () => {
  const state = fold([start(1), message(1, current), { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [text('new user')] } }, { type: 'user/message', data: { role: 'user', source: { kind: 'relay' }, content: [text('context')] } }])
  assert.equal(state.completed.length, 0)
  assert.deepEqual(state.tools, ['call-A'])
})
test('unresolved calls or no final assistant keep the entire prior chain intact', () => {
  for (const events of [[start(1), message(1, current), end(1)], [start(1), message(1, current), result(1, 'call-A'), end(1)]]) assert.equal(fold(events).completed.length, 0)
})
test('complete multi-tool chain is eligible only after all results, final response and turn/end', () => {
  const m = assistant('tools', [thought('fixture thoughts'), call('A'), call('B')])
  const state = fold([start(1), message(1, m), result(1, 'B'), result(1, 'A'), message(1, old), end(1)])
  assert.deepEqual(state.completed.map(x => x.id), ['tools', 'old'])
})
test('interrupted assistant or a replacement in the active turn conservatively blocks trimming', () => {
  for (const event of [message(1, old, { interrupted: true }), { ...message(1, old), surfaceOp: { type: 'replace', from: 0, to: 1 } }]) {
    assert.equal(fold([start(1), message(1, assistant('early', [thought('fixture')])), event, message(1, old), end(1)]).completed.length, 0)
  }
})
test('seed boundary preserves completed records but abandons inherited unfinished state', () => {
  const state = [start(2), message(2, current), { type: 'session/end-seed', data: {} }, end(2)].reduce(reduceCompletedReasoning, completed())
  assert.deepEqual(state.completed.map(x => x.id), ['old'])
  assert.equal(state.activeTurn, -1)
})
test('reused IDs and changed reasoning content cannot strip active or rewritten content', () => {
  const again = assistant('old', [thought('SYNTHETIC_PRIVATE_OLD'), call('later')])
  const state = [start(2), message(2, again)].reduce(reduceCompletedReasoning, completed())
  assert.equal(state.completed.length, 0)
  assert.equal(trimCompletedReasoning([assistant('old', [thought('rewritten')])], completed().completed).trimmedMessages, 0)
})
test('only reasoning is projected: text, tool arguments, aliases, images and replay state remain', () => {
  const m = assistant('mixed', [thought(' A\r\n'), text('visible'), thought('B '), call('tool-x'), { type: 'image', attachment: { attachmentId: 'fixture' } }])
  m.source.replayState = { opaque: 'untouched' }
  const records = [{ id: m.id, hash: reasoningFingerprint(m.content) }]
  const projected = trimCompletedReasoning([m], records).messages[0]
  assert.deepEqual(projected.content, m.content.filter(x => x.type !== 'reasoning'))
  assert.equal(projected.source, m.source)
  const wire = buildChatMessages({ messages: [projected] }, planTools([{ name: 'read', description: 'fixture', parameters: { type: 'object' } }]))
  assert.equal(wire[0].reasoning_content, '')
  assert.equal(wire[0].tool_calls[0].id, 'tool-x')
  assert.equal(wire[0].tool_calls[0].function.arguments, '{}')
})
test('full/unknown/auxiliary paths preserve identity and never guess from message order', () => {
  assert.equal(trimCompletedReasoning([old]).trimmedMessages, 0)
  assert.equal(completedReasoningForRequest({ get() { throw Error('missing') } }, { sessionId: 's' }), undefined)
  assert.equal(completedReasoningForRequest({}, { sessionId: 's', purpose: 'compaction' }), undefined)
  assert.equal(completedReasoningForRequest({}, {}), undefined)
})
test('official agent session lookup requires matching identity and registered host-only state', () => {
  const session = { id: 's' }, state = completed(), calls = []
  const ctx = { get(key) { return key === 'agents' ? { get(id) { assert.equal(id, 's'); return { session } } } : { stateOf(s, key) { calls.push(key); assert.equal(s, session); return state } } } }
  assert.equal(completedReasoningForRequest(ctx, { sessionId: 's' }), state.completed)
  assert.deepEqual(calls, ['opencodeBridgeCompletedReasoning'])
  assert.equal(completedReasoningProjection.wire, undefined)
  assert.equal(completedReasoningStateSchema.safeParse(state).success, true)
})
test('projection state is bounded and serializable without thoughts', () => {
  let state = initialCompletedReasoningState()
  for (let i = 0; i < 8200; i++) state = [start(i), message(i, assistant(`m-${i}`, [thought('private fixture')])), end(i)].reduce(reduceCompletedReasoning, state)
  assert.equal(state.completed.length, 8192)
  assert.equal(state.completed[0].id, 'm-8')
  assert.equal(completedReasoningStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success, true)
  assert.equal(JSON.stringify(state).includes('private fixture'), false)
})
test('active pending overflow is conservative and never grants partial eligibility', () => {
  let state = reduceCompletedReasoning(initialCompletedReasoningState(), start(1))
  for (let i = 0; i < 515; i++) state = reduceCompletedReasoning(state, message(1, assistant(`p-${i}`, [thought('fixture')])))
  state = reduceCompletedReasoning(state, end(1))
  assert.equal(state.completed.length, 0)
})
test('adapter defaults to full and snapshots trimming once without deleting original history', async t => {
  const posts = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { posts.push(JSON.parse(init.body)); return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
  let enabled = false, reads = 0
  const a = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: 'offline', recipe: { baseUrl: 'https://offline.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }, requestTimeoutMs: 1000, toolFingerprint: false, toolTranslation: true, getCompletedReasoning() { reads++; return enabled ? completed().completed : undefined } })
  const options = { provider: 'offline', model: 'fixture', messages: [old, current], tools: [] }
  for await (const _ of a.stream(options)) {}
  enabled = true
  for await (const _ of a.stream(options)) {}
  assert.equal(posts[0].messages[0].reasoning_content, 'SYNTHETIC_PRIVATE_OLD')
  assert.equal(posts[1].messages[0].reasoning_content, '')
  assert.equal(posts[1].messages[1].reasoning_content, 'SYNTHETIC_CURRENT')
  assert.equal(old.content[0].type, 'reasoning')
  assert.equal(reads, 2)
  for await (const _ of a.stream({ ...options, purpose: 'session-title' })) {}
  assert.equal(reads, 2)
  assert.equal(posts[2].messages[0].reasoning_content, 'SYNTHETIC_PRIVATE_OLD')
})
