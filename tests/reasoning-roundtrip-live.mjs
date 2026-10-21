// Opt-in verification through the REAL adapter projection, not a body rewrite.
// Only a canned fixture tool result is supplied; no filesystem tool is executed.
import fs from 'node:fs'
import path from 'node:path'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (!args.includes('--run') || outIndex < 0 || !args[outIndex + 1]) {
  console.error('Usage: node tests/reasoning-roundtrip-live.mjs --run --out <new-report.json>')
  process.exit(2)
}
const output = path.resolve(args[outIndex + 1])
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an earlier report')
fs.mkdirSync(path.dirname(output), { recursive: true })
const report = { startedAt: new Date().toISOString(), version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, model: 'deepseek-v4.1-flash-free', syntheticOnly: true, actualToolsExecuted: 0, posts: [], steps: [], diagnostics: [] }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (scope, message, data = {}) => {
  const keep = Object.fromEntries(Object.entries(data).filter(([key]) => ['code', 'status', 'reason', 'upstreamType', 'retryAfterMs', 'serverRetryAfterMs', 'outputStarted'].includes(key)))
  if (level === 'warn' || level === 'error') report.diagnostics.push({ level, scope, message, ...keep })
}]))
const base = 'https://opencode.ai/inference/v1'
const catalog = new FreeModelCatalog(base, { includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 }, logger)
const originalFetch = globalThis.fetch
let expectedReasoning
let sent = 0
let failed = false
save()
try {
  const models = await catalog.refresh()
  const meta = models.find(model => model.id === report.model)
  if (!meta || !meta.efforts?.some(effort => effort.id === 'high')) throw new Error('Required free model/high effort is not currently advertised')
  const tool = { name: 'read', description: 'Returns a synthetic fixture string for protocol verification. This tool does not access a filesystem.', parameters: { type: 'object', properties: { file_path: { type: 'string', enum: ['fixture.txt'] } }, required: ['file_path'], additionalProperties: false } }
  const adapter = new OpenCodeFreeAdapter(catalog, {
    providerRoute: 'opencode-bridge', recipe: { baseUrl: base, apiKey: 'public', userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', client: 'cli', project: 'global', extraHeaders: {} },
    requestTimeoutMs: 90_000, toolFingerprint: true, toolTranslation: true, logger,
  })
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/chat/completions')) {
      if (++sent > 2) throw new Error('Live POST budget exceeded')
      const body = JSON.parse(init.body)
      const assistants = body.messages.filter(message => message.role === 'assistant')
      const row = { step: sent, endpoint: String(url), reasoningEffort: body.reasoning_effort, assistantCount: assistants.length, allAssistantFieldsPresent: assistants.every(message => Object.hasOwn(message, 'reasoning_content') && typeof message.reasoning_content === 'string') }
      if (sent === 2) {
        row.replayedExactly = assistants.length === 1 && assistants[0].reasoning_content === expectedReasoning
        row.reasoningCharacters = expectedReasoning.length
        if (!row.replayedExactly || !row.allAssistantFieldsPresent) throw new Error('Actual adapter projection did not preserve reasoning before POST')
      }
      report.posts.push(row)
      save()
    }
    return originalFetch(url, init)
  }
  const user = { id: 'fixture_user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'First call read_client with file_path fixture.txt, with no other arguments. The fixture tool supplies a result. Only after receiving that tool result, respond with exactly its text. Do not invent the result or call other tools.' }] }
  const options = { provider: 'opencode-bridge', model: report.model, system: 'Use the supplied synthetic fixture tool once, then return its result and finish. Never access real files.', messages: [user], tools: [tool], reasoningEffort: 'high', maxTokens: 512, sessionId: 'reasoning-roundtrip-synthetic' }
  const first = []
  for await (const chunk of adapter.stream(options)) first.push(chunk)
  const terminal = first.at(-1)?.reason
  report.steps.push({ step: 1, kind: terminal?.kind, ...(terminal?.failure ? { code: terminal.failure.code, status: terminal.failure.status } : {}) })
  const blocks = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  const calls = blocks.filter(block => block.type === 'tool-call')
  expectedReasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  report.initialReasoningCharacters = expectedReasoning.length
  if (terminal?.kind !== 'tool-calls' || !calls.length) throw new Error('First live step did not yield a complete tool call; no second request sent')
  for (const call of calls) {
    const value = JSON.parse(call.arguments)
    if (call.name !== 'read' || value.file_path !== 'fixture.txt' || Object.keys(value).some(key => key !== 'file_path')) throw new Error('Returned call is outside the synthetic fixture contract; nothing executed')
  }
  const history = [user,
    { id: 'fixture_assistant', role: 'assistant', source: { kind: 'model', provider: 'opencode-bridge', model: report.model }, content: blocks },
    ...calls.map((call, index) => ({ id: `fixture_result_${index}`, role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: 'ROUNDTRIP_OK' }] })),
  ]
  const second = []
  for await (const chunk of adapter.stream({ ...options, messages: history })) second.push(chunk)
  const end = second.at(-1)?.reason
  const text = second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  report.steps.push({ step: 2, kind: end?.kind, answerMatches: text.trim() === 'ROUNDTRIP_OK', ...(end?.failure ? { code: end.failure.code, status: end.failure.status } : {}) })
  report.passed = end?.kind === 'stop' && text.trim() === 'ROUNDTRIP_OK' && report.posts[1]?.replayedExactly === true
  if (!report.passed) failed = true
} catch (error) {
  failed = true
  report.passed = false
  report.problem = error instanceof SyntaxError ? 'invalid_fixture_json' : error instanceof Error ? error.message : 'verification failed'
} finally {
  globalThis.fetch = originalFetch
  catalog.dispose()
  report.finishedAt = new Date().toISOString()
  save()
}
console.log(JSON.stringify(report, null, 2))
process.exitCode = failed ? 1 : 0
