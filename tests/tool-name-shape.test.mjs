import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTools } from '../lib/opencode-protocol.js'

/**
 * The gateway refuses a request whose declared tool names carry separators, and it
 * reports that refusal as `FreeUsageLimitError`, which reads like an exhausted quota.
 * Measured on 2026-11-14: the full UI body (46 tools, 69 KB) was refused with the
 * original names and accepted once the names were reduced to `[a-z0-9]`.
 */
const str = { type: 'string' }
const tool = (name) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: { a: str }, required: ['a'], additionalProperties: false },
})

test('declared tool names carry no separators', () => {
  const plan = planTools([tool('web_search'), tool('job_list'), tool('mcp__exa__web_fetch_exa')])
  for (const declared of plan.tools) {
    assert.match(declared.function.name, /^[a-z0-9]+$/, `unexpected wire name: ${declared.function.name}`)
  }
})

test('a wire name maps back to the caller tool it stands for', () => {
  const plan = planTools([tool('web_search'), tool('job_list')])
  assert.equal(plan.wireToCaller.get('websearch'), 'web_search')
  assert.equal(plan.wireToCaller.get('joblist'), 'job_list')
})

test('names that collapse to the same wire form stay distinct', () => {
  const plan = planTools([tool('web_search'), tool('websearch'), tool('web.search')])
  const names = plan.tools.map((declared) => declared.function.name)
  assert.equal(new Set(names).size, names.length, 'wire names must be unique')
  assert.deepEqual(new Set(plan.wireToCaller.values()), new Set(['web_search', 'websearch', 'web.search']))
})

test('a caller tool already in the accepted shape is declared unchanged', () => {
  const plan = planTools([tool('read'), tool('write')])
  assert.deepEqual(plan.tools.map((declared) => declared.function.name), ['read', 'write'])
  assert.equal(plan.readAnchor, false)
})

test('the recognised anchor is added when every caller name is invented', () => {
  const plan = planTools([tool('codex_sketch')])
  assert.deepEqual(plan.tools.map((declared) => declared.function.name), ['codexsketch', 'read'])
  assert.equal(plan.readAnchor, true)
})

test('a caller name that sanitizes to nothing still yields a usable name', () => {
  const plan = planTools([tool('___')])
  assert.match(plan.tools[0].function.name, /^[a-z0-9]+$/)
})
