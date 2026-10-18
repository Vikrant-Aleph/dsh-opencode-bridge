import { test } from 'node:test'
import assert from 'node:assert/strict'
// Exercise the same compiled module shipped in the npm tarball.
import { resolveToolCall, auditToolBridge, ToolBridgeError } from '../lib/tool-bridge.js'

const string = { type: 'string' }
function tool(name, parameters) { return { name, description: 'SECRET_DESCRIPTION', parameters } }
function plan(entries = [], extras = {}) {
  const callerTools = new Map(entries.map(t => [t.name, t]))
  const aliases = new Map(entries.filter(t => ['read', 'glob', 'grep', 'bash', 'shell'].includes(t.name)).map(t => [`${t.name}_client`, t.name]))
  return {
    tools: entries.map(t => ({ type: 'function', function: { ...t, name: aliases.has(`${t.name}_client`) ? `${t.name}_client` : t.name } })),
    callerTools, callerNames: new Set(callerTools.keys()), aliasToOriginal: aliases,
    decoys: new Set(['read', 'glob', 'grep', 'bash', 'shell']), ...extras,
  }
}
const readSchema = { type: 'object', properties: { file_path: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['file_path'], additionalProperties: false }
const searchSchema = { type: 'object', properties: { pattern: string, path: string, include: string }, required: ['pattern'], additionalProperties: false }
const all = () => plan([tool('read', readSchema), tool('glob', searchSchema), tool('grep', searchSchema), tool('pwsh', { type: 'object' })])
const call = (name, args) => ({ id: 'call-1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
function rejected(fn, reason) {
  assert.throws(fn, e => e instanceof ToolBridgeError && e.reason === reason && e.message === `Tool bridge rejected call: ${reason}`)
}

test('read maps path to file_path with offset/limit; search maps only known fields', () => {
  const p = all()
  assert.deepEqual(JSON.parse(resolveToolCall(call('read', { path: 'a', offset: 2, limit: 4 }), p).arguments), { file_path: 'a', offset: 2, limit: 4 })
  for (const name of ['glob', 'grep']) {
    const args = name === 'grep' ? { pattern: 'a', path: 'b', include: '*.ts' } : { pattern: '*.ts', path: 'b' }
    assert.deepEqual(JSON.parse(resolveToolCall(call(name, args), p).arguments), args)
  }
})
test('extra source fields, prototype keys, wrong types and malformed structures fail closed', () => {
  for (const args of ['{', 'null', '[]', '"text"', '{}', '{"path":1}', '{"path":"SECRET_PATH","extra":"SECRET_COMMAND"}', '{"path":"a","__proto__":{}}', '{"path":"a","offset":1.2}', '{"path":"a","limit":-1}']) {
    rejected(() => resolveToolCall(call('read', args), all()), 'INVALID_ARGUMENTS')
  }
  rejected(() => resolveToolCall(call('glob', { pattern: 'a', include: 'not-mapped' }), all()), 'INVALID_ARGUMENTS')
})
test('missing target and unsupported target schemas reject before translation', () => {
  rejected(() => resolveToolCall(call('read', { path: 'a' }), plan()), 'NO_CALLER_TARGET')
  for (const schema of [
    {}, { type: 'object', properties: {} },
    { ...readSchema, required: ['file_path', 'description'] },
    { ...readSchema, properties: { file_path: { type: 'string', pattern: '^a' } } },
    { ...readSchema, properties: { file_path: { $ref: '#/secret' } } },
    { ...readSchema, allOf: [] },
  ]) rejected(() => resolveToolCall(call('read', { path: 'a' }), plan([tool('read', schema)])), 'UNSUPPORTED_TARGET_SCHEMA')
})
test('target type, required, bounds, enum and compositions are enforced', () => {
  const badSchemas = [
    { ...readSchema, required: ['file_path', 'offset'] },
    { ...readSchema, properties: { file_path: { type: 'string', minLength: 2 } } },
    { ...readSchema, properties: { file_path: { enum: ['other'] } } },
    { ...readSchema, properties: { file_path: { const: 'other' } } },
    { ...readSchema, anyOf: [{ required: ['offset'] }] },
    { ...readSchema, oneOf: [{}, {}] },
  ]
  for (const schema of badSchemas) rejected(() => resolveToolCall(call('read', { path: 'a' }), plan([tool('read', schema)])), 'INVALID_ARGUMENTS')
  rejected(() => resolveToolCall(call('read', { path: 'a', limit: 2001 }), all()), 'INVALID_ARGUMENTS')
  const schema = { ...readSchema, properties: { file_path: { anyOf: [{ const: 'a' }, { const: 'b' }] } } }
  assert.equal(JSON.parse(resolveToolCall(call('read', { path: 'a' }), plan([tool('read', schema)])).arguments).file_path, 'a')
})
test('preflight rejects obvious main-field type exclusions without promising satisfiability', () => {
  const fields = [false, ...['number', 'integer', 'boolean', 'array', 'object', 'null'].map(type => ({ type })),
    { type: ['number', 'null'] }, { const: 42 }, { enum: [false, 1, null] },
    { anyOf: [{ type: 'number' }, false] }, { oneOf: [{ type: 'boolean' }, { const: null }] }]
  for (const field of fields) {
    const p = plan([tool('read', { ...readSchema, properties: { file_path: field } })])
    rejected(() => resolveToolCall(call('read', { path: 'a' }), p), 'UNSUPPORTED_TARGET_SCHEMA')
    assert.deepEqual(auditToolBridge(p).decoys.find(d => d.name === 'read'), { name: 'read', action: 'reject', reason: 'UNSUPPORTED_TARGET_SCHEMA' })
  }
  for (const field of [true, {}, { type: ['string', 'null'] }, { const: 'a' }, { enum: [1, 'a'] }, { anyOf: [{ type: 'number' }, { type: 'string' }] }]) {
    const p = plan([tool('read', { ...readSchema, properties: { file_path: field } })])
    assert.equal(auditToolBridge(p).decoys.find(d => d.name === 'read').action, 'translate')
    assert.equal(JSON.parse(resolveToolCall(call('read', { path: 'a' }), p).arguments).file_path, 'a')
  }
  assert.match(auditToolBridge(all()).validation, /candidate mappings still require per-call validation/)
})
test('target numeric and object constraints remain authoritative', () => {
  for (const rule of [{ minimum: 3 }, { maximum: 1 }, { exclusiveMinimum: 2 }, { exclusiveMaximum: 2 }, { multipleOf: 3 }]) {
    const schema = { ...readSchema, properties: { file_path: string, offset: { type: 'integer', ...rule } } }
    rejected(() => resolveToolCall(call('read', { path: 'a', offset: 2 }), plan([tool('read', schema)])), 'INVALID_ARGUMENTS')
  }
  for (const rule of [{ minProperties: 2 }, { maxProperties: 0 }]) rejected(() => resolveToolCall(call('read', { path: 'a' }), plan([tool('read', { ...readSchema, ...rule })])), 'INVALID_ARGUMENTS')
  const closed = { type: 'object', properties: { file_path: string }, required: ['file_path'], additionalProperties: { type: 'string' } }
  rejected(() => resolveToolCall(call('read', { path: 'a', offset: 2 }), plan([tool('read', closed)])), 'INVALID_ARGUMENTS')
})
test('executable decoys never become native pwsh/bash/shell; aliases preserve raw bytes', () => {
  const p = plan([tool('pwsh', {}), tool('bash', {}), tool('shell', {})])
  for (const name of ['bash', 'shell']) rejected(() => resolveToolCall(call(name, { command: 'SECRET_COMMAND' }), p), 'EXECUTABLE_DECOY')
  const raw = '  { "command" : "native" }  '
  for (const name of ['bash_client', 'shell_client']) assert.deepEqual(resolveToolCall(call(name, raw), p), { ...call(name, raw), name: name.replace('_client', '') })
  assert.strictEqual(resolveToolCall(call('pwsh', raw), p).arguments, raw)
  // Genuine non-decoy caller shell names are not reinterpreted.
  const native = plan([tool('bash', {})], { decoys: new Set(), aliasToOriginal: new Map() })
  assert.equal(resolveToolCall(call('bash', raw), native).arguments, raw)
})
test('translation off still restores aliases; unknown names are rejected', () => {
  rejected(() => resolveToolCall(call('read', { path: 'a' }), all(), { translateDecoys: false }), 'TRANSLATION_DISABLED')
  const alias = call('read_client', ' { "file_path": "native" } ')
  assert.equal(resolveToolCall(alias, all(), { translateDecoys: false }).arguments, alias.arguments)
  for (const name of ['read_client', 'pwsh']) {
    for (const raw of ['INVALID_JSON', 'null', '[]', '"string"']) rejected(() => resolveToolCall(call(name, raw), all()), 'INVALID_ARGUMENTS')
  }
  rejected(() => resolveToolCall(call('unknown', '{}'), all()), 'UNKNOWN_TOOL')
  rejected(() => resolveToolCall(call('constructor', '{}'), all()), 'UNKNOWN_TOOL')
  rejected(() => resolveToolCall(call('shell', '{}'), all(), { translateDecoys: false }), 'EXECUTABLE_DECOY')
})
test('audit is JSON-safe, explains shell rejection, exposes native wire names not secrets', () => {
  const p = all()
  p.callerTools.set('read', tool('read', { ...readSchema, description: 'SECRET_DESCRIPTION', default: { file_path: 'SECRET_DEFAULT' }, examples: ['SECRET_EXAMPLE'] }))
  const report = auditToolBridge(p)
  const encoded = JSON.stringify(report)
  assert.doesNotMatch(encoded, /SECRET|file_path|parameters|schema description/)
  assert.equal(report.noNetwork, true)
  assert.equal(report.noExecution, true)
  assert.ok(report.availableNativeWireNames.includes('read_client'))
  assert.ok(report.availableNativeWireNames.includes('pwsh'))
  assert.deepEqual(report.decoys.find(d => d.name === 'shell'), { name: 'shell', action: 'reject', reason: 'EXECUTABLE_DECOY' })
  assert.equal(report.counts.translated, 3)
  assert.deepEqual(JSON.parse(encoded), report)
  assert.equal(auditToolBridge(p, { translateDecoys: false }).counts.translated, 0)
})
