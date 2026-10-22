// Offline adapter wiring only. Every byte/ref and fetch response is synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { PluginLogger } from '../lib/logger.js'

const text = text => ({ type: 'text', text })
const user = content => ({ role: 'user', content })
const img = (n = 1, extra = {}) => ({ type: 'image', attachment: { attachmentId: `sha256:${String(n).padStart(64, '0')}`, mediaType: 'image/png', bytes: 50, width: 4000, height: 2000, name: `SYNTHETIC_IMAGE_${n}.png` }, ...extra })
const version = ref => ({ variantId: 'synthetic-variant', attachment: ref, data: Uint8Array.from([83, 69, 67, 82, 69, 84]), mediaType: 'image/webp', bytes: 6, width: 2000, height: 1000, depth: 'uchar', space: 'srgb', hasAlpha: false })
const vision = () => ({ id: 'fixture', name: 'Fixture', api: 'https://api-a.invalid/v1', inputModalities: ['text', 'image'], efforts: [{ id: 'high', name: 'High' }] })
const reader = () => ({ reads: [], async readImageRequest(ref, target, signal) { this.reads.push({ ref, target, signal }); return version(ref) } })
const request = messages => ({ provider: 'offline', model: 'fixture', sessionId: 'offline-session', messages, tools: [] })
const images = row => Array.isArray(row.content) ? row.content.filter(p => p.type === 'image_url') : []
const urls = rows => rows.flatMap(images).map(p => p.image_url.url)
function adapter(extra = {}, catalog = { list: async () => [vision()] }) {
  return new OpenCodeFreeAdapter(catalog, { providerRoute: 'offline', recipe: { baseUrl: 'https://fallback.invalid/v1', apiKey: 'public', userAgent: 'opencode/1.19.0', client: 'cli', project: 'global', extraHeaders: {} }, requestTimeoutMs: 1000, toolFingerprint: false, toolTranslation: true, ...extra })
}
function fake(t) {
  const posts = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body), signal: init.signal })
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  return posts
}
async function run(a, options) { const result = []; for await (const chunk of a.stream(options)) result.push(chunk); return result.at(-1).reason }
async function runPrepared(p, options) { const result = []; for await (const chunk of p.stream(options)) result.push(chunk); return result.at(-1).reason }

 test('user text-image-text preserves positions and uses actual version MIME/base64', async t => {
  const posts = fake(t), service = reader()
  assert.equal((await run(adapter({ attachments: service }), request([user([text('BEFORE'), img(), text('AFTER')])]))).kind, 'stop')
  const row = posts[0].body.messages[0]
  assert.deepEqual(row.content.map(p => p.type), ['text', 'text', 'image_url', 'text'])
  assert.equal(row.content[0].text, 'BEFORE'); assert.equal(row.content.at(-1).text, 'AFTER')
  assert.equal(urls([row])[0], 'data:image/webp;base64,U0VDUkVU')
})
test('multiple user images preserve original attachment order', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service }), request([user([img(2), text('middle'), img(1)])]))
  assert.deepEqual(service.reads.map(r => r.ref.name), ['SYNTHETIC_IMAGE_2.png', 'SYNTHETIC_IMAGE_1.png'])
  const parts = posts[0].body.messages[0].content
  assert.match(parts[0].text, /SYNTHETIC_IMAGE_2/); assert.equal(parts[2].text, 'middle'); assert.match(parts[3].text, /SYNTHETIC_IMAGE_1/)
})
test('formal service receiver, combined signal and public target match serialization', async t => {
  const posts = fake(t), service = reader(), caller = new AbortController()
  const a = adapter({ getAttachments: () => service, imagePolicy: { maxPixels: 1000000, maxImageBytes: 12345 } })
  await run(a, { ...request([user([img()])]), signal: caller.signal })
  assert.equal(service.reads.length, 1)
  assert.deepEqual(service.reads[0].target, a.imageRequestTarget('offline', 'fixture', img().attachment))
  assert.equal(service.reads[0].target.maxBytes, 12345)
  assert.equal(service.reads[0].signal, posts[0].signal)
  assert.notEqual(service.reads[0].signal, caller.signal)
})
test('list and resolve declare copied image modalities', async () => {
  const meta = vision(), a = adapter({}, { list: async () => [meta] })
  const listed = await a.listModels('offline'), resolved = await a.resolveModel('offline', 'fixture')
  assert.deepEqual(listed[0].inputModalities, ['text', 'image']); assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  listed[0].inputModalities.pop(); resolved.inputModalities.pop()
  assert.deepEqual(meta.inputModalities, ['text', 'image'])
})
for (const mode of ['unknown', 'text-only', 'unspecified']) test(`${mode} model never reads or sends image bytes`, async t => {
  const posts = fake(t), service = reader(), meta = vision()
  if (mode === 'text-only') meta.inputModalities = ['text']
  if (mode === 'unspecified') delete meta.inputModalities
  const a = adapter({ attachments: service }, { list: async () => mode === 'unknown' ? [] : [meta] })
  await run(a, request([user([img()])]))
  assert.equal(service.reads.length, 0); assert.equal(urls(posts[0].body.messages).length, 0)
  assert.match(posts[0].body.messages[0].content, /text only/)
})
test('pure text retains ordinary string body shape and controls', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service }), { ...request([user([text('one'), text('two')])]), temperature: 0, maxTokens: 42, stop: ['END'] })
  const b = posts[0].body
  assert.deepEqual(b.messages, [{ role: 'user', content: 'one\ntwo' }]); assert.deepEqual(b.tools, [])
  assert.equal(b.stream, true); assert.equal(b.tool_choice, 'auto'); assert.equal(b.temperature, 0); assert.equal(b.max_tokens, 42); assert.deepEqual(b.stop, ['END']); assert.equal(service.reads.length, 0)
})
test('offloaded image is a placeholder with no reader and no bytes', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service }), request([user([img(1, { offloaded: true })])]))
  assert.equal(service.reads.length, 0); assert.equal(urls(posts[0].body.messages).length, 0); assert.match(posts[0].body.messages[0].content, /omitted to fit/)
})
for (const bad of ['missing', 'throws', 'malformed']) test(`${bad} attachment service fails before POST`, async t => {
  const posts = fake(t)
  const attachments = bad === 'missing' ? undefined : { readImageRequest: async ref => { if (bad === 'throws') throw new Error('SENSITIVE_BASE64_U0VDUkVU'); return { ...version(ref), bytes: 999 } } }
  const result = await run(adapter({ attachments }), request([user([img()])]))
  assert.equal(posts.length, 0); assert.equal(result.kind, 'error'); assert.match(result.failure.code, /^IMAGE_ATTACHMENT_/)
  assert.doesNotMatch(result.failure.message, /SENSITIVE/)
})
for (const mode of ['caller', 'timeout', 'lifetime']) test(`${mode} cancellation during uncooperative read prevents POST`, async t => {
  const posts = fake(t), controller = new AbortController()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const service = { readImageRequest(_ref, _target, signal) { entered(signal); return new Promise(() => {}) } }
  const a = adapter({ attachments: service, requestTimeoutMs: mode === 'timeout' ? 15 : 1000, ...(mode === 'lifetime' ? { lifetimeSignal: controller.signal } : {}) })
  const work = run(a, { ...request([user([img()])]), ...(mode === 'caller' ? { signal: controller.signal } : {}) })
  const observed = await started
  // Keep node alive while AbortSignal.timeout (an unref'ed timer) fires.
  const guard = setTimeout(() => {}, 2000)
  try {
    if (mode !== 'timeout') controller.abort(new Error('synthetic cancellation'))
    const reason = await work
    assert.equal(observed.aborted, true); assert.equal(posts.length, 0)
    assert.equal(reason.kind, mode === 'timeout' ? 'error' : 'aborted'); assert.equal(reason.failure.code, mode === 'timeout' ? 'TIMEOUT' : 'ABORTED')
  } finally { clearTimeout(guard) }
})
for (const budget of ['count', 'bytes']) test(`${budget} budget preserves IMAGE_OFFLOAD_REQUIRED and offloadImages`, async t => {
  const posts = fake(t), service = reader()
  const policy = budget === 'count' ? { maxImages: 1 } : { maxRequestImageBytes: 8 }
  const reason = await run(adapter({ attachments: service, imagePolicy: policy }), request([user([img(), img()])]))
  assert.equal(reason.kind, 'error'); assert.equal(reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED'); assert.equal(reason.failure.offloadImages, 1); assert.equal(posts.length, 0)
  assert.equal(service.reads.length, budget === 'count' ? 0 : 1)
})
const callerRead = { name: 'read', description: 'Synthetic reader', parameters: { type: 'object', properties: {} } }
const call = id => ({ type: 'tool-call', id, name: 'read', arguments: '{ "synthetic" : true }\n' })
const tool = (id, content) => ({ role: 'tool', toolCallId: id, content })
function history(extra = []) { return [{ role: 'assistant', content: [{ type: 'reasoning', text: '' }, call('A'), call('B'), call('C')] }, tool('A', [text(' A \t'), img(1)]), ...extra, tool('B', [text(' B\r\n ')]), tool('C', [text(' C '), img(2)])] }
for (const ending of ['end', 'real-user', 'dropped-developer']) test(`tool image group flush ${ending} preserves all rows, ids, aliases and reasoning`, async t => {
  const posts = fake(t), service = reader()
  const input = history(ending === 'dropped-developer' ? [{ role: 'developer', content: [text('dropped')] }] : [])
  if (ending === 'real-user') input.push(user([text('actual user')]))
  await run(adapter({ attachments: service, toolImages: true, toolFingerprint: true }), { ...request(input), tools: [callerRead] })
  const rows = posts[0].body.messages.filter(m => m.role !== 'system')
  assert.deepEqual(rows.map(m => m.role), ['assistant', 'tool', 'tool', 'tool', 'user', ...(ending === 'real-user' ? ['user'] : [])])
  assert.deepEqual(rows[0].tool_calls.map(c => [c.id, c.function.name]), [['A', 'read_client'], ['B', 'read_client'], ['C', 'read_client']])
  assert.equal(rows[0].reasoning_content, ''); assert.equal(rows[0].tool_calls[0].function.arguments, '{ "synthetic" : true }\n')
  assert.deepEqual(rows.slice(1, 4).map(m => m.tool_call_id), ['A', 'B', 'C'])
  assert.ok(rows[1].content.startsWith(' A \t')); assert.equal(rows[2].content, ' B\r\n '); assert.ok(rows[3].content.startsWith(' C '))
  assert.equal(images(rows[4]).length, 2)
  const labels = rows[4].content.filter(p => p.type === 'text').map(p => p.text).join('\n')
  assert.match(labels, /tool result A/); assert.match(labels, /tool result C/)
  assert.ok(labels.indexOf('SYNTHETIC_IMAGE_1') < labels.indexOf('SYNTHETIC_IMAGE_2'))
  if (ending === 'real-user') assert.equal(rows[5].content, 'actual user')
})
test('tool multi-image repeated occurrences deduplicate reads without dropping wire images', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service, toolImages: true }), request([tool('A', [img(2), img(1), img(2)])]))
  assert.deepEqual(service.reads.map(r => r.ref.name), ['SYNTHETIC_IMAGE_2.png', 'SYNTHETIC_IMAGE_1.png'])
  assert.deepEqual(posts[0].body.messages.map(m => m.role), ['tool', 'user']); assert.equal(images(posts[0].body.messages[1]).length, 3)
})
test('declared vision routes enable the verified tool-image projection by default', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service }), request(history()))
  assert.equal(service.reads.length, 2)
  assert.deepEqual(posts[0].body.messages.map(m => m.role), ['assistant', 'tool', 'tool', 'tool', 'user'])
  assert.equal(urls(posts[0].body.messages).length, 2)
})
test('explicit toolImages false never reads tool images or creates hoisted user', async t => {
  const posts = fake(t), service = reader()
  await run(adapter({ attachments: service, toolImages: false }), request(history()))
  assert.equal(service.reads.length, 0); assert.deepEqual(posts[0].body.messages.map(m => m.role), ['assistant', 'tool', 'tool', 'tool']); assert.equal(urls(posts[0].body.messages).length, 0)
})
test('prepared call freezes image capability, API and high effort across catalog mutation', async t => {
  const posts = fake(t), service = reader(), meta = vision(), catalog = { list: async () => [meta] }, a = adapter({ attachments: service }, catalog)
  const prepared = await a.prepareCall('offline', 'fixture')
  meta.inputModalities.splice(1, 1); meta.api = 'https://api-b.invalid/v1'; meta.efforts[0].id = 'low'
  const options = { ...request([user([img()])]), reasoningEffort: 'high' }
  assert.deepEqual(prepared.model.inputModalities, ['text', 'image']); assert.equal(prepared.model.reasoning.efforts[0].id, 'high')
  assert.equal((await runPrepared(prepared, options)).kind, 'stop')
  assert.equal(posts[0].url, 'https://api-a.invalid/v1/chat/completions'); assert.equal(posts[0].body.reasoning_effort, 'high'); assert.equal(urls(posts[0].body.messages).length, 1)
  await run(a, options)
  assert.equal(posts[1].url, 'https://api-b.invalid/v1/chat/completions'); assert.equal(posts[1].body.reasoning_effort, undefined); assert.equal(urls(posts[1].body.messages).length, 0); assert.equal(service.reads.length, 1)
})
test('prepared unknown snapshot stays text-only and fallback API after catalog gains vision', async t => {
  const posts = fake(t), service = reader(); let catalogRows = []
  const a = adapter({ attachments: service }, { list: async () => catalogRows }), p = await a.prepareCall('offline', 'fixture')
  catalogRows = [vision()]
  await runPrepared(p, { ...request([user([img()])]), reasoningEffort: 'high' })
  assert.equal(posts[0].url, 'https://fallback.invalid/v1/chat/completions'); assert.equal(posts[0].body.reasoning_effort, undefined); assert.equal(urls(posts[0].body.messages).length, 0); assert.equal(service.reads.length, 0)
})
for (const level of ['debug', 'info', 'warn', 'error', 'off']) test(`image content/base64 absent from all ${level} file and mirrored logs`, async t => {
  fake(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-adapter-offline-')), mirror = []
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const logger = new PluginLogger({ dir, level, maxBytes: 100000, maxFiles: 1, mirror: line => mirror.push(line) })
  await run(adapter({ attachments: reader(), logger }), request([user([text('PRIVATE_USER_SENTINEL'), img()])]))
  await run(adapter({ logger, attachments: { async readImageRequest() { throw new Error('PRIVATE_USER_SENTINEL U0VDUkVU data:image/webp;base64,') } } }), request([user([img()])]))
  const logs = [...mirror, ...fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8'))].join('\n')
  for (const secret of ['PRIVATE_USER_SENTINEL', 'U0VDUkVU', 'data:image/', 'SYNTHETIC_IMAGE_']) assert.equal(logs.includes(secret), false)
})
