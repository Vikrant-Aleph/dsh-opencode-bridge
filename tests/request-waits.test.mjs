import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestWaitStore, legacyRequestWaits, requestWaitScope } from '../lib/request-waits.js'

const epoch = Date.parse('2026-10-27T06:57:47.909Z')
const log = (data, ts = epoch) => `${new Date(ts).toISOString()} [WARN ] [adapter] request deferred ${JSON.stringify(data)}`
const record = { code: 'RATE_LIMIT', status: 429, model: 'mimo-v2.6-flash-free', upstreamType: 'FreeUsageLimitError', serverRetryAfterMs: 61_330_000 }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-waits-test-'))
  t.after(() => { const actual = fs.realpathSync(dir); assert.equal(actual, path.resolve(dir)); assert.ok(path.basename(actual).startsWith('request-waits-test-')); fs.rmSync(actual, { recursive: true, force: true }) })
  return path.join(dir, 'state.json')
}

test('only observed actual HTTP waits migrate; global egress guesses and expired/future rows do not', () => {
  const now = epoch + 1000
  const lines = [log(record), log({code:'EGRESS_COOLING',model:'glm-free',retryAfterMs:61_000_000}), log({...record,model:'old-free',serverRetryAfterMs:1}),log({...record,model:'future-free'},now+1), 'broken secret text']
  assert.deepEqual(legacyRequestWaits(lines, now), [['mimo-v2.6-flash-free',epoch+61_330_000]])
})

test('model server deadlines survive reload without shortening or inventing unrelated waits', t => {
  const file = fixture(t); let now = epoch
  const a = new RequestWaitStore(file, undefined, [], () => now)
  a.remember('fixture-free', 60000); a.remember('fixture-free', 1000)
  now += 1000
  const b = new RequestWaitStore(file, undefined, [], () => now)
  assert.equal(b.remaining('fixture-free'), 59000)
  assert.equal(b.remaining('other-free'), 0)
  now += 59000
  assert.equal(b.remaining('fixture-free'), 0)
})

test('first upgrade recovers the affected model from old redacted diagnostics, not pool-wide lockout', t => {
  const file = fixture(t), now = epoch + 2000
  const store = new RequestWaitStore(file, undefined, [log(record)], () => now)
  assert.equal(store.remaining(record.model), 61_328_000)
  assert.equal(store.remaining('glm-free'), 0)
  assert.equal(new RequestWaitStore(file, undefined, [], () => now).remaining(record.model), 61_328_000)
  const text = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(text, /request|http|message|auth|key|bearer/i)
})

test('an unreadable state file is ignored, never rebuilt from the log, and its contents stay out of the log', t => {
  const file = fixture(t)
  fs.writeFileSync(file, '{"version":1,"waits":["SECRET_BAD_ROW"],"overflowUntil":0}')
  const messages = [], logger = { warn: (...args) => messages.push(args), info() {}, debug() {}, error() {} }
  const store = new RequestWaitStore(file, logger, [log(record)], () => epoch)
  // Rebuilding waits from the log would undo a deliberate clear, so a present but
  // unreadable file wins over recovery.
  assert.equal(store.remaining(record.model), 0)
  assert.doesNotMatch(JSON.stringify(messages), /SECRET_BAD_ROW|request-waits-test-|state\.json/)
})

test('a missing state file still recovers observed waits from the log', t => {
  const file = fixture(t)
  const store = new RequestWaitStore(file, undefined, [log(record)], () => epoch)
  assert.equal(store.remaining(record.model), 61_330_000)
})

test('a byte-order mark does not make the state file unreadable', t => {
  const file = fixture(t)
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ version: 2, waits: [['fixture-free', epoch + 60_000, 'direct (this machine)']], overflowUntil: 0 }))
  const store = new RequestWaitStore(file, undefined, [log(record)], () => epoch)
  assert.equal(store.remaining('fixture-free', ['direct (this machine)']), 60_000)
  // A BOM-prefixed file is valid state, so the log is not consulted.
  assert.equal(store.remaining(record.model), 0)
})

test('state capacity conservatively preserves overflow waits across reload', t => {
  const file = fixture(t), now = () => epoch
  const store = new RequestWaitStore(file, undefined, [], now)
  for (let i = 0; i < 257; i++) store.remember(`fixture-${i}`, 60000+i)
  const reloaded = new RequestWaitStore(file, undefined, [], now)
  assert.ok(reloaded.remaining('fixture-256') >= 60256)
  assert.ok(reloaded.remaining('fixture-0') >= 60000)
})

test('an existing state file is authoritative over the log', t => {
  const file = fixture(t), now = () => epoch
  new RequestWaitStore(file, undefined, [], now).remember('glm-free', 90000)
  // The file exists and is valid, so it wins: recovery cannot resurrect a cleared wait.
  const reopened = new RequestWaitStore(file, undefined, [log(record)], now)
  assert.equal(reopened.remaining('glm-free'), 90000)
  assert.equal(reopened.remaining(record.model), 0)
})

test('provider/key scope is stable, isolated and never a credential filename', () => {
  const a = requestWaitScope('https://fixture.invalid/v1','PRIVATE_API_KEY')
  assert.match(a, /^[a-f0-9]{24}$/)
  assert.equal(a,requestWaitScope('https://fixture.invalid/v1','PRIVATE_API_KEY'))
  assert.notEqual(a,requestWaitScope('https://fixture.invalid/v1','OTHER_KEY'))
  assert.notEqual(a,requestWaitScope('https://other.invalid/v1','PRIVATE_API_KEY'))
})
