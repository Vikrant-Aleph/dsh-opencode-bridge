import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreeModelCatalog } from '../lib/catalog.js'
import { OpenCodeFreeAdapter } from '../lib/adapter.js'

// No network and no real waiting: even abort-ignoring transports are controlled.
const BASE = 'https://relay.invalid/v1'
const TTL = 600_000
const BACKOFF = 60_000
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const ids = models => models.map(model => model.id)
const meta = (id, extra = {}) => ({ id, name: id, cost: { input: 0, output: 0 }, ...extra })
const registry = models => ({ opencode: { models: Object.fromEntries(models.map(model => [model.id, model])) } })
const live = models => ({ data: models.map(id => ({ id })) })
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(t, options = {}) {
  let now = 1_000_000
  let nextTimer = 0
  const timers = new Map()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0, ...args) => {
    const timer = { id: ++nextTimer, unref() { return this }, ref() { return this } }
    timers.set(timer, { at: now + Number(delay), fn: () => fn(...args) })
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer) })
  const calls = []
  let source = { registry: registry([meta('alpha')]), live: live(['alpha']) }
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const kind = String(url) === 'https://models.dev/api.json' ? 'registry' : 'live'
    assert.ok(kind === 'registry' || String(url) === `${BASE}/models`, `unexpected network URL: ${url}`)
    const call = { kind, url: String(url), signal: init.signal }
    calls.push(call)
    const value = source[kind]
    if (typeof value === 'function') return value(call)
    if (value instanceof Error) throw value
    return response(value)
  })
  const catalog = new FreeModelCatalog(BASE, { includeDeprecated: false, extraModels: [], ...options })
  t.after(() => catalog.dispose())
  return {
    catalog, calls, timers,
    set: (registryValue, liveValue) => { source = { registry: registryValue, live: liveValue } },
    good: models => { source = { registry: registry(models), live: live(models.map(model => model.id)) } },
    async tick(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

function holdRound(f) {
  const registryGate = deferred()
  const liveGate = deferred()
  f.set(() => registryGate.promise, () => liveGate.promise)
  return {
    resolve(models) {
      registryGate.resolve(response(registry(models)))
      liveGate.resolve(response(live(models.map(model => model.id))))
    },
    registryGate, liveGate,
  }
}

function observed(promise) {
  const state = { settled: false }
  state.done = promise.then(value => { state.settled = true; state.value = value }, error => {
    state.settled = true; state.error = error
  })
  return state
}

test('list caches for ten minutes; refresh bypasses TTL and atomically reflects additions, removals and prices', async t => {
  const f = setup(t)
  assert.deepEqual(ids(await f.catalog.list()), ['alpha'])
  f.good([meta('beta'), meta('alpha', { cost: { input: 0, output: 1 } })])
  await f.tick(TTL - 1)
  assert.deepEqual(ids(await f.catalog.list()), ['alpha'])
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  assert.deepEqual(ids(await f.catalog.list()), ['beta'])
  f.good([meta('gamma')])
  assert.deepEqual(ids(await f.catalog.refresh()), ['gamma'])
  assert.deepEqual(ids(await f.catalog.list()), ['gamma'])
  assert.equal(f.calls.length, 6)
})

test('valid empty success is cached, including replacement of a nonempty snapshot', async t => {
  const f = setup(t)
  await f.catalog.list()
  f.good([])
  assert.deepEqual(await f.catalog.refresh(), [])
  await f.tick(TTL - 1)
  assert.deepEqual(await f.catalog.list(), [])
  assert.equal(f.calls.length, 4, 'empty snapshots must not cause repeated fetches')
  await f.tick(1)
  await f.catalog.list()
  assert.equal(f.calls.length, 6)
})

for (const kind of ['registry', 'live']) {
  for (const failure of ['network', 'HTTP', 'malformed JSON', 'invalid structure']) {
    test(`${kind} ${failure} preserves the entire previous snapshot and backs off list for 60 seconds`, async t => {
      const f = setup(t)
      const first = await f.catalog.list()
      const bad = failure === 'network' ? new Error('offline')
        : failure === 'HTTP' ? () => response({}, 503)
          : failure === 'malformed JSON' ? () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON') } })
            : kind === 'registry' ? { opencode: { models: [] } } : { data: {} }
      const goodRegistry = registry([meta('replacement')])
      const goodLive = live(['replacement'])
      f.set(kind === 'registry' ? bad : goodRegistry, kind === 'live' ? bad : goodLive)
      await f.tick(TTL)
      assert.deepEqual(await f.catalog.list(), first)
      assert.equal(f.calls.length, 4)
      await f.tick(BACKOFF - 1)
      assert.deepEqual(await f.catalog.list(), first)
      assert.equal(f.calls.length, 4)
      f.good([meta('recovered')])
      await f.tick(1)
      assert.deepEqual(ids(await f.catalog.list()), ['recovered'])
      assert.equal(f.calls.length, 6)
    })
  }
}

test('initial failure returns empty and list observes backoff while explicit refresh can retry immediately', async t => {
  const f = setup(t)
  f.set(new Error('offline'), live([]))
  assert.deepEqual(await f.catalog.list(), [])
  assert.deepEqual(await f.catalog.list(), [])
  assert.equal(f.calls.length, 2)
  f.good([meta('recovered')])
  assert.deepEqual(ids(await f.catalog.refresh()), ['recovered'])
  assert.equal(f.calls.length, 4)
})

test('invalid source containers or rows are failures rather than successful empty listings', async t => {
  const f = setup(t)
  await f.catalog.list()
  for (const [r, l] of [
    [{}, live([])], [registry([]), {}], [null, live([])], [registry([]), null],
    [{ opencode: { models: { broken: null } } }, live([])],
    [registry([]), { data: [null] }], [registry([]), { data: [{ notId: 'missing' }] }],
    [registry([]), { data: [{ id: '' }] }],
  ]) {
    f.set(r, l)
    assert.deepEqual(ids(await f.catalog.refresh()), ['alpha'])
  }
})

test('concurrent list and refresh callers share exactly one pair of source fetches', async t => {
  const f = setup(t)
  const gate = holdRound(f)
  const waiting = [f.catalog.list(), f.catalog.list(), f.catalog.refresh(), f.catalog.refresh()]
  await flush()
  assert.equal(f.calls.length, 2)
  gate.resolve([meta('shared')])
  for (const result of await Promise.all(waiting)) assert.deepEqual(ids(result), ['shared'])
  assert.equal(f.calls.length, 2)
})

test('aborting one caller rejects only that waiter; shared source signals and other callers survive', async t => {
  const f = setup(t)
  const gate = holdRound(f)
  const controller = new AbortController()
  const aborted = observed(f.catalog.list(controller.signal))
  const survivor = f.catalog.refresh()
  await flush()
  controller.abort()
  await flush()
  assert.equal(aborted.settled, true)
  assert.equal(aborted.error?.name, 'AbortError')
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every(call => !call.signal.aborted))
  gate.resolve([meta('shared')])
  assert.deepEqual(ids(await survivor), ['shared'])
  await aborted.done
})

test('pre-aborted callers reject even when a cached snapshot exists', async t => {
  const f = setup(t)
  await f.catalog.list()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.catalog.list(controller.signal), { name: 'AbortError' })
  await assert.rejects(f.catalog.refresh(controller.signal), { name: 'AbortError' })
  assert.equal(f.calls.length, 2)
})

test('default total fetch timeout is 30 seconds; abort-ignoring late results cannot overwrite a newer snapshot', async t => {
  const updates = []
  const f = setup(t, { onUpdated: models => updates.push(ids(models)) })
  await f.catalog.list()
  const gate = holdRound(f)
  const pending = observed(f.catalog.refresh())
  await flush()
  await f.tick(29_999)
  assert.equal(pending.settled, false)
  await f.tick(1)
  assert.equal(pending.settled, true, 'deadline must settle even if fetch ignores abort')
  assert.equal(pending.error, undefined, 'timeout degrades to cache')
  assert.deepEqual(ids(pending.value), ['alpha'])
  assert.ok(f.calls.slice(-2).every(call => call.signal.aborted))
  f.good([meta('newer')])
  assert.deepEqual(ids(await f.catalog.refresh()), ['newer'])
  const notified = updates.length
  gate.resolve([meta('late')])
  await flush()
  assert.deepEqual(ids(await f.catalog.list()), ['newer'])
  assert.equal(updates.length, notified)
  await pending.done
})

test('configured total timeout includes response JSON decoding, not merely receiving headers', async t => {
  const f = setup(t, { fetchTimeoutMs: 125 })
  await f.catalog.list()
  const body = deferred()
  f.set(() => ({ ok: true, status: 200, json: () => body.promise }), live(['late']))
  const pending = observed(f.catalog.refresh())
  await flush()
  await f.tick(124)
  assert.equal(pending.settled, false)
  await f.tick(1)
  assert.equal(pending.settled, true)
  assert.deepEqual(ids(pending.value), ['alpha'])
  body.resolve(registry([meta('late')]))
  await flush()
  assert.deepEqual(ids(await f.catalog.list()), ['alpha'])
})

test('start immediately prefetches, defaults to ten minutes, and returns a disposer', async t => {
  const f = setup(t)
  const dispose = f.catalog.start()
  assert.equal(typeof dispose, 'function')
  await flush()
  assert.equal(f.calls.length, 2)
  await f.tick(TTL - 1)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  assert.equal(f.calls.length, 4)
  dispose()
  await f.tick(TTL * 3)
  assert.equal(f.calls.length, 4)
})

test('refreshIntervalMs zero disables periodic work but preserves startup prefetch and on-demand TTL', async t => {
  const f = setup(t, { refreshIntervalMs: 0 })
  f.catalog.start()
  await flush()
  assert.equal(f.calls.length, 2)
  assert.equal(f.timers.size, 0)
  await f.tick(TTL * 2)
  assert.equal(f.calls.length, 2)
  await f.catalog.list()
  assert.equal(f.calls.length, 4)
})

test('small positive intervals clamp to 60 seconds; repeat start creates no second task', async t => {
  const f = setup(t, { refreshIntervalMs: 1 })
  f.catalog.start()
  f.catalog.start()
  f.catalog.start()
  await flush()
  assert.equal(f.calls.length, 2)
  await f.tick(59_999)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  assert.equal(f.calls.length, 4)
  await f.tick(60_000)
  assert.equal(f.calls.length, 6)
})

test('periodic scheduling is completion-relative with no overlap or catch-up storm', async t => {
  const f = setup(t, { refreshIntervalMs: 60_000, fetchTimeoutMs: 300_000 })
  const gate = holdRound(f)
  f.catalog.start()
  await flush()
  await f.tick(120_000)
  assert.equal(f.calls.length, 2)
  gate.resolve([meta('ready')])
  await flush()
  f.good([meta('next')])
  await f.tick(59_999)
  assert.equal(f.calls.length, 2)
  await f.tick(1)
  assert.equal(f.calls.length, 4)
})

test('dispose stops timers, aborts in-flight background work, rejects related waiters and blocks late publication', async t => {
  const updates = []
  const f = setup(t, { refreshIntervalMs: 60_000, onUpdated: models => updates.push(ids(models)) })
  const gate = holdRound(f)
  const dispose = f.catalog.start()
  const waiter = observed(f.catalog.list())
  await flush()
  dispose()
  f.catalog.dispose()
  await flush()
  assert.ok(f.calls.every(call => call.signal?.aborted))
  assert.equal(waiter.settled, true)
  assert.equal(waiter.error?.name, 'AbortError')
  assert.equal(f.timers.size, 0)
  gate.resolve([meta('too-late')])
  await flush()
  await f.tick(TTL * 3)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(updates, [])
  await assert.rejects(f.catalog.list(), { name: 'AbortError' })
  await assert.rejects(f.catalog.refresh(), { name: 'AbortError' })
  await waiter.done
})

test('onUpdated only reports actual snapshot changes; callback exceptions do not break cache or periodic refresh', async t => {
  const updates = []
  const f = setup(t, { refreshIntervalMs: 60_000, onUpdated(models) {
    updates.push(models.map(model => ({ ...model })))
    throw new Error('consumer failure')
  } })
  f.catalog.start()
  await flush()
  assert.deepEqual(ids(await f.catalog.list()), ['alpha'])
  assert.equal(updates.length, 1)
  await f.catalog.refresh()
  assert.equal(updates.length, 1)
  f.good([meta('alpha', { name: 'New name', limit: { context: 1234, output: 100 } })])
  assert.equal((await f.catalog.refresh())[0].contextWindow, 1234)
  assert.equal(updates.length, 2, 'metadata changes count even when IDs do not change')
  f.set(new Error('offline'), live([]))
  await f.catalog.refresh()
  assert.equal(updates.length, 2)
  f.good([])
  await f.tick(60_000)
  assert.deepEqual(await f.catalog.list(), [])
  assert.equal(updates.length, 3)
  await f.catalog.refresh()
  assert.equal(updates.length, 3)
})

test('only input AND output zero are free; known paid/deprecated -free IDs cannot re-enter through fallback', async t => {
  const f = setup(t, { extraModels: ['manual', 'offline-extra'] })
  const known = [
    meta('allowed'), meta('paid-free', { cost: { input: 0, output: 1 } }),
    meta('input-paid-free', { cost: { input: 1, output: 0 } }),
    meta('unknown-output-free', { cost: { input: 0 } }),
    meta('deprecated-free', { status: 'deprecated' }), meta('not-live'),
  ]
  f.set(registry(known), live(['allowed', 'paid-free', 'input-paid-free', 'unknown-output-free', 'deprecated-free', 'new-free', 'big-pickle', 'unknown-paid', 'manual']))
  const models = await f.catalog.list()
  assert.deepEqual(ids(models), ['allowed', 'big-pickle', 'manual', 'new-free', 'offline-extra'])
  assert.equal(models.find(model => model.id === 'offline-extra').live, false)
  assert.equal(models.find(model => model.id === 'manual').live, true)
})

test('adapter listModels reuses the catalog snapshot and sees refresh changes without another fetch', async t => {
  const f = setup(t)
  const adapter = new OpenCodeFreeAdapter(f.catalog, {})
  const gate = holdRound(f)
  const direct = f.catalog.list()
  const adapted = adapter.listModels('opencode')
  await flush()
  assert.equal(f.calls.length, 2)
  gate.resolve([meta('alpha')])
  assert.deepEqual(ids(await direct), ['alpha'])
  assert.deepEqual(ids(await adapted), ['alpha'])
  f.good([meta('beta', { name: 'Updated beta', modalities: { input: ['text', 'image'] } })])
  await f.catalog.refresh()
  const discovered = await adapter.listModels('opencode')
  assert.deepEqual(ids(discovered), ['beta'])
  assert.equal(discovered[0].provider, 'opencode')
  assert.equal(discovered[0].name, 'Updated beta')
  assert.deepEqual(discovered[0].inputModalities, ['text', 'image'])
  assert.equal(f.calls.length, 4)
})

test('includeDeprecated allows zero-cost deprecated models but not paid models', async t => {
  const f = setup(t, { includeDeprecated: true })
  f.good([meta('old-free', { status: 'deprecated' }), meta('paid-free', { cost: { input: 0, output: 1 } })])
  assert.deepEqual(ids(await f.catalog.list()), ['old-free'])
})
