// Real loopback TCP/SOCKS/TLS tests: no external network or user proxy configuration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import net from 'node:net'
import { Agent } from 'undici'
import { createSocksDispatcher } from '../lib/socks-dispatcher.js'
import { ProxyPool, dispatcherFor, clearDispatchers, fetchWithPool } from '../lib/proxy-pool.js'
import { bounded, ca, origin, socksServer, waitFor } from './helpers/socks-server.mjs'

const TEST = { timeout: 7000 }
const request = (url, dispatcher) => fetch(url, { dispatcher, signal: AbortSignal.timeout(1800) })
function resources(t) {
  const stack = []
  t.after(async () => {
    const errors = []
    for (const resource of stack.reverse()) {
      try { await bounded(resource.close()) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed')
  })
  return resource => { stack.push(resource); return resource }
}
function safeFailure(error, code, secret) {
  assert.equal(error.cause?.code, code)
  if (secret) assert.ok(!inspect(error, { depth: 20 }).includes(secret), 'error must not expose proxy credentials')
  return true
}

for (const [scheme, version, remoteDns] of [
  ['socks5h', 5, true], ['socks', 5, true], ['socks5', 5, false],
  ['socks4a', 4, true], ['socks4', 4, false],
]) {
  test(`${scheme}: real CONNECT and fetch preserve the required DNS mode`, TEST, async t => {
    const keep = resources(t)
    const target = keep(await origin())
    const proxy = keep(await socksServer({ targetPort: target.port }))
    const client = keep(createSocksDispatcher(proxy.url(scheme, version === 4 ? 'test-user' : '')))
    const hostname = remoteDns ? 'not-in-local-dns.socks.test' : 'localhost'
    const response = await request(`http://${hostname}:${target.port}/dns-check`, client.dispatcher)
    assert.equal(await bounded(response.text()), 'through SOCKS')
    assert.equal(proxy.handshakes.length, 1)
    const handshake = proxy.handshakes[0]
    assert.equal(handshake.version, version)
    assert.equal(handshake.port, target.port)
    if (remoteDns) {
      assert.equal(handshake.atyp, 3)
      assert.equal(handshake.host, hostname)
    } else {
      assert.notEqual(handshake.atyp, 3)
      assert.ok(net.isIP(handshake.host), 'locally resolved address must be on the wire')
    }
    if (version === 4) assert.equal(handshake.userId, 'test-user')
    assert.equal(target.requests.length, 1)
    assert.equal(target.requests[0].host, `${hostname}:${target.port}`)
  })
}

test('SOCKS5 RFC1929 authentication percent-decodes username and password on the wire', TEST, async t => {
  const keep = resources(t)
  const target = keep(await origin())
  const auth = { username: 'test@user', password: 'test:p%ss word' }
  const proxy = keep(await socksServer({ targetPort: target.port, auth }))
  const client = keep(createSocksDispatcher(proxy.url('socks5h', `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}`)))
  const response = await request(`http://auth.socks.test:${target.port}/`, client.dispatcher)
  assert.equal(await bounded(response.text()), 'through SOCKS')
  assert.deepEqual(proxy.credentials, [auth])
})

test('SOCKS5 wrong authentication fails closed without echoing the secret', TEST, async t => {
  const keep = resources(t)
  const target = keep(await origin())
  const proxy = keep(await socksServer({ targetPort: target.port, auth: { username: 'user', password: 'right' } }))
  const secret = 'socks-secret-DO-NOT-ECHO'
  const client = keep(createSocksDispatcher(proxy.url('socks5h', `user:${secret}`)))
  await assert.rejects(request(`http://127.0.0.1:${target.port}/`, client.dispatcher), error => safeFailure(error, 'SOCKS_NEGOTIATION_FAILED', secret))
  assert.equal(proxy.credentials.length, 1)
  assert.equal(target.requests.length, 0, 'authentication failure must never fall back to direct')
})

for (const [label, hostname, trust, success] of [
  ['explicit test CA succeeds', 'origin.socks.test', true, true],
  ['default trust rejects test CA', 'origin.socks.test', false, false],
  ['trusted CA still rejects wrong hostname', 'wrong.socks.test', true, false],
]) {
  test(`HTTPS through SOCKS: ${label}; origin never receives plaintext HTTP`, TEST, async t => {
    const keep = resources(t)
    const target = keep(await origin({ tls: true }))
    const proxy = keep(await socksServer({ targetPort: target.port }))
    const client = keep(createSocksDispatcher(proxy.url(), trust ? { ca } : {}))
    const pending = request(`https://${hostname}:${target.port}/tls-check`, client.dispatcher)
    if (success) {
      const response = await pending
      assert.equal(await bounded(response.text()), 'through SOCKS')
      assert.equal(target.requests.length, 1)
    } else {
      await assert.rejects(pending, error => safeFailure(error, 'SOCKS_TLS_FAILED'))
      assert.equal(target.requests.length, 0)
    }
    assert.equal(proxy.handshakes[0].host, hostname)
    await waitFor(() => proxy.tunneledBytes.length > 0)
    for (const bytes of proxy.tunneledBytes) {
      assert.equal(bytes[0], 0x16, 'first origin record must be a TLS handshake')
      assert.ok(!bytes.toString().startsWith('GET '), 'HTTPS cannot be sent as plaintext')
    }
  })
}

test('negotiation rejection, proxy disconnect and stalled handshake fail without direct fallback', TEST, async t => {
  const keep = resources(t)
  const target = keep(await origin())
  for (const [behavior, code] of [['reject', 'SOCKS_NEGOTIATION_FAILED'], ['disconnect', 'SOCKS_NEGOTIATION_FAILED'], ['stall', 'SOCKS_TIMEOUT']]) {
    const proxy = keep(await socksServer({ behavior, targetPort: target.port }))
    const client = keep(createSocksDispatcher(proxy.url(), { connectTimeoutMs: 150 }))
    await assert.rejects(request(`http://127.0.0.1:${target.port}/${behavior}`, client.dispatcher), error => safeFailure(error, code))
    assert.equal(proxy.accepted, 1)
    await waitFor(() => proxy.sockets.size === 0)
    assert.equal(target.requests.length, 0)
  }
})

test('one fetchWithPool really rotates from a 429 SOCKS tunnel to a second SOCKS tunnel', TEST, async t => {
  const keep = resources(t)
  t.after(() => bounded(clearDispatchers()))
  const throttled = keep(await origin({ status: 429, body: 'limited' }))
  const healthy = keep(await origin({ body: 'second egress' }))
  // Both proxies receive the same destination port; the second maps it to its own loopback origin.
  const first = keep(await socksServer({ targetPort: throttled.port }))
  const second = keep(await socksServer({ targetPort: throttled.port, forwardPort: healthy.port }))
  const pool = new ProxyPool([first.url(), second.url()])
  const attempts = []
  const response = await bounded(fetchWithPool({ pool, url: `http://rotation.socks.test:${throttled.port}/rotate`,
    init: { signal: AbortSignal.timeout(1800) }, onAttempt: event => attempts.push(event) }))
  assert.equal(response.status, 200)
  assert.equal(await bounded(response.text()), 'second egress')
  assert.equal(first.handshakes.length, 1)
  assert.equal(second.handshakes.length, 1)
  assert.equal(throttled.requests.length, 1)
  assert.equal(healthy.requests.length, 1)
  assert.deepEqual(attempts.map(({ status, rotated }) => ({ status, rotated })), [{ status: 429, rotated: true }, { status: 200, rotated: false }])
})

test('parallel dispatcherFor shares one real Agent; clear releases connected and pending sockets', TEST, async t => {
  const keep = resources(t)
  t.after(() => bounded(clearDispatchers()))
  const target = keep(await origin())
  const proxy = keep(await socksServer({ targetPort: target.port }))
  const agents = await bounded(Promise.all(Array.from({ length: 20 }, () => dispatcherFor(proxy.url()))))
  assert.ok(agents[0] instanceof Agent)
  assert.ok(agents.every(agent => agent === agents[0]))
  const response = await request(`http://cache.socks.test:${target.port}/`, agents[0])
  await bounded(response.text())
  assert.ok(proxy.sockets.size > 0)
  const stalled = keep(await socksServer({ behavior: 'stall' }))
  const pendingAgent = await dispatcherFor(stalled.url())
  const outcome = request(`http://127.0.0.1:${target.port}/pending`, pendingAgent).then(() => ({ ok: true }), error => ({ error }))
  await bounded(stalled.seen)
  await bounded(clearDispatchers())
  assert.equal((await bounded(outcome)).error?.cause?.code, 'SOCKS_DISPATCHER_CLOSED')
  await waitFor(() => proxy.sockets.size === 0 && stalled.sockets.size === 0)
  const replacement = await dispatcherFor(proxy.url())
  assert.notEqual(replacement, agents[0], 'clear must discard the cached agent')
})

test('explicit close cancels hanging SOCKS negotiation and destroys established tunnel sockets', TEST, async t => {
  const keep = resources(t)
  const target = keep(await origin())
  const proxy = keep(await socksServer({ targetPort: target.port }))
  const client = keep(createSocksDispatcher(proxy.url()))
  const response = await request(`http://close.socks.test:${target.port}/`, client.dispatcher)
  await bounded(response.text())
  await bounded(client.close())
  await waitFor(() => proxy.sockets.size === 0 && target.sockets.size === 0)
  const stalled = keep(await socksServer({ behavior: 'stall' }))
  const pendingClient = keep(createSocksDispatcher(stalled.url()))
  const outcome = request(`http://127.0.0.1:${target.port}/pending`, pendingClient.dispatcher).then(() => ({ ok: true }), error => ({ error }))
  await bounded(stalled.seen)
  await bounded(pendingClient.close())
  assert.equal((await bounded(outcome)).error?.cause?.code, 'SOCKS_DISPATCHER_CLOSED')
  await waitFor(() => stalled.sockets.size === 0)
  await bounded(pendingClient.close()) // idempotent
})
