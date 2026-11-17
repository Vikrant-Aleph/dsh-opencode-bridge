import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { summarizeWireRequest } from '../lib/request-diagnostics.js'
import { PluginLogger } from '../lib/logger.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { LogService, registerLogAccess } from '../lib/log-service.js'

const secret = 'PRIVATE_SENTINEL_DO_NOT_LOG_4815162342'
const session = 'ses_abcdef123456ABCDEFGHIJKLMN'
const headers = { 'user-agent': 'opencode/latest/2.2.0/cli', authorization: 'Bearer public', 'x-opencode-client': 'cli', 'x-opencode-session': session, 'x-opencode-session-id': session, 'x-session-affinity': session, 'x-session-id': session, b3: `${'a'.repeat(32)}-${'b'.repeat(16)}-1-${'c'.repeat(16)}`, traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }
const tool = (name = 'read') => ({ type: 'function', function: { name, description: secret, strict: false, parameters: { type: 'object', properties: { [secret]: { type: 'string', enum: [secret], default: secret, description: secret } }, required: [secret], additionalProperties: false } } })
const body = () => ({ model: 'fixture-free', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 65536, temperature: .7, messages: [{ role: 'system', content: `<env>${secret}</env>` }, { role: 'user', content: [{ type: 'text', text: secret }, { type: 'image_url', image_url: { url: `data:image/png;base64,${secret}` } }] }], tools: [tool()] })
const summary = (data = body(), extra = {}) => summarizeWireRequest({ endpoint: 'https://opencode.ai/inference/openai/v1/chat/completions', headers, configuredTransport: true, serializedBody: JSON.stringify(data), ...extra })

test('summaries describe actual controls, transport and message/tool geometry without content', () => {
  const data = body(), result = summary(data)
  assert.equal(result.request.route, '/inference/openai/v1/chat/completions')
  assert.equal(result.request.transport, 'configured')
  assert.equal(result.request.maxCompletionTokens, 65536)
  assert.equal(result.request.bodyBytes, Buffer.byteLength(JSON.stringify(data)))
  assert.equal(result.request.roles, 'system,user')
  assert.equal(result.request.envStarts, 1)
  assert.equal(result.request.envEnds, 1)
  assert.equal(result.request.images, 1)
  assert.equal(result.request.authPublic, true)
  assert.equal(result.request.sessionAliasesEqual, true)
  assert.equal(result.request.traceHeaders, true)
  assert.equal(result.tools.count, 1)
  assert.equal(result.tools.rootObject, 1)
  assert.equal(result.tools.strictFalse, 1)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('custom URL credentials, query values, headers, tool names and schema literals never escape', () => {
  const data = body()
  data[secret] = secret
  data.tools.push(tool(secret))
  data.messages.push({ role: secret, content: secret, tool_calls: [{ id: secret, function: { name: secret, arguments: JSON.stringify({ [secret]: secret }) } }] })
  const result = summary(data, { endpoint: `https://${secret}:${secret}@private-${secret}.example/secret/${secret}?token=${secret}`, headers: { authorization: `Bearer ${secret}`, 'user-agent': `opencode/latest/2.2.0/cli ${secret}`, [secret]: secret } })
  const encoded = JSON.stringify(result)
  assert.doesNotMatch(encoded, new RegExp(secret))
  assert.equal(result.request.route, 'custom')
  assert.equal(result.request.ua, 'custom')
  assert.equal(result.request.urlCredentials, true)
  assert.equal(result.request.urlQuery, true)
  assert.equal(result.request.authPublic, false)
  assert.equal(result.tools.invalidNames, 1)
})

test('history mismatches and orphaned results are counted without IDs or arguments', () => {
  const data = body()
  data.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: secret, function: { name: 'web_search', arguments: secret } }] }, { role: 'tool', tool_call_id: secret + '_orphan', content: secret })
  const result = summary(data)
  assert.equal(result.request.calls, 1)
  assert.equal(result.request.results, 1)
  assert.equal(result.request.invalidHistoryNames, 1)
  assert.equal(result.request.undeclaredHistoryNames, 1)
  assert.equal(result.request.orphanResults, 1)
  assert.equal(result.request.unansweredCalls, 1)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('schema summaries count local/missing/external refs, unions and nullable types without ref text', () => {
  const data = body()
  data.tools[0].function.parameters = { type: 'object', $defs: { Item: { type: ['string', 'null'] } }, properties: { a: { $ref: '#/$defs/Item' }, b: { $ref: '#/missing' }, c: { $ref: `https://${secret}.example/${secret}` }, d: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }
  const result = summary(data)
  assert.equal(result.tools.localRefs, 2)
  assert.equal(result.tools.missingRefs, 1)
  assert.equal(result.tools.externalRefs, 1)
  assert.equal(result.tools.nullable, 1)
  assert.equal(result.tools.anyOf, 2)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
})

test('JSON pointers through arrays and named anchors are not falsely reported as missing refs', () => {
  const data = body()
  data.tools[0].function.parameters = { type: 'object', anyOf: [{ type: 'string' }], properties: { a: { $ref: '#/anyOf/0' }, b: { $ref: '#namedAnchor' } } }
  const result = summary(data)
  assert.equal(result.tools.localRefs, 2)
  assert.equal(result.tools.missingRefs, 0)
  assert.equal(result.tools.externalRefs, 0)
})

test('invalid and oversized wire data fails closed without quoting the parse error', () => {
  const invalid = summary({}, { serializedBody: `not JSON ${secret}` })
  assert.equal(invalid.request.unavailable, true)
  assert.doesNotMatch(JSON.stringify(invalid), new RegExp(secret))
  const large = summary({}, { serializedBody: 'x'.repeat(8 * 1024 * 1024 + 1) })
  assert.equal(large.request.bodyCapped, true)
})

test('inspection budgets cap large tool/schema sets and keep each log record valid under logger limits', t => {
  const data = body()
  data.tools = Array.from({ length: 200 }, () => tool())
  data.messages = Array.from({ length: 600 }, () => ({ role: 'user', content: secret }))
  const result = summary(data)
  assert.equal(result.tools.count, 200)
  assert.equal(result.tools.inspected, 128)
  assert.equal(result.tools.capped, true)
  assert.equal(result.request.messagesCapped, true)
  assert.ok(Number(result.tools.nodes) <= 8192)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-shape-log-'))
  t.after(() => { const actual = fs.realpathSync(directory); assert.equal(actual, path.resolve(directory)); fs.rmSync(actual, { recursive: true, force: true }) })
  const logger = new PluginLogger({ dir: directory, level: 'debug', maxBytes: 100_000, maxFiles: 1 })
  for (const facts of [result.request, result.tools]) logger.error('request', 'summary', { request: 'msg_fixture', model: 'fixture-free', ...facts })
  for (const line of logger.read().lines) {
    assert.doesNotMatch(line, /truncated|PRIVATE_SENTINEL/)
    assert.doesNotThrow(() => JSON.parse(line.slice(line.indexOf('{'))))
  }
})

const input = { provider: 'opencode-bridge', model: 'fixture-free', messages: [{ role: 'user', content: [{ type: 'text', text: secret }] }], tools: [] }
const recipe = { baseUrl: 'https://opencode.ai/inference/openai/v1', apiKey: 'public', userAgent: headers['user-agent'], client: 'cli', project: 'global', extraHeaders: {} }
async function collect(a) { const chunks = []; for await (const chunk of a.stream(input)) chunks.push(chunk); return chunks.at(-1).reason }
function fixture(level) {
  const logs = []
  const logger = { ...Object.fromEntries(['debug', 'info', 'warn', 'error'].map(severity => [severity, (scope, event, data) => logs.push({ severity, scope, event, data })])), getLevel: () => level }
  return { logs, a: new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: input.provider, recipe, requestTimeoutMs: 2000, logger }) }
}
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

test('the live log tool advertises the diagnostics version without requiring a model request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-capability-'))
  t.after(() => { const actual = fs.realpathSync(directory); assert.equal(actual, path.resolve(directory)); fs.rmSync(actual, { recursive: true, force: true }) })
  const logger = new PluginLogger({ dir: directory, level: 'warn', maxBytes: 100_000, maxFiles: 1 })
  let definition
  const context = { inject() { return () => {} }, get(name) { return name === 'tools' ? { register(value) { definition = value; return () => {} } } : undefined } }
  const dispose = registerLogAccess(context, new LogService(logger))
  t.after(dispose)
  const result = await definition.execute({ action: 'stat' })
  assert.match(result.text, /request diagnostics: v1/)
})

test('a real adapter failure logs two redacted summaries at the existing failure severity', async t => {
  const f = fixture('warn')
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }, { status: 429 }))
  assert.equal((await collect(f.a)).failure.code, 'FREE_USAGE_LIMIT')
  const logs = f.logs.filter(row => row.scope === 'request')
  assert.equal(logs.length, 2)
  assert.ok(logs.every(row => row.severity === 'error'))
  assert.equal(logs[0].data.transport, 'node-fetch')
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(secret))
})

test('successful requests log structure only at Debug, and never log the response text', async t => {
  t.mock.method(globalThis, 'fetch', async () => ok())
  const normal = fixture('warn')
  assert.equal((await collect(normal.a)).kind, 'stop')
  assert.equal(normal.logs.filter(row => row.scope === 'request').length, 0)
  const verbose = fixture('debug')
  assert.equal((await collect(verbose.a)).kind, 'stop')
  assert.equal(verbose.logs.filter(row => row.scope === 'request').length, 2)
  assert.doesNotMatch(JSON.stringify(verbose.logs), new RegExp(secret))
})

test('diagnostics reflect a fully initialized configured transport and do not change the wire body', async () => {
  const f = fixture('debug')
  let sent
  f.a.setTransport(Promise.resolve(async (_url, init) => { sent = JSON.parse(init.body); return ok() }))
  assert.equal((await collect(f.a)).kind, 'stop')
  assert.equal(f.logs.find(row => row.event === 'request shape').data.transport, 'configured')
  assert.equal(sent.messages.at(-1).content, secret)
  assert.equal(Object.hasOwn(sent, 'diagnostics'), false)
})
