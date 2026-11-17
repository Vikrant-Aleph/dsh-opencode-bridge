// Opt-in live A/B. Uses an isolated official CLI and the real plugin transport.
// No user configuration, credentials, conversations or tools are loaded/executed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { createBunFetch } from '../lib/bun-transport.js'
import { environmentBlock } from '../lib/opencode-protocol.js'
import { projectIdentityFor } from '../lib/project-identity.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'

const args = process.argv.slice(2)
const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
if (!args.includes('--run') || !value('--official') || !value('--out')) {
  console.error('Usage: node tests/official-client-ab-live.mjs --run --official <exe> --out <new.json> [--model <id>]')
  process.exit(2)
}
const output = path.resolve(value('--out'))
if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing A/B report')
const model = value('--model') ?? 'deepseek-v4.1-flash-free'
const toolCount = Number(value('--tool-count') ?? 7)
const paddingBytes = Number(value('--padding-bytes') ?? 0)
if (!Number.isInteger(toolCount) || toolCount < 1 || toolCount > 128 || !Number.isInteger(paddingBytes) || paddingBytes < 0 || paddingBytes > 128_000) throw new Error('Invalid bounded synthetic request size')
const executable = path.resolve(value('--official'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-client-ab-'))
const work = path.join(root, 'work')
const prompt = 'Reply with exactly VERIFY_OK. Do not call tools.'
const env = {}
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[key]) env[key] = process.env[key]
for (const key of ['home', 'data', 'cache', 'config', 'state', 'tmp', 'appdata', 'localappdata', 'work']) fs.mkdirSync(path.join(root, key))
Object.assign(env, {
  PATH: [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), path.dirname(process.execPath)].join(path.delimiter),
  USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
  OPENCODE_TEST_HOME: path.join(root, 'home'), OPENCODE_DB: path.join(root, 'data', 'ab.db'),
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_AUTOCOMPACT: '1',
  DO_NOT_TRACK: '1', NO_COLOR: '1', CI: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: `opencode/${model}`, small_model: `opencode/${model}`, enabled_providers: ['opencode'], share: 'disabled', snapshot: false, autoupdate: false, instructions: [], plugin: [], permission: { '*': 'ask' } }),
})

const version = spawnSync(executable, ['--standalone', '--version'], { env, cwd: work, encoding: 'utf8', timeout: 30_000, windowsHide: true })
if (version.status !== 0) throw new Error('Official CLI version check failed')
const officialVersion = /\d+\.\d+\.\d+/.exec(version.stdout)?.[0]
if (!officialVersion) throw new Error('Could not identify the official CLI version')
async function official(label) {
  const at = new Date().toISOString()
  const child = spawn(executable, ['--standalone', '--log-level', 'error', 'run', '--format', 'json', '--title', label, '--model', `opencode/${model}`, prompt], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = '', timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }).finally(() => clearTimeout(timer))
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('')
  const combined = stdout + '\n' + stderr
  const result = { client: label, version: officialVersion, at, exitCode, timedOut, success: text.trim() === 'VERIFY_OK', quotaError: /FreeUsageLimitError|Free usage limit reached/.test(combined), gateError: /FreeTierError/.test(combined), eventTypes: [...new Set(events.map(event => event.type))] }
  // Keep only bounded diagnostics from this fresh synthetic prompt; never store a trace or user files.
  const failure = events.find(event => event.type === 'error')
  if (failure) result.error = JSON.stringify(failure.error ?? failure).replaceAll(root, '<isolated>').slice(0, 1000)
  if (!events.length) result.startupDiagnostic = stderr.replaceAll(root, '<isolated>').slice(-600)
  console.log(JSON.stringify(result))
  return result
}

let transport
const catalog = new FreeModelCatalog({ includeDeprecated: false, extraModels: [], refreshIntervalMs: 0 })
const results = []
try {
  const models = await catalog.refresh()
  const meta = models.find(entry => entry.id === model)
  if (!meta) throw new Error('The selected model is absent from the current free catalog')
  transport = await createBunFetch({ timeoutMs: 90_000 })
  if (!transport) throw new Error('The matching plugin TLS transport is unavailable; do not compare a fallback')
  results.push(await official('official-before'))
  const diagnostics = []
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (scope, event, data) => { if (scope === 'adapter' && data) diagnostics.push({ level, event, ...data }) }]))
  const dump = path.join(root, 'plugin-request.jsonl')
  const adapter = new OpenCodeFreeAdapter(catalog, { providerRoute: 'opencode-bridge', recipe: { baseUrl: 'https://opencode.ai/inference/v1', apiKey: 'public', userAgent: DEFAULT_PROTOCOL_USER_AGENT, client: 'cli', project: projectIdentityFor(work) ?? 'global', extraHeaders: {} }, requestTimeoutMs: 90_000, toolStrict: true, minOutputTokens: 32_000, tracing: true, environment: environmentBlock(work, false), dumpRequestsTo: dump, logger })
  adapter.setTransport(transport)
  const at = new Date().toISOString(), chunks = []
  const names = ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'ask_user_question']
  while (names.length < toolCount) names.push(`fixture_tool_${names.length}`)
  const tools = names.slice(0, toolCount).map(name => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } }))
  const padding = ' Synthetic metadata for request-size comparison.'.repeat(Math.ceil(paddingBytes / 47)).slice(0, paddingBytes)
  for await (const chunk of adapter.stream({ provider: 'opencode-bridge', model, sessionId: 'official-ab', system: 'Follow the user instruction exactly.' + padding, maxTokens: 64, tools, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })) chunks.push(chunk)
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.textDelta ?? chunk.text ?? '').join('')
  const terminal = chunks.at(-1)?.reason
  const diagnostic = diagnostics.find(entry => entry.event === 'stream failed')
  const body = fs.existsSync(dump) ? JSON.parse(fs.readFileSync(dump, 'utf8').trim().split(/\r?\n/)[0]).body : undefined
  const plugin = { client: 'plugin', version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, at, success: text.trim() === 'VERIFY_OK', finish: terminal?.kind, code: terminal?.failure?.code, status: diagnostic?.status, upstreamType: diagnostic?.upstreamType, retryAfterMs: diagnostic?.serverRetryAfterMs, userAgent: DEFAULT_PROTOCOL_USER_AGENT, body: body ? { bytes: Buffer.byteLength(JSON.stringify(body)), sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'), keys: Object.keys(body), tools: body.tools?.map(tool => tool.function.name), max_completion_tokens: body.max_completion_tokens } : null }
  console.log(JSON.stringify(plugin)); results.push(plugin)
  if (results[0].success && !plugin.success) results.push(await official('official-after'))
  const report = { at: new Date().toISOString(), model, prompt, toolCount, paddingBytes, scope: 'Same Windows host and working directory, direct network path, no proxy overrides or saved model cooldowns. Plugin case uses its real adapter and TLS transport with bounded synthetic tool declarations and optional system padding; this is not a complete DSH UI session.', officialVersion, results }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log('Report:', output)
} finally {
  catalog.dispose()
  await transport?.close?.()
  const actual = fs.realpathSync(root)
  if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith('opencode-client-ab-')) throw new Error('Unexpected temporary cleanup target')
  console.log('Cleaning verified isolated directory:', actual)
  fs.rmSync(actual, { recursive: true, force: true })
}
