import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'
import { PluginLogger } from '../lib/logger.js'
import { requestWaitScope } from '../lib/request-waits.js'

const BASE = 'https://relay.invalid/v1'
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
const ids = models => models.map(model => model.id)
const model = (id, extra = {}) => ({ id, name: id, cost: { input: 0, output: 0 }, ...extra })
const response = body => ({ ok: true, status: 200, json: async () => body })
const registry = models => ({ opencode: { models: Object.fromEntries(models.map(item => [item.id, item])) } })
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
  let source = registry([model('alpha')])
  const fetches = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    assert.equal(String(url), 'https://models.opencode.ai/api.json', `unexpected URL: ${url}`)
    fetches.push({ signal: init.signal })
    const value = source
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
    good(models) { source = registry(models) },
    hold() {
      const gate = deferred()
      source = () => gate.promise
      return { resolve(models) { gate.resolve(response(registry(models))) } }
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

test('plugin startup retires legacy model cooldown files before serving requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-cooldown-boot-'))
  t.after(() => { const actual = realpathSync(directory); assert.equal(actual, directory); rmSync(actual, { recursive: true, force: true }) })
  const file = join(directory, `request-waits-${requestWaitScope(BASE, 'public')}.json`)
  writeFileSync(file, JSON.stringify({ version: 3, waits: [['alpha', Date.now() + 54_000_000, 'direct (this machine)', Date.now() + 60_000, 1]], overflowUntil: 0 }))
  const f = setup(t, { proxyStorePath: join(directory, 'proxies.json') })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved.waits, [])
  assert.equal(saved.overflowUntil, 0)
  await flush()
  assert.deepEqual(ids(await f.adapter.listModels('route-one')), ['alpha'])
})

test('schema defaults to 300000ms and apply starts exactly one immediate catalog prefetch', async t => {
  assert.equal(Config({}).modelRefreshIntervalMs, 300_000)
  const f = setup(t)
  assert.equal(f.config.modelRefreshIntervalMs, 300_000)
  assert.equal(f.catalog.refreshIntervalMs, 300_000)
  await flush()
  assert.equal(f.fetches.length, 1)
  assert.equal(f.registrations.length, 1)
  assert.equal(f.replacements.length, 1)
  assert.deepEqual(f.injections.map(entry => entry.services), [['settings'], ['connection'], ['sessionProjections'], ['connection'], ['connection'], ['tools', 'systemPrompt', 'ptcRuntime']])
  await f.tick(299_999)
  assert.equal(f.fetches.length, 1)
  await f.tick(1)
  assert.equal(f.fetches.length, 2)
  assert.equal(f.replacements.length, 1, 'unchanged snapshot must not invalidate DSH model cache')
})

test('apply forwards zero interval: startup still prefetches but no periodic timer remains', async t => {
  const f = setup(t, { modelRefreshIntervalMs: 0 })
  assert.equal(f.catalog.refreshIntervalMs, 0)
  await flush()
  assert.equal(f.fetches.length, 1)
  assert.equal(f.replacements.length, 1)
  assert.equal(f.timers.size, 0)
  await f.tick(1_800_000)
  assert.equal(f.fetches.length, 1)
  assert.deepEqual(ids(await f.adapter.listModels('route-one')), ['alpha'])
  assert.equal(f.fetches.length, 2, 'on-demand list must still refresh stale cache')
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
  assert.equal(f.fetches.length, 1)
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
  assert.equal(f.fetches.length, 2)
  const discoveryResult = f.discoveries[0].callback({}).then(value => ({ value }), error => ({ error }))
  await f.unload()
  assert.equal(f.disposedRegistrations, 1)
  assert.ok(f.fetches.slice(-1).every(call => call.signal?.aborted))
  assert.equal((await discoveryResult).error?.name, 'AbortError')
  assert.equal(f.timers.size, 0)
  gate.resolve([model('late')])
  await flush()
  await f.tick(1_800_000)
  assert.equal(f.fetches.length, 2)
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
  assert.equal(f.fetches.length, 1)
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
