import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { CODE_MODE_TOOL_NAME, CODE_MODE_ANCHOR_NAMES, createCodeMode } from '../lib/code-mode.js'

const recipe = { baseUrl: 'https://opencode.ai/inference/openai/v1', apiKey: 'public', userAgent: 'opencode/latest/2.2.0/cli', client: 'cli', project: 'global', extraHeaders: {} }
const executeSchema = { name: CODE_MODE_TOOL_NAME, description: 'Execute a program.', parameters: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } }, required: ['code', 'description'], additionalProperties: false } }
const richRead = { name: 'read', description: 'A rich read description that the free lane would reject.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' } }, required: ['file_path'], additionalProperties: false } }
const richWrite = { name: 'write', description: 'A rich write description.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'], additionalProperties: false } }
const handle = { dispose() {}, instruction: 'INSTRUCTION_MARKER', renderCatalog: tools => 'CATALOG_MARKER:' + tools.filter(t => t.name !== CODE_MODE_TOOL_NAME).map(t => t.name).join(',') }
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
function adapter(t, { codeMode, tools }) {
  let body
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return ok() })
  const a = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 2000, ...(codeMode ? { codeMode: () => codeMode } : {}) })
  const run = async () => { const chunks = []; for await (const c of a.stream({ provider: 'opencode-bridge', model: 'fixture-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools })) chunks.push(c); return { reason: chunks.at(-1).reason, chunks, body } }
  return { run, getBody: () => body }
}

test('Code Mode replaces rich declarations with anchors + execute and moves the catalog to the prompt', async t => {
  const { run } = adapter(t, { codeMode: handle, tools: [executeSchema, richRead, richWrite] })
  const { reason, body } = await run()
  assert.equal(reason.kind, 'stop')
  const names = body.tools.map(tool => tool.function.name)
  assert.deepEqual(names, [...CODE_MODE_ANCHOR_NAMES, CODE_MODE_TOOL_NAME])
  // The rich tools are NOT declared on the wire.
  assert.ok(!names.includes('read') || CODE_MODE_ANCHOR_NAMES.includes('read'))
  assert.ok(body.tools.every(tool => tool.function.name === CODE_MODE_TOOL_NAME || tool.function.parameters.properties.input))
  const system = body.messages[0].content
  assert.match(system, /<env>/)
  assert.match(system, /INSTRUCTION_MARKER/)
  assert.match(system, /CATALOG_MARKER:read,write/)
  assert.ok(!system.includes('A rich read description'))
})

test('without a Code Mode handle the rich tools are declared directly (unchanged behavior)', async t => {
  const { run } = adapter(t, { codeMode: undefined, tools: [richRead, richWrite] })
  const { body } = await run()
  const names = body.tools.map(tool => tool.function.name)
  assert.ok(names.includes('read'))
  assert.ok(names.includes('write'))
  assert.ok(!names.includes(CODE_MODE_TOOL_NAME))
  assert.ok(!body.messages[0].content.includes('CATALOG_MARKER'))
})

test('Code Mode is skipped when the step does not admit the execute transport', async t => {
  const { run } = adapter(t, { codeMode: handle, tools: [richRead, richWrite] })
  const { body } = await run()
  const names = body.tools.map(tool => tool.function.name)
  assert.ok(names.includes('read'))
  assert.ok(!names.includes(CODE_MODE_TOOL_NAME))
  assert.ok(!body.messages[0].content.includes('CATALOG_MARKER'))
})

test('a stray model call to an anchor tool is dropped, execute is dispatched', async t => {
  const toolCallResponse = () => new Response(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"execute","arguments":"{\\"code\\":\\"return 1\\",\\"description\\":\\"demo\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    + 'data: [DONE]\n\n')
  let body
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body); return toolCallResponse() })
  const a = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 2000, codeMode: () => handle })
  const chunks = []
  for await (const c of a.stream({ provider: 'opencode-bridge', model: 'fixture-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [executeSchema, richRead] })) chunks.push(c)
  const calls = chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block.name)
  assert.deepEqual(calls, [CODE_MODE_TOOL_NAME])
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('createCodeMode falls back to direct declaration when the host has no PTC runtime', () => {
  const ctx = { get: () => undefined }
  const handle = createCodeMode(ctx, { providers: ['opencode-bridge'] })
  assert.equal(handle, undefined)
})

test('renderCatalog shows each tool\'s real return type, not a generic placeholder', () => {
  const readDefinition = {
    name: 'read',
    output: { schema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'array', items: { type: 'string' } }, totalLines: { type: 'number' } }, required: ['lines', 'totalLines'] } },
  }
  const ctx = {
    get: name => name === 'ptcRuntime' ? { language: 'typescript', programFormat: 'function-body' } : undefined,
    on: () => () => {},
    effect: () => () => {},
    tools: { get: name => name === 'read' ? readDefinition : undefined, register: () => () => {} },
    systemPrompt: { getSectionOrder: () => 100 },
  }
  const handle = createCodeMode(ctx, { providers: ['opencode-bridge'] })
  assert.ok(handle, 'expected a Code Mode handle with a PTC runtime present')
  const catalog = handle.renderCatalog([{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }])
  assert.match(catalog, /lines/, 'catalog must expose the real read return field')
  assert.match(catalog, /totalLines/, 'catalog must expose the real read return field')
})

const subagent = { name: 'subagent', description: 'Start a DSH child.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }

test('an admitted subagent is a native declaration and does not leak into the SDK', async t => {
  const { run } = adapter(t, { codeMode: handle, tools: [{ ...subagent, name: 'sub_agent' }, executeSchema, subagent, richRead] })
  const { body } = await run()
  const declaration = body.tools.find(tool => tool.function.name === 'subagent')
  assert.deepEqual(declaration.function.parameters, subagent.parameters)
  assert.match(body.messages[0].content, /CATALOG_MARKER:sub_agent,read/)
  assert.ok(!body.tools.some(tool => tool.function.name === 'subagent2'))
})

test('Code Mode emits only actual native calls admitted for the step', async t => {
  const calls = ['read', 'subagent', 'execute', 'write'].map((name, index) => ({ index, id: `call_${index}`, function: { name, arguments: '{"prompt":"fixture"}' } }))
  t.mock.method(globalThis, 'fetch', async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`))
  const a = new OpenCodeFreeAdapter({ list: async () => [] }, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 2000, codeMode: () => handle })
  async function collect(tools) {
    const names = []
    for await (const chunk of a.stream({ provider: 'opencode-bridge', model: 'fixture', tools, messages: [] })) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') names.push(chunk.block.name)
    }
    return names
  }
  assert.deepEqual(await collect([executeSchema, richRead, subagent]), ['subagent', 'execute'])
  assert.deepEqual(await collect([executeSchema, richRead]), ['execute'])
})

test('execute passes a narrowed borrowed tool set to PTC but leaves the host set intact', async t => {
  let registered, nestedSet
  const ctx = { get: name => name === 'ptcRuntime' ? { language: 'typescript', programFormat: 'function-body' } : undefined, on: () => () => {}, effect: () => () => {}, tools: { register: tool => { registered = tool; return () => {} }, get: () => undefined }, systemPrompt: { getSectionOrder: () => 100 } }
  const codeMode = createCodeMode(ctx, { providers: ['opencode-bridge'] })
  assert.ok(!codeMode.renderCatalog([subagent, richRead]).includes('subagent'))
  t.mock.method(PtcExecutor.prototype, 'execute', async ({ toolSet }) => {
    nestedSet = toolSet
    return { additionalContexts: [], results: [{ result: { value: { result: 1 } } }] }
  })
  const agent = {}
  const original = new Map([['subagent', subagent], ['execute', executeSchema], ['read', richRead]])
  let disposed = false
  const toolSet = { view: scope => scope === agent ? original : new Map(), dispose: () => { disposed = true } }
  await registered.execute({ code: 'return 1', description: 'Test nested set' }, { callId: 'fixture', signal: new AbortController().signal, toolSet, agent })
  assert.deepEqual([...nestedSet.view(agent).keys()], ['read'])
  assert.equal(nestedSet.view({}).size, 0)
  nestedSet.dispose()
  assert.ok(!disposed)
  assert.deepEqual([...original.keys()], ['subagent', 'execute', 'read'])
})
