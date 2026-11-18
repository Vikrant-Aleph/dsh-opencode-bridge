import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  environmentBlock, environmentInstructions, defaultEnvironmentInstructions,
  gitRootOf, opencodeTmpDir, escapeSystemUpdateText, systemUpdateBlock,
  buildChatMessages, planTools, requiresReasoningReplay,
} from '../lib/opencode-protocol.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'
import { DEFAULT_PROTOCOL_USER_AGENT } from '../lib/protocol-defaults.js'

// These pin the preventive fidelity fixes (official-client invariants that are NOT
// current gate requirements): built-in date/intro/5th env line, official derivations,
// frozen baseline + <system-update>, always-on output limit, catalog reasoning field,
// and official body key order.

test('env block carries the fifth tmp-preference line and a distinct workspace root', () => {
  const block = environmentBlock('/work/sub', true, 'linux', '/work', '/tmp/opencode')
  assert.match(block, /Working directory: \/work\/sub/)
  assert.match(block, /Workspace root folder: \/work\n/)
  assert.match(block, /Prefer \/tmp\/opencode over generic system temporary directories such as \/tmp/)
  assert.match(block, /\n<\/env>$/)
})

test('git root is discovered upward, not just at cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'fidelity-git-'))
  try {
    mkdirSync(join(root, '.git'))
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    assert.equal(gitRootOf(nested), root)
    const bare = mkdtempSync(join(tmpdir(), 'fidelity-nogit-'))
    try { assert.equal(gitRootOf(bare), undefined) } finally { rmSync(bare, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('instructions wrap the env block with the frozen date and intro, joined by \\n', () => {
  const env = environmentBlock('/w', false, 'linux')
  const text = environmentInstructions(env, 'Wed Nov 18 2026')
  assert.ok(text.startsWith("Today's date: Wed Nov 18 2026\n\n"))
  assert.ok(text.includes('Here is some useful information about the environment you are running in:\n<env>'))
  const messages = buildChatMessages(
    { system: 'PROMPT', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    planTools([]), undefined, { environment: text },
  )
  assert.equal(messages[0].content, `PROMPT\n${text}`)
})

test('system-update wrapper XML-escapes and is a user-message payload', () => {
  assert.equal(escapeSystemUpdateText('a<b>&c'), 'a&lt;b&gt;&amp;c')
  assert.equal(systemUpdateBlock('x<y>'), '<system-update>\nx&lt;y&gt;\n</system-update>')
})

test('a catalog reasoning field forces replay even for non-DeepSeek names', () => {
  assert.equal(requiresReasoningReplay({ id: 'big-pickle', reasoningField: 'reasoning_content' }, 'big-pickle', 'https://opencode.ai/inference/openai/v1'), true)
  assert.equal(requiresReasoningReplay({ id: 'glm-5.3-flash-free' }, 'glm-5.3-flash-free', 'https://opencode.ai/inference/openai/v1'), false)
})

const recipe = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'public', userAgent: DEFAULT_PROTOCOL_USER_AGENT, client: 'cli', project: 'global', extraHeaders: {} }
const ok = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')

test('primary body: official key order, always-on output limit, catalog reasoning replay, frozen baseline', async t => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { bodies.push(JSON.parse(init.body)); return ok() })
  const catalog = { list: async () => [{ id: 'big-pickle', name: 'Big Pickle', reasoningField: 'reasoning_content', maxOutputTokens: 32000 }] }
  const adapter = new OpenCodeFreeAdapter(catalog, { providerRoute: 'opencode-bridge', recipe, requestTimeoutMs: 1000 })
  const input = {
    provider: 'opencode-bridge', model: 'big-pickle', sessionId: 'fidelity-session',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    tools: [],
  }
  for await (const _ of adapter.stream(input)) { /* drain */ }
  for await (const _ of adapter.stream(input)) { /* drain */ }
  const [a, b] = bodies
  assert.deepEqual(Object.keys(a).slice(0, 6), ['model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens'])
  assert.equal(a.max_completion_tokens, 32000, 'catalog-derived limit is always present')
  const assistant = a.messages.find(m => m.role === 'assistant')
  assert.equal(assistant.reasoning_content, '', 'catalog reasoning field replays empty string')
  assert.equal(a.messages[0].content, b.messages[0].content, 'baseline frozen across requests')
  assert.ok(a.messages[0].content.startsWith("Today's date:"))
})
