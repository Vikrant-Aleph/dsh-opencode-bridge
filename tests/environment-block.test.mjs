import { test } from 'node:test'
import assert from 'node:assert/strict'
import { environmentBlock, defaultEnvironmentBlock, buildChatMessages, planTools } from '../lib/opencode-protocol.js'

/**
 * The gateway refuses a request whose system prompt carries no <env> block,
 * while a prompt containing nothing but that block is accepted. These assertions
 * pin the behaviour the fix depends on (research/bun-env-hypothesis.json).
 */
test('the environment block has the shape the gateway requires', () => {
  const block = environmentBlock('/work/dir', true, 'win32')
  assert.match(block, /^<env>\n/)
  assert.match(block, /\n<\/env>$/)
  assert.match(block, /Working directory: \/work\/dir/)
  assert.match(block, /Is directory a git repo: yes/)
  assert.match(block, /Platform: win32/)
})

test('the git flag is reported honestly', () => {
  assert.match(environmentBlock('/w', true, 'linux'), /Is directory a git repo: yes/)
  assert.match(environmentBlock('/w', false, 'linux'), /Is directory a git repo: no/)
})

test('the default block reflects this process environment', () => {
  const block = defaultEnvironmentBlock()
  assert.match(block, /^<env>/)
  assert.ok(block.includes(process.cwd().split('\\').join('\\')) || block.includes(process.cwd()))
  assert.ok(block.includes(`Platform: ${process.platform}`))
})

test('the environment block follows the caller prompt, as the official client does', () => {
  const env = environmentBlock('/w', false, 'win32')
  const messages = buildChatMessages(
    { system: 'Caller prompt.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    planTools([]),
    undefined,
    { environment: env },
  )
  assert.equal(messages[0].role, 'system')
  // The agent's role and instructions lead; environment facts trail as context.
  assert.ok(messages[0].content.startsWith('Caller prompt.'))
  assert.ok(messages[0].content.endsWith('</env>'))
})

test('a caller that supplies no prompt still gets the environment block', () => {
  const env = environmentBlock('/w', false, 'win32')
  const messages = buildChatMessages(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    planTools([]),
    undefined,
    { environment: env },
  )
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, env)
})

test('omitting the environment block yields no system message', () => {
  const messages = buildChatMessages(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    planTools([]),
    undefined,
    { environment: '' },
  )
  assert.equal(messages.some((m) => m.role === 'system'), false)
})
