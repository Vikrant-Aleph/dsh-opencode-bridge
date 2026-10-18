// Contract test for the /api routes: DSH's HostConnectionFetch.register accepts
// { path, methods, requestBody, fetch }. Passing `handler` instead registers
// nothing and the browser sees "HTTP 404", which happened once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLogger } from '../lib/logger.js'
import { LogService, registerLogAccess } from '../lib/log-service.js'
import { ProxyPool } from '../lib/proxy-pool.js'
import { ProxyService, registerProxyAccess } from '../lib/proxy-service.js'

function harness() {
  const routes = []
  const connection = {
    fetch: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['connection'])
      return cb({ ...ctx, connection })
    },
    get: () => undefined,
    effect: (fn) => fn(),
  }
  return { ctx, routes }
}

function assertRouteShape(route, prefix) {
  assert.ok(route.path.startsWith(prefix), `path ${route.path} starts with ${prefix}`)
  assert.deepEqual(route.methods, ['POST'], 'DSH only routes declared methods')
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function', 'route must expose fetch(request), not handler')
}

/** The browser client rejects any other shape as an invalid server-response envelope. */
function assertEnvelope(body, rpcId) {
  assert.equal(body.type, 'server-response', 'envelope type is part of the contract')
  assert.equal(body.rpcId, rpcId)
  assert.ok(body.result, 'the payload lives under result')
  assert.equal(typeof body.result.ok, 'boolean')
}

test('log routes are registered with the documented fetch contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-rpc-'))
  try {
    const logger = new PluginLogger({ level: 'info', dir, maxBytes: 4096, maxFiles: 2 })
    const service = new LogService(logger)
    const { ctx, routes } = harness()
    registerLogAccess(ctx, service)
    assert.equal(routes.length, 4)
    for (const route of routes) assertRouteShape(route, '/api/opencode-bridge-logs/')
    const stat = routes.find((r) => r.path.endsWith('/stat'))
    const response = await stat.fetch(new Request('http://host/api/opencode-bridge-logs/stat', {
      method: 'POST',
      body: JSON.stringify({ rpcId: 'r1', method: 'opencode-bridge-logs/stat', payload: {} }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assertEnvelope(body, 'r1')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.level, 'info')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('proxy routes are registered with the documented fetch contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-rpc-'))
  try {
    const service = new ProxyService(new ProxyPool(['direct']), { storePath: join(dir, 'proxies.json'), baseUrl: 'https://relay.invalid/v1' })
    const { ctx, routes } = harness()
    registerProxyAccess(ctx, service)
    assert.equal(routes.length, 3)
    for (const route of routes) assertRouteShape(route, '/api/opencode-bridge-proxies/')

    const read = routes.find((r) => r.path.endsWith('/read'))
    const response = await read.fetch(new Request('http://host/api/opencode-bridge-proxies/read', {
      method: 'POST',
      body: JSON.stringify({ rpcId: 'r2', method: 'opencode-bridge-proxies/read', payload: {} }),
    }))
    const body = await response.json()
    assertEnvelope(body, 'r2')
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.entries.length, 1)
    assert.equal(body.result.value.entries[0].display, 'direct (this machine)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an endpoint rejects a mismatched method name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-rpc-'))
  try {
    const logger = new PluginLogger({ level: 'off', dir, maxBytes: 4096, maxFiles: 1 })
    const { ctx, routes } = harness()
    registerLogAccess(ctx, new LogService(logger))
    const stat = routes.find((r) => r.path.endsWith('/stat'))
    const response = await stat.fetch(new Request('http://host/api/opencode-bridge-logs/stat', {
      method: 'POST',
      body: JSON.stringify({ rpcId: 'r3', method: 'opencode-bridge-logs/read', payload: {} }),
    }))
    const body = await response.json()
    assertEnvelope(body, 'r3')
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'bad-request')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
