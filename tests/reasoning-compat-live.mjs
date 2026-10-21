// Explicit opt-in live protocol probes. Synthetic data only; no tool execution.
// node tests/reasoning-compat-live.mjs --run --out research/reasoning-compat/<unique>.json
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FreeModelCatalog } from '../lib/catalog.js'
import { buildChatMessages, planTools, buildHeaders, mintSessionId, mintRequestId } from '../lib/opencode-protocol.js'
import { httpError } from '../lib/http-errors.js'
import { retryAfterMs } from '../lib/retry-after.js'
import { consumeProbeResponse } from './helpers/reasoning-probe-reader.mjs'

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--out')
if (!args.includes('--run') || outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('Live probes disabled. Usage: node tests/reasoning-compat-live.mjs --run --out <new-report.json>')
  process.exit(2)
}
const output = path.resolve(args[outputIndex + 1])
if (fs.existsSync(output)) throw new Error('Refusing to overwrite a previous probe report')
fs.mkdirSync(path.dirname(output), { recursive: true })
const base = 'https://opencode.ai/inference/v1'
const recipe = { baseUrl: base, apiKey: 'public', userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', client: 'cli', project: 'global', extraHeaders: {} }
const callerTool = { name: 'read', description: 'Read synthetic fixture text only.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const plan = planTools([callerTool])
const fixture = {
  provider: 'opencode-bridge', model: 'fixture-free', tools: [callerTool],
  system: 'This is a protocol compatibility test. A fixture tool result is already supplied. Reply only OK. Do not call any tools.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Use the synthetic fixture tool result below and reply only OK.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_reasoning_fixture', name: 'read', arguments: JSON.stringify({ file_path: 'fixture.txt' }) }] },
    { role: 'tool', toolCallId: 'call_reasoning_fixture', content: [{ type: 'text', text: 'OK' }] },
  ],
}
const report = { probeSchemaVersion: 2, startedAt: new Date().toISOString(), scope: 'Current automatically discovered free models; direct anonymous requests; synthetic tool history; no tools executed.', version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, requestBudget: 21, cases: [], attempts: [], controls: [] }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const started = Date.now()
const totalBudgetMs = 10 * 60_000
let notBefore = 0
let halt = false
let sourceFailure = false
const catalog = new FreeModelCatalog(base, { includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 }, { debug() {}, info() {}, warn() { sourceFailure = true }, error() {} })
let models
try { models = await catalog.refresh() } finally { catalog.dispose() }
if (sourceFailure || !models.length) throw new Error('No verified model snapshot; no inference probes sent')
report.models = models.map(m => ({ id: m.id, endpoint: `${(m.api ?? base).replace(/\/$/, '')}/chat/completions`, efforts: m.efforts?.map(e => e.id) ?? [] }))
for (const model of report.models) {
  report.cases.push({ model: model.id, endpoint: model.endpoint, mode: 'default', state: 'untested' })
  const efforts = model.efforts.filter(value => !['none', 'off', 'disabled'].includes(value))
  const effort = efforts.includes('high') ? 'high' : efforts.at(-1)
  if (effort) report.cases.push({ model: model.id, endpoint: model.endpoint, mode: 'thinking', effort, state: 'untested' })
}
if (report.cases.length > 35) throw new Error('Too many live cases for the fixed request budget; no inference probes sent')
save()
console.log(JSON.stringify({ event: 'snapshot', models: report.models.length, cases: report.cases.length, output }))

async function probe(test, emptyField = true) {
  if (report.attempts.length >= report.requestBudget || Date.now() - started > totalBudgetMs) return { state: 'inconclusive', problem: 'budget_exhausted' }
  if (Date.now() < notBefore) {
    const wait = notBefore - Date.now()
    if (wait > 120_000 || Date.now() - started + wait > totalBudgetMs) { halt = true; return { state: 'inconclusive', problem: 'server_wait_exceeds_probe_budget', retryAfterMs: wait } }
    console.log(JSON.stringify({ event: 'respect_wait', ms: wait }))
    await delay(wait)
  }
  const messages = buildChatMessages(fixture, plan).map(message => {
    if (message.role !== 'assistant') return message
    const projected = { ...message }
    if (emptyField) projected.reasoning_content = ''
    else delete projected.reasoning_content
    return projected
  })
  const session = mintSessionId()
  const body = { model: test.model, messages, stream: true, tools: plan.tools, tool_choice: 'auto', prompt_cache_key: session.replace(/^ses_/, ''), max_tokens: 64, ...(test.effort ? { reasoning_effort: test.effort } : {}) }
  const attempt = { model: test.model, mode: test.mode, effort: test.effort, endpoint: test.endpoint, emptyField, sentAt: new Date().toISOString() }
  report.attempts.push(attempt)
  save()
  try {
    const signal = AbortSignal.timeout(Math.min(45_000, Math.max(1000, totalBudgetMs - (Date.now() - started))))
    const response = await fetch(test.endpoint, { method: 'POST', headers: buildHeaders(recipe, session, mintRequestId()), body: JSON.stringify(body), signal })
    attempt.status = response.status
    const hint = retryAfterMs(response)
    if (hint !== undefined) { attempt.retryAfterMs = hint; notBefore = Math.max(notBefore, Date.now() + hint) }
    let result
    if (!response.ok) {
      const failure = await httpError(response)
      attempt.diagnostics = failure.diagnostics
      const fieldMention = /reasoning_content/i.test(failure.message)
      const fieldSpecific = fieldMention && /(?:unknown|unsupported|unexpected|not permitted|not allowed|unrecognized|must|missing|required)/i.test(failure.message)
      result = { state: fieldSpecific ? 'field_rejected' : 'inconclusive', problem: `HTTP_${response.status}` }
      if (failure.diagnostics.reason === 'quota_exceeded' || failure.diagnostics.upstreamType === 'FreeUsageLimitError'
        || (response.status === 429 && /free usage|quota|daily limit|credits? exhausted/i.test(failure.message))) halt = true
      if ([429, 503].includes(response.status) && hint === undefined) notBefore = Math.max(notBefore, Date.now() + 20_000)
    } else result = await consumeProbeResponse(response, signal)
    Object.assign(attempt, result, { finishedAt: new Date().toISOString() })
  } catch (error) {
    Object.assign(attempt, { state: 'inconclusive', problem: error.name === 'TimeoutError' ? 'timeout' : 'network_or_stream_failure', finishedAt: new Date().toISOString() })
  }
  save()
  console.log(JSON.stringify({ event: 'result', ...attempt }))
  await delay(1200)
  return attempt
}

for (const test of report.cases) {
  if (halt || Date.now() - started >= totalBudgetMs || report.attempts.length >= report.requestBudget) break
  const first = await probe(test)
  test.state = first.state
  test.problem = first.problem
  if (first.state === 'inconclusive' && !halt && (first.problem === 'HTTP_429' || first.problem === 'HTTP_503')) {
    const second = await probe(test)
    test.state = second.state
    test.problem = second.problem
  }
  save()
}
report.allCurrentCasesAccepted = report.cases.every(test => test.state === 'accepted')
// A missing-field control distinguishes the reported gate from transient errors.
if (report.allCurrentCasesAccepted && !halt) {
  const deepseek = report.cases.find(test => test.model === 'deepseek-v4.1-flash-free' && test.effort === 'high')
  if (deepseek) report.controls.push(await probe({ ...deepseek, mode: 'missing-field-control' }, false))
}
report.finishedAt = new Date().toISOString()
report.haltedForQuotaOrWait = halt
save()
console.log(JSON.stringify({ event: 'summary', allCurrentCasesAccepted: report.allCurrentCasesAccepted, tested: report.cases.filter(test => test.state !== 'untested').length, accepted: report.cases.filter(test => test.state === 'accepted').length, total: report.cases.length, attempts: report.attempts.length, output }))
