import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestWaitStore } from '../lib/request-waits.js'

/**
 * The cooldown table has to survive three operational realities: a user clearing it
 * by hand, a user changing which egress is in use, and a restart.
 */
const epoch = Date.parse('2026-11-14T00:00:00.000Z')
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-waits-scope-'))
  t.after(() => { fs.rmSync(fs.realpathSync(dir), { recursive: true, force: true }) })
  return path.join(dir, 'state.json')
}

test('an external clear takes effect without a new store instance', t => {
  const file = fixture(t)
  let now = epoch
  const store = new RequestWaitStore(file, undefined, [], () => now)
  store.remember('fixture-free', 60_000, 'direct (this machine)')
  assert.equal(store.remaining('fixture-free'), 60_000)

  // A user (or another process) empties the file; the running instance must notice.
  fs.writeFileSync(file, JSON.stringify({ version: 2, waits: [], overflowUntil: 0 }) + '\n')
  now += 1000
  assert.equal(store.remaining('fixture-free'), 0)
})

test('deleting the state file also clears the wait', t => {
  const file = fixture(t)
  const now = () => epoch
  const store = new RequestWaitStore(file, undefined, [], now)
  store.remember('fixture-free', 60_000)
  assert.equal(store.remaining('fixture-free'), 60_000)

  fs.rmSync(file)
  assert.equal(store.remaining('fixture-free'), 0)
})

test('clear() drops every wait and persists the empty state', t => {
  const file = fixture(t)
  const store = new RequestWaitStore(file, undefined, [], () => epoch)
  store.remember('a-free', 60_000, 'direct (this machine)')
  store.remember('b-free', 90_000, 'http://proxy.example:8080')
  assert.equal(store.snapshot().length, 2)

  assert.equal(store.clear(), 2)
  assert.equal(store.remaining('a-free'), 0)
  assert.equal(store.remaining('b-free'), 0)

  const reread = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(reread.waits, [])
})

test('a wait recorded on an egress that is no longer configured stops applying', t => {
  const file = fixture(t)
  const store = new RequestWaitStore(file, undefined, [], () => epoch)
  store.remember('fixture-free', 60_000, 'http://old-proxy.example:8080')

  // The proxy was removed from the list: the wait belonged to it, not to the model.
  assert.equal(store.remaining('fixture-free', ['direct (this machine)']), 0)
  assert.equal(store.describe('fixture-free', ['direct (this machine)']), undefined)

  // While the egress is still configured the wait holds.
  assert.equal(store.remaining('fixture-free', ['http://old-proxy.example:8080']), 60_000)
  // A caller that does not report egresses keeps the conservative behaviour.
  assert.equal(store.remaining('fixture-free'), 60_000)
})

test('a wait with no recorded egress always applies', t => {
  const file = fixture(t)
  const store = new RequestWaitStore(file, undefined, [], () => epoch)
  store.remember('fixture-free', 60_000) // no egress, e.g. recovered from logs
  assert.equal(store.remaining('fixture-free', ['direct (this machine)']), 60_000)
})

test('describe reports when and where the wait was recorded', t => {
  const file = fixture(t)
  const store = new RequestWaitStore(file, undefined, [], () => epoch)
  store.remember('fixture-free', 60_000, 'http://proxy.example:8080')

  const wait = store.describe('fixture-free', ['http://proxy.example:8080'])
  assert.equal(wait?.until, epoch + 60_000)
  assert.equal(wait?.egress, 'http://proxy.example:8080')
})

test('the egress survives a reload', t => {
  const file = fixture(t)
  const now = () => epoch
  new RequestWaitStore(file, undefined, [], now).remember('fixture-free', 60_000, 'http://proxy.example:8080')
  const reloaded = new RequestWaitStore(file, undefined, [], now)
  assert.equal(reloaded.describe('fixture-free')?.egress, 'http://proxy.example:8080')
})

test('a version 1 file still loads and its rows apply to any egress', t => {
  const file = fixture(t)
  fs.writeFileSync(file, JSON.stringify({ version: 1, waits: [['fixture-free', epoch + 60_000]], overflowUntil: 0 }) + '\n')
  const store = new RequestWaitStore(file, undefined, [], () => epoch)
  assert.equal(store.remaining('fixture-free', ['direct (this machine)']), 60_000)
})
