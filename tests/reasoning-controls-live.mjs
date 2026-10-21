// Opt-in bounded Jev A/B controls; no real tools, private files or user history.
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildChatMessages, planTools, buildHeaders, mintSessionId, mintRequestId } from '../lib/opencode-protocol.js'
import { retryAfterMs } from '../lib/retry-after.js'
import { consumeProbeResponse } from './helpers/reasoning-probe-reader.mjs'

const args = process.argv.slice(2)
const index = args.indexOf('--out')
if (!args.includes('--run') || index < 0 || !args[index + 1]) { console.error('Usage: --run --out <new-report.json>'); process.exit(2) }
const output = path.resolve(args[index + 1])
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an earlier control report')
fs.mkdirSync(path.dirname(output), { recursive: true })
const recipe = { baseUrl: 'https://opencode.ai/inference/v1', apiKey: 'public', userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', client: 'cli', project: 'global', extraHeaders: {} }
const tool = { name: 'read', description: 'Read synthetic fixture text only.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false } }
const plan = planTools([tool])
const report = { startedAt: new Date().toISOString(), model: 'jev-1.13-free', endpoint: `${recipe.baseUrl}/chat/completions`, syntheticOnly: true, cases: [] }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
let notBefore = 0
save()
for (const history of ['tool', 'text']) for (const emptyField of [true, false]) {
  if (Date.now() < notBefore) {
    const wait = notBefore - Date.now()
    if (wait > 120_000) { report.stoppedForServerWait = wait; save(); console.log(JSON.stringify(report)); process.exit(0) }
    await delay(wait)
  }
  const messages = history === 'tool' ? [
    { role: 'user', content: [{ type: 'text', text: 'Use the synthetic fixture tool result below and reply only OK.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_reasoning_fixture', name: 'read', arguments: JSON.stringify({ file_path: 'fixture.txt' }) }] },
    { role: 'tool', toolCallId: 'call_reasoning_fixture', content: [{ type: 'text', text: 'OK' }] },
  ] : [
    { role: 'user', content: [{ type: 'text', text: 'This is a synthetic protocol check.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixture received.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] },
  ]
  const wire = buildChatMessages({ system: 'This is a protocol compatibility test. A fixture tool result is already supplied. Reply only OK. Do not call any tools.', messages }, plan).map(message => {
    if (message.role !== 'assistant') return message
    const result = { ...message }
    if (emptyField) result.reasoning_content = ''
    else delete result.reasoning_content
    return result
  })
  const session = mintSessionId()
  const body = { model: report.model, messages: wire, stream: true, tools: plan.tools, tool_choice: 'auto', prompt_cache_key: session.replace(/^ses_/, ''), max_tokens: 64 }
  const row = { history, emptyField, sentAt: new Date().toISOString() }
  report.cases.push(row)
  save()
  try {
    const signal = AbortSignal.timeout(45_000)
    const response = await fetch(report.endpoint, { method: 'POST', headers: buildHeaders(recipe, session, mintRequestId()), body: JSON.stringify(body), signal })
    row.status = response.status
    const wait = retryAfterMs(response)
    if (wait !== undefined) { row.retryAfterMs = wait; notBefore = Date.now() + wait }
    if (response.ok) Object.assign(row, await consumeProbeResponse(response, signal))
    else {
      const text = await response.text()
      row.state = 'not_accepted'
      // These requests contain synthetic data only. Keep bounded error detail to
      // distinguish field rejection from an already-invalid baseline request.
      row.errorPreview = text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1500)
      if (response.status === 429) { report.stoppedForThrottle = true; save(); console.log(JSON.stringify(row)); process.exit(0) }
    }
  } catch (error) { row.state = 'inconclusive'; row.problem = error.name }
  row.finishedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify(row))
  await delay(1200)
}
report.finishedAt = new Date().toISOString()
save()
console.log(JSON.stringify({ event: 'controls_complete', output }))
