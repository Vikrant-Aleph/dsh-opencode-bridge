// Explicit opt-in: synthetic images only, no user files/history or real tools.
// Tests user images first, then tool-result images through the standard hoist.
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { retryAfterMs } from '../lib/retry-after.js'

const args = process.argv.slice(2)
const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
if (!args.includes('--run') || !value('--fixtures') || !value('--out')) { console.error('Usage: --run --fixtures <fixture-directory> --out <new-report.json>'); process.exit(2) }
const fixtureDir = path.resolve(value('--fixtures'))
const output = path.resolve(value('--out'))
if (fs.existsSync(output)) throw new Error('Refusing to overwrite a previous report')
fs.mkdirSync(path.dirname(output), { recursive: true })
const manifest = value('--manifest') ?? 'fixtures.json'
if (path.basename(manifest) !== manifest) throw new Error('Fixture manifest must be a local basename')
const selectedCases = value('--cases')?.split(',')
const fixtures = JSON.parse(fs.readFileSync(path.join(fixtureDir, manifest), 'utf8')).map(item => {
  if (path.basename(item.file) !== item.file) throw new Error('Fixture image must be a local basename')
  const data = new Uint8Array(fs.readFileSync(path.join(fixtureDir, item.file)))
  const { expected, file, requestVersion, attachment, ...rawRef } = item
  return { expected, data, attachment: attachment ?? rawRef, version: requestVersion ?? { variantId: `synthetic-${rawRef.attachmentId}`, mediaType: rawRef.mediaType, bytes: data.length, width: rawRef.width, height: rawRef.height, depth: 'uchar', space: 'srgb', hasAlpha: false } }
})
const refs = fixtures.map(item => item.attachment)
const fixtureMap = new Map(fixtures.map(item => [item.attachment.attachmentId, item]))
const report = { startedAt: new Date().toISOString(), feature: 'unreleased vision candidate', baseVersion: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, syntheticOnly: true, actualToolsExecuted: 0, attachmentReader: 'synthetic test double for live wire verification; production uses ctx.attachments', models: [], cases: [], posts: 0 }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const base = 'https://opencode.ai/inference/v1'
const recipe = { baseUrl: base, apiKey: 'public', userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', client: 'cli', project: 'global', extraHeaders: {} }
let discoveryFailed = false
const quiet = { debug() {}, info() {}, warn() { discoveryFailed = true }, error() { discoveryFailed = true } }
const catalog = new FreeModelCatalog(base, { includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 }, quiet)
let models
try { models = await catalog.refresh() } finally { catalog.dispose() }
if (discoveryFailed || !models.length) throw new Error('Fresh free-model discovery unavailable')
models = models.filter(model => model.inputModalities?.includes('image'))
if (!models.length || models.length > 10) throw new Error('Unexpected vision-model count; no inference probes sent')
report.models = models.map(model => ({ id: model.id, inputModalities: model.inputModalities, api: model.api }))
let notBefore = 0
let halt = false
let activeRow
const nativeFetch = globalThis.fetch
save()
const attachments = {
  async readImageRequest(ref, target, signal) {
    signal?.throwIfAborted()
    const fixture = fixtureMap.get(ref.attachmentId)
    if (!fixture || target.width !== fixture.version.width || target.height !== fixture.version.height || target.maxBytes < fixture.version.bytes) throw new Error('Fixture lies outside the synthetic reader contract')
    activeRow.reads++
    return { ...fixture.version, attachment: ref, data: new Uint8Array(fixture.data) }
  },
}
const makeTool = name => ({ name, description: 'Returns a synthetic test image or fixed note; no real tools are executed.', parameters: { type: 'object', properties: {}, additionalProperties: false } })
const tools = ['fixture_image_a', 'fixture_note', 'fixture_image_c'].map(makeTool)
const calls = tools.map((tool, index) => ({ type: 'tool-call', id: `call_vision_${index}`, name: tool.name, arguments: '{}' }))
function optionsFor(model, mode) {
  const common = { provider: 'opencode-bridge', model: model.id, maxTokens: 512, sessionId: `vision-check-${model.id}-${mode}`, ...(model.efforts?.some(e => e.id === 'low') ? { reasoningEffort: 'low' } : {}) }
  if (mode === 'user' || mode === 'no-image-control') return { ...common, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the large eight-character code at the center of the image. Return only that code, with no tools. If no image is attached, reply NO_IMAGE.' }, ...(mode === 'user' ? [{ type: 'image', attachment: refs[0] }] : [])] }] }
  return { ...common, tools, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Read the large eight-character codes in the images returned by fixture_image_a and fixture_image_c. Reply with the two codes in that order separated by a comma. Do not call more tools.' }] },
    { role: 'assistant', content: calls },
    { role: 'tool', toolCallId: calls[0].id, content: [{ type: 'text', text: 'The first tool returned its image.' }, { type: 'image', attachment: refs[1] }] },
    { role: 'tool', toolCallId: calls[1].id, content: [{ type: 'text', text: 'This tool returned a note, not an image.' }] },
    { role: 'tool', toolCallId: calls[2].id, content: [{ type: 'text', text: 'The last tool returned its image.' }, { type: 'image', attachment: refs[2] }] },
  ] }
}
async function run(model, mode) {
  if (Date.now() < notBefore) {
    const wait = notBefore - Date.now()
    if (wait > 120_000) { halt = true; return }
    console.log(JSON.stringify({ event: 'respect_server_wait', ms: wait }))
    await delay(wait)
  }
  const row = { model: model.id, mode, startedAt: new Date().toISOString(), reads: 0, diagnostics: [] }
  activeRow = row
  report.cases.push(row)
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (_scope, _message, data = {}) => {
    if (level === 'warn' || level === 'error') row.diagnostics.push(Object.fromEntries(Object.entries(data).filter(([key]) => ['code', 'status', 'reason', 'upstreamType', 'retryAfterMs'].includes(key))))
  }]))
  const adapter = new OpenCodeFreeAdapter({ list: async () => models }, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 60_000, toolFingerprint: true, toolTranslation: true, attachments, toolImages: mode === 'tool', logger })
  let text = '', terminal
  try {
    for await (const chunk of adapter.stream(optionsFor(model, mode))) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') terminal = chunk.reason
    }
    row.finish = terminal?.kind
    if (terminal?.failure) {
      const message = terminal.failure.message ?? ''
      const category = /unavailable|overload|capacity/i.test(message) ? 'upstream_unavailable'
        : /timed? ?out|timeout/i.test(message) ? 'upstream_timeout'
          : /image|vision|multimodal|base64|pixel|decode/i.test(message) ? 'image_or_vision_error' : 'other_provider_error'
      row.failure = { code: terminal.failure.code, status: terminal.failure.status, category }
    }
    const expected = mode === 'tool' ? [fixtures[1].expected, fixtures[2].expected] : mode === 'user' ? [fixtures[0].expected] : ['NO_IMAGE']
    const positions = expected.map(code => text.indexOf(code))
    row.answerMatches = positions.every(index => index >= 0) && positions.every((index, i) => i === 0 || index > positions[i - 1])
    row.passed = terminal?.kind === 'stop' && row.answerMatches
    if (terminal?.failure?.providerRetryAfterMs) notBefore = Math.max(notBefore, Date.now() + terminal.failure.providerRetryAfterMs)
    if (terminal?.failure?.status === 429) { halt = true; row.stoppedForThrottle = true }
  } catch (error) { row.passed = false; row.problem = error.name }
  row.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ event: 'case', ...row }))
  await delay(1500)
}
globalThis.fetch = async (url, init) => {
  const endpoint = new URL(String(url))
  if (endpoint.origin !== 'https://opencode.ai' || !endpoint.pathname.endsWith('/chat/completions')) throw new Error('Unexpected live inference destination')
  if (++report.posts > 21) throw new Error('Inference POST budget exceeded')
  const body = JSON.parse(init.body)
  const wire = { endpoint: String(url), roles: body.messages.map(message => message.role), imageParts: body.messages.reduce((n, message) => n + (Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').length : 0), 0) }
  if (activeRow.mode === 'tool') {
    const toolRows = body.messages.filter(message => message.role === 'tool')
    wire.toolIdsPreserved = toolRows.length === calls.length && toolRows.every((message, i) => message.tool_call_id === calls[i].id && typeof message.content === 'string')
    const lastTool = body.messages.reduce((last, message, i) => message.role === 'tool' ? i : last, -1)
    wire.imagesAfterAllToolResults = body.messages.every((message, i) => !Array.isArray(message.content) || !message.content.some(part => part.type === 'image_url') || i > lastTool)
    if (!wire.toolIdsPreserved || !wire.imagesAfterAllToolResults) throw new Error('Candidate tool image ordering invalid before POST')
  }
  activeRow.wire = wire
  save()
  const response = await nativeFetch(url, init)
  activeRow.httpStatus = response.status
  const wait = retryAfterMs(response)
  if (wait !== undefined) notBefore = Math.max(notBefore, Date.now() + wait)
  return response
}
const requested = (model, mode) => !selectedCases || selectedCases.includes(`${model.id}:${mode}`)
if (selectedCases?.some(key => !models.some(model => ['user', 'tool', 'no-image-control'].some(mode => key === `${model.id}:${mode}`)))) throw new Error('Requested case is not in the declared vision snapshot')
try {
  for (const model of models) { if (halt) break; if (requested(model, 'user')) await run(model, 'user') }
  report.userPhaseFinishedAt = new Date().toISOString()
  if (!halt && requested(models[0], 'no-image-control')) await run(models[0], 'no-image-control')
  for (const model of models) { if (halt) break; if (requested(model, 'tool')) await run(model, 'tool') }
} finally { globalThis.fetch = nativeFetch; report.finishedAt = new Date().toISOString(); save() }
report.userPassed = report.cases.filter(row => row.mode === 'user' && row.passed).map(row => row.model)
report.toolPassed = report.cases.filter(row => row.mode === 'tool' && row.passed).map(row => row.model)
save()
console.log(JSON.stringify({ event: 'summary', users: report.userPassed, tools: report.toolPassed, posts: report.posts, halted: halt, output }))
