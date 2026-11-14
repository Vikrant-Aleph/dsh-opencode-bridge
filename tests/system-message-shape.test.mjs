import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatMessages, defaultEnvironmentBlock, planTools } from '../lib/opencode-protocol.js'

/**
 * The official client sends exactly one system message: its prompt followed by the
 * `<env>` block. A captured DSH request carried two (the environment block first, the
 * harness prompt second), which is a wire shape the official client never produces.
 */
const text = (value) => ({ type: 'text', text: value })

function wire(messages, options = {}) {
  return buildChatMessages(
    { messages, ...options },
    planTools([], { strict: true }),
    undefined,
    { environment: options.environment ?? defaultEnvironmentBlock() },
  )
}

test('a caller-supplied system message is folded into the single leading message', () => {
  const messages = wire(
    [
      { role: 'system', content: [text('You are DSH, a coding agent.')] },
      { role: 'user', content: [text('hi')] },
    ],
    { system: '' },
  )
  const systems = messages.filter((m) => m.role === 'system')
  assert.equal(systems.length, 1, 'the wire must carry exactly one system message')
  assert.match(systems[0].content, /You are DSH/)
  assert.match(systems[0].content, /<env>/, 'the environment block must still be present')
})

test('the environment block trails the prompt, as the official client sends it', () => {
  const messages = wire(
    [
      { role: 'system', content: [text('PROMPT-MARKER')] },
      { role: 'user', content: [text('hi')] },
    ],
    { system: '' },
  )
  const system = messages.find((m) => m.role === 'system')
  assert.ok(system, 'a system message is required')
  assert.ok(
    system.content.indexOf('PROMPT-MARKER') < system.content.indexOf('<env>'),
    'the prompt must come before the environment block',
  )
})

test('several caller system messages collapse into one', () => {
  const messages = wire(
    [
      { role: 'system', content: [text('first')] },
      { role: 'system', content: [text('second')] },
      { role: 'user', content: [text('hi')] },
    ],
    { system: '' },
  )
  const systems = messages.filter((m) => m.role === 'system')
  assert.equal(systems.length, 1)
  assert.match(systems[0].content, /first[\s\S]*second/)
})

test('a caller that omits the environment gets no block', () => {
  const messages = wire([{ role: 'user', content: [text('hi')] }], { environment: '' })
  assert.equal(messages.filter((m) => m.role === 'system').length, 0)
})

test('no system message is emitted when nothing supplies one', () => {
  const messages = buildChatMessages(
    { messages: [{ role: 'user', content: [text('hi')] }] },
    planTools([], { strict: true }),
  )
  assert.equal(messages.filter((m) => m.role === 'system').length, 0)
})
