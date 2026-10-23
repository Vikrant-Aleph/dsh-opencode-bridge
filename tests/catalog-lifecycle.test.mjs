import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { PluginLogger } from '../lib/logger.js'

const BASE = 'https://relay.invalid/v1'
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
const ids = models => models.map(model => model.id)
const model = (id, extra = {}) => ({ id, name: id, cost: { input: 0, output: 0 }, ...extra })
const response = body => ({ ok: true, status: 200, json: async () => body })
const registry = models => ({ opencode: { models: Object.fromEntries(models.map(item => [item.id, item])) } })
const live = models => ({ data: models.map(item => ({ id: item.id })) })
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

function setup(t, overrides = {}, { replaceAvailable = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-catalog-lifecycle-'))
  // Both logger and proxy-store paths are isolated from the real DSH profile.
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let now = 1_000_000
  const timers = new Map()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const timer = { unref() { return this } }
    timers.set(timer, { at: now + Number(delay), fn })
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer))
  let source = { registry: registry([model('alpha')]), live: live([model('alpha')]) }
  const fetches = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const kind = String(url) === 'https://models.dev/api.json' ? 'registry' : 'live'
    assert.ok(kind === 'registry' || String(url) === `${BASE}/models`, `unexpected URL: ${url}`)
    fetches.push({ kind, signal: init.signal })
    const value = source[kind]
    return typeof value === 'function' ? value() : response(value)
  })
  const warnings = []
  t.mock.method(PluginLogger.prototype, 'warn', (...args) => { warnings.push(args) })
  const effects = []
  const injections = []
  const registrations = []
  const replacements = []
  const discoveries = []
  const configurable = []
  let disposedRegistrations = 0
  let unloaded = false
  let registeredAdapter
  const handle = () => { disposedRegistrations++ }
  if (replaceAvailable) handle.replace = providers => {
    assert.equal(disposedRegistrations, 0, 'registration must remain live while routes are replaced')
    replacements.push({ providers: [...providers], adapter: registeredAdapter })
  }
  const ctx = {
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    inject(services, callback) {
      // Optional connection/tools services are intentionally absent: no UI/RPC/tool side effects.
      injections.push({ services, callback })
      return () => {}
    },
    emit() { throw new Error('catalog integration must use registration.replace, never fake ctx.emit') },
    llm: {
      registerAdapter(providers, adapter) {
        registeredAdapter = adapter
        registrations.push({ providers: [...providers], adapter })
        return handle
      },
      registerConfigurableProviders(providers) { configurable.push(providers) },
      registerModelDiscovery(provider, callback) { discoveries.push({ provider, callback }) },
    },
  }
  const config = {
    ...Config({}), baseUrl: BASE, providers: ['route-one', 'route-two'],
    logLevel: 'off', logDir: join(dir, 'logs'), proxyStorePath: join(dir, 'missing-proxies.json'),
    ...overrides,
  }
  apply(ctx, config)
  const unload = async () => {
    if (unloaded) return
    unloaded = true
    for (const dispose of [...effects].reverse()) await dispose()
  }
  t.after(unload)
  return {
    config, fetches, timers, registrations, replacements, discoveries, configurable, warnings, injections,
    adapter: registeredAdapter,
    // TS private fields are ordinary JS properties: inspect disposal without adding production hooks.
    catalog: registeredAdapter.catalog,
    get disposedRegistrations() { return disposedRegistrations },
    good(models) { source = { registry: registry(models), live: live(models) } },
    hold() {
      const r = deferred(), l = deferred()
      source = { registry: () => r.promise, live: () => l.promise }
      return { resolve(models) { r.resolve(response(registry(models))); l.resolve(response(live(models))) } }
    },
    unload,
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

test('schema defaults to 600000ms and apply starts exactly one immediate catalog prefetch', async t => {
  assert.equal(Config({}).modelRefreshIntervalMs, 600_000)
  const f = setup(t)
  assert.equal(f.config.modelRefreshIntervalMs, 600_000)
  assert.equal(f.catalog.refreshIntervalMs, 600_000)
  await flush()
  assert.equal(f.fetches.length, 2)
  assert.equal(f.registrations.length, 1)
  assert.equal(f.replacements.length, 1)
  assert.deepEqual(f.injections.map(entry => entry.services), [['settings'], ['connection'], ['sessionProjections'], ['connection'], ['connection'], ['tools']])
  await f.tick(599_999)
  assert.equal(f.fetches.length, 2)
  await f.tick(1)
  assert.equal(f.fetches.length, 4)
  assert.equal(f.replacements.length, 1, 'unchanged snapshot must not invalidate DSH model cache')
})

test('apply forwards zero interval: startup still prefetches but no periodic timer remains', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 0 })
  assert.equal(f.catalog.refreshIntervalMs, 0)
  await flush()
  assert.equal(f.fetches.length, 2)
  assert.equal(f.replacements.length, 1)
  assert.equal(f.timers.size, 0)
  await f.tick(1_800_000)
  assert.equal(f.fetches.length, 2)
  assert.deepEqual(ids(await f.adapter.listModels('route-one')), ['alpha'])
  assert.equal(f.fetches.length, 4, 'on-demand list must still refresh stale cache')
  assert.equal(f.replacements.length, 1)
})

test('changed catalog atomically replaces identical routes on the same live adapter without unregistering', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 60_000 })
  await flush()
  const originalAdapter = f.registrations[0].adapter
  assert.deepEqual(f.registrations[0].providers, ['route-one', 'route-two'])
  await f.tick(60_000)
  assert.equal(f.replacements.length, 1)
  f.good([model('alpha'), model('beta')])
  await f.tick(60_000)
  assert.equal(f.replacements.length, 2)
  f.good([model('beta')])
  await f.tick(60_000)
  assert.equal(f.replacements.length, 3)
  f.good([model('beta', { name: 'New beta', limit: { context: 4096, output: 512 } })])
  await f.tick(60_000)
  assert.equal(f.replacements.length, 4)
  await f.tick(60_000)
  assert.equal(f.replacements.length, 4)
  assert.equal(f.registrations.length, 1)
  assert.equal(f.disposedRegistrations, 0)
  for (const replacement of f.replacements) {
    assert.deepEqual(replacement.providers, ['route-one', 'route-two'])
    assert.equal(replacement.adapter, originalAdapter)
  }
})

test('registered discovery and adapter listModels share the refreshed catalog without duplicate HTTP', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 60_000 })
  assert.equal(f.discoveries.length, 1)
  assert.equal(f.discoveries[0].provider, 'opencode-bridge')
  const discover = f.discoveries[0].callback
  const initial = await discover({})
  assert.deepEqual(ids(initial), ['alpha'])
  await flush()
  assert.equal(f.fetches.length, 2)
  f.good([model('new', { name: 'New model', limit: { context: 8192, output: 1024 } })])
  await f.tick(60_000)
  const before = f.fetches.length
  const [discovered, adapted] = await Promise.all([discover({}), f.adapter.listModels('route-two')])
  assert.deepEqual(discovered, [{ id: 'new', name: 'New model', contextWindow: 8192, maxTokens: 1024 }])
  assert.deepEqual(ids(adapted), ['new'])
  assert.equal(adapted[0].provider, 'route-two')
  assert.equal(f.fetches.length, before)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(discover({}, controller.signal), { name: 'AbortError' })
})

test('reverse effect unload aborts pending refresh and rejects discovery before late results can replace routes', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 60_000 })
  await flush()
  const gate = f.hold()
  await f.tick(60_000)
  assert.equal(f.fetches.length, 4)
  const discoveryResult = f.discoveries[0].callback({}).then(value => ({ value }), error => ({ error }))
  await f.unload()
  assert.equal(f.disposedRegistrations, 1)
  assert.ok(f.fetches.slice(-2).every(call => call.signal?.aborted))
  assert.equal((await discoveryResult).error?.name, 'AbortError')
  assert.equal(f.timers.size, 0)
  gate.resolve([model('late')])
  await flush()
  await f.tick(1_800_000)
  assert.equal(f.fetches.length, 4)
  assert.equal(f.replacements.length, 1)
  await assert.rejects(f.catalog.list(), { name: 'AbortError' })
  await assert.rejects(f.catalog.refresh(), { name: 'AbortError' })
  await assert.rejects(f.adapter.listModels('route-one'), { name: 'AbortError' })
})

test('unload clears an idle periodic timer without any subsequent fetch or replacement', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 60_000 })
  await flush()
  assert.equal(f.timers.size, 1)
  await f.unload()
  assert.equal(f.timers.size, 0)
  await f.tick(1_800_000)
  assert.equal(f.fetches.length, 2)
  assert.equal(f.replacements.length, 1)
  assert.equal(f.disposedRegistrations, 1)
})

test('old registration handles without replace warn only once while discovery and adapter models still update', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 60_000 }, { replaceAvailable: false })
  await flush()
  f.good([model('beta')])
  await f.tick(60_000)
  f.good([model('gamma')])
  await f.tick(60_000)
  assert.deepEqual(ids(await f.discoveries[0].callback({})), ['gamma'])
  assert.deepEqual(ids(await f.adapter.listModels('route-one')), ['gamma'])
  assert.equal(f.registrations.length, 1)
  assert.equal(f.disposedRegistrations, 0)
  assert.equal(f.replacements.length, 0)
  assert.equal(f.warnings.filter(([scope, message]) => scope === 'catalog' && message.includes('page reload')).length, 1)
})
