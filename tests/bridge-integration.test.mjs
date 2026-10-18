import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { planTools, normalizeToolCall, buildChatMessages, SHELL_TOOL } from '../lib/opencode-protocol.js'
import { createBridgeAuditTool } from '../lib/bridge-audit.js'

const str = { type: 'string' }
const read = { name: 'read', description: 'Read text', parameters: { type: 'object', properties: { file_path: str, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['file_path'], additionalProperties: false } }
const pwsh = { name: 'pwsh', description: 'PowerShell only', parameters: { type: 'object', properties: { command: str, description: str }, required: ['command', 'description'] } }
const recipe = { baseUrl: 'https://example.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }
const options = { provider: 'opencode-free', model: 'fake-free', messages: [], tools: [read, pwsh] }

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
    providerRoute: 'opencode-free', recipe, requestTimeoutMs: 5000, toolFingerprint: true, toolTranslation: true, logger, ...config,
  })
  const chunks = []
  for await (const chunk of adapter.stream({ ...options, ...input })) chunks.push(chunk)
  return { chunks, sent, logs, terminal: chunks.at(-1) }
}
const toolChunks = chunks => chunks.filter(c => c.type === 'tool-call-delta' || (c.type === 'block-start' && c.blockType === 'tool-call') || (c.type === 'block-end' && c.block.type === 'tool-call'))

test('alias allocation reserves future caller names and is collision-free in either order', () => {
  const blocker = { ...pwsh, name: 'read_client' }
  for (const tools of [[read, blocker], [blocker, read]]) {
    const p = planTools(tools)
    const names = p.tools.map(t => t.function.name)
    assert.equal(names.length, new Set(names).size)
    assert.equal(p.aliasToOriginal.get('read_client2'), 'read')
    assert.equal(normalizeToolCall({ id: 'x', name: 'read_client2', arguments: '{"file_path":"a"}' }, p).name, 'read')
  }
  assert.throws(() => planTools([read, read]), /Duplicate caller tool names/)
})
test('fingerprint=false preserves callers without aliases or decoys', () => {
  const p = planTools([read, pwsh], { fingerprint: false })
  assert.deepEqual(p.tools.map(t => t.function.name), ['read', 'pwsh'])
  assert.equal(p.aliasToOriginal.size, 0)
  assert.equal(p.decoys.size, 0)
})
test('a caller-owned canonical shell is not an injected executable decoy', () => {
  const p = planTools([{ name: 'shell', ...SHELL_TOOL }])
  assert.equal(p.decoys.has('shell'), false)
  const call = { id: 'x', name: 'shell', arguments: '{"command":"echo test"}' }
  assert.equal(normalizeToolCall(call, p), call)
})
test('history replays the same caller alias used by the request', () => {
  const p = planTools([read, { ...pwsh, name: 'read_client' }])
  const messages = buildChatMessages({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{"file_path":"a"}' }] }] }, p)
  assert.equal(messages[0].tool_calls[0].function.name, 'read_client2')
})
test('unsafe second tool rejects the entire batch without leaking arguments', async t => {
  const out = await run(t, [
    { name: 'pwsh', arguments: '{"command":"SECRET_COMMAND","description":"secret"}' },
    { name: 'shell', arguments: '{"command":"SECRET_OTHER","workdir":"SECRET_PATH"}' },
  ])
  assert.equal(toolChunks(out.chunks).length, 0)
  assert.equal(out.terminal.reason.kind, 'error')
  assert.equal(out.terminal.reason.failure.code, 'TOOL_BRIDGE_REJECTED')
  assert.match(out.terminal.reason.failure.message, /EXECUTABLE_DECOY/)
  assert.doesNotMatch(JSON.stringify(out.chunks) + JSON.stringify(out.logs), /SECRET/)
})
test('read decoy validates against current caller schema before tool emission', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"path":"fixture.txt","offset":2}' }])
  const block = out.chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block
  assert.equal(block.name, 'read')
  assert.deepEqual(JSON.parse(block.arguments), { file_path: 'fixture.txt', offset: 2 })
  assert.equal(out.terminal.reason.kind, 'tool-calls')
})
test('unknown returned names never become executable blocks', async t => {
  const out = await run(t, [{ name: 'invented_executor', arguments: '{}' }])
  assert.equal(toolChunks(out.chunks).length, 0)
  assert.equal(out.terminal.reason.failure.code, 'TOOL_BRIDGE_REJECTED')
})
test('translation disabled still restores native caller aliases', async t => {
  const out = await run(t, [{ name: 'read_client', arguments: '{"file_path":"fixture.txt"}' }], { toolTranslation: false })
  assert.equal(out.chunks.find(c => c.type === 'tool-call-delta').name, 'read')
  assert.equal(out.terminal.reason.kind, 'tool-calls')
})
test('translation disabled rejects decoys rather than falling through to same-named caller', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"path":"fixture.txt"}' }], { toolTranslation: false })
  assert.equal(toolChunks(out.chunks).length, 0)
  assert.match(out.terminal.reason.failure.message, /TRANSLATION_DISABLED/)
})
test('fingerprint disabled sends and accepts original tools rather than dropping them', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"file_path":"fixture.txt"}' }], { toolFingerprint: false })
  assert.deepEqual(out.sent.tools.map(t => t.function.name), ['read', 'pwsh'])
  assert.equal(out.terminal.reason.kind, 'tool-calls')
})
test('auxiliary requests cannot acquire tool authority from injected declarations', async t => {
  const out = await run(t, [{ name: 'read', arguments: '{"path":"fixture.txt"}' }], {}, { purpose: 'title' })
  assert.equal(toolChunks(out.chunks).length, 0)
  assert.match(out.terminal.reason.failure.message, /NO_CALLER_TARGET/)
})
for (const finish of [null, 'length', 'stop']) {
  test(`incomplete tool batch (${finish}) never dispatches even native pwsh`, async t => {
    const out = await run(t, [{ name: 'pwsh', arguments: '{"command":"SECRET_INCOMPLETE"}' }], {}, {}, finish)
    assert.equal(toolChunks(out.chunks).length, 0)
    assert.equal(out.terminal.reason.failure.code, 'TOOL_BRIDGE_INCOMPLETE')
    assert.doesNotMatch(JSON.stringify(out.chunks), /SECRET/)
  })
}
test('audit uses exact invoking agent scope, returns decisions, never schema secrets', async () => {
  const agent = { id: 'scope-test' }
  let gotScope
  const tool = createBridgeAuditTool({ schemas: scope => { gotScope = scope; return [read, { ...pwsh, description: 'SECRET_DESCRIPTION' }] } }, { fingerprint: true, translateDecoys: true })
  const { text } = await tool.execute({}, { agent })
  const report = JSON.parse(text)
  assert.equal(gotScope, agent)
  assert.equal(report.basis, 'current-agent-scoped-native-registry')
  assert.equal(report.noNetwork, true)
  assert.equal(report.noExecution, true)
  assert.ok(report.availableNativeWireNames.includes('pwsh'))
  assert.deepEqual(report.decoys.find(t => t.name === 'shell'), { name: 'shell', action: 'reject', reason: 'EXECUTABLE_DECOY' })
  assert.doesNotMatch(text, /SECRET_DESCRIPTION|file_path|fixture.txt/)
})
test('unscoped or cancelled audit never falls back to global schemas', async () => {
  let called = 0
  const tool = createBridgeAuditTool({ schemas: () => { called++; return [] } }, { fingerprint: true, translateDecoys: true })
  assert.equal(JSON.parse((await tool.execute({})).text).code, 'AGENT_SCOPE_REQUIRED')
  assert.equal(JSON.parse((await tool.execute({}, { agent: {}, signal: AbortSignal.abort() })).text).code, 'ABORTED')
  assert.equal(called, 0)
})
test('audit is bounded; bad limit and registry exceptions never leak details', async () => {
  const tools = Array.from({ length: 100 }, (_, i) => ({ ...pwsh, name: `native_${i}` }))
  const tool = createBridgeAuditTool({ schemas: () => tools }, { fingerprint: false, translateDecoys: false })
  const report = JSON.parse((await tool.execute({ limit: 3 }, { agent: {} })).text)
  assert.equal(report.callerNames.length, 3)
  assert.equal(report.counts.callers, 100)
  assert.equal(report.truncated, true)
  assert.equal(report.omitted.callerNames, 97)
  assert.equal(JSON.parse((await tool.execute({ limit: 201 }, { agent: {} })).text).code, 'LIMIT_OUT_OF_RANGE')
  const bad = createBridgeAuditTool({ schemas: () => { throw new Error('SECRET_REGISTRY') } }, { fingerprint: true, translateDecoys: true })
  assert.doesNotMatch((await bad.execute({}, { agent: {} })).text, /SECRET/)
})
