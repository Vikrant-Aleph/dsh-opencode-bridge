import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProxyPool, fetchWithPool, normalizeEntry, normalizeList, redactProxyUrl, loadProxyStore, saveProxyStore,
} from '../lib/proxy-pool.js'

const clock = () => {
  let now = 1_000_000
  return { now: () => now, advance: (ms) => { now += ms } }
}

test('normalize: bare host:port, direct, unsupported scheme, credentials redacted', () => {
  assert.deepEqual(normalizeEntry('').entry, { id: 'direct', url: '' })
  assert.deepEqual(normalizeEntry('direct').entry, { id: 'direct', url: '' })
  assert.equal(normalizeEntry('127.0.0.1:7890').entry.url, 'http://127.0.0.1:7890')
  assert.equal(normalizeEntry('https://proxy.example:8443/').entry.url, 'https://proxy.example:8443')
  const socks = normalizeEntry('socks5://127.0.0.1:7891')
  assert.equal(socks.ok, true)
  assert.equal(socks.entry.url, 'socks5://127.0.0.1:7891')
  const unsupported = normalizeEntry('ftp://127.0.0.1:7891')
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.reason, /unsupported/)
  assert.equal(normalizeEntry('not a url').ok, false)
  const auth = normalizeEntry('http://user:secret@10.0.0.2:8080')
  assert.ok(auth.entry.url.includes('secret'))
  assert.equal(redactProxyUrl(auth.entry.url), 'http://10.0.0.2:8080')
  assert.doesNotMatch(auth.entry.id, /secret/)
  assert.equal(redactProxyUrl(''), 'direct (this machine)')
})

test('normalizeList dedupes but keeps order and reports unusable entries', () => {
  const { entries, rejected } = normalizeList(['direct', '127.0.0.1:7890', 'http://127.0.0.1:7890/', 'socks5://x:1', 'ftp://x:1'])
  assert.deepEqual(entries.map((e) => e.display ?? e.url), ['', 'http://127.0.0.1:7890', 'socks5://x:1'])
  assert.equal(rejected.length, 1)
})

test('a healthy egress is reused, not round-robin', () => {
  const pool = new ProxyPool(['direct', '127.0.0.1:7890'])
  assert.equal(pool.acquire().index, 0)
  pool.succeeded(0)
  assert.equal(pool.acquire().index, 0, 'a healthy first entry stays selected')
  pool.rateLimited(0)
  assert.equal(pool.acquire().index, 1, 'a cooling entry yields to the next one')
  pool.succeeded(1)
  assert.equal(pool.acquire().index, 1)
})

test('rotation skips a throttled egress and keeps single-proxy behaviour unchanged', async () => {
  const t = clock()
  const pool = new ProxyPool(['direct', 'http://127.0.0.1:7890'], { cooldownMs: 60_000 }, t.now)
  const dispatcherFor = (url) => ({ url })
  const seen = []
  const fetchImpl = async (_url, init) => {
    const egress = init.dispatcher?.url ?? 'direct'
    seen.push(egress)
    return egress === 'direct' ? new Response('{"error":{"message":"429"}}', { status: 429 }) : new Response('{}', { status: 200 })
  }
  const response = await fetchWithPool({ pool, url: 'https://relay.invalid/x', init: {}, dispatcherFor, fetchImpl })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, ['direct', 'http://127.0.0.1:7890'])
  const health = pool.health()
  assert.equal(health[0].state, 'cooling')
  assert.equal(health[1].state, 'ready')
})

test('cooldown expires and the egress re-enters rotation', () => {
  const t = clock()
  const pool = new ProxyPool(['direct', '127.0.0.1:7890'], { cooldownMs: 60_000 }, t.now)
  pool.rateLimited(0)
  assert.equal(pool.health()[0].state, 'cooling')
  assert.equal(pool.acquire().index, 1)
  t.advance(60_001)
  assert.equal(pool.health()[0].state, 'ready')
})

test('retry-after is honoured, escalated and capped', () => {
  const t = clock()
  const pool = new ProxyPool(['direct'], { cooldownMs: 60_000, maxCooldownMs: 120_000 }, t.now)
  pool.rateLimited(0, 5_000)
  assert.ok(pool.health()[0].coolingUntil === t.now() + 5_000)
  pool.rateLimited(0)
  assert.equal(pool.health()[0].failures, 2)
  assert.ok(pool.health()[0].coolingUntil <= t.now() + 120_000)
})

test('all-cooling pool still makes one best-effort attempt', () => {
  const t = clock()
  const pool = new ProxyPool(['direct', '127.0.0.1:7890'], { cooldownMs: 60_000 }, t.now)
  pool.rateLimited(0)
  pool.rateLimited(1)
  assert.ok(pool.waitMs() > 0)
  const lease = pool.acquire()
  assert.equal(lease.cooling, true)
})

test('transport failure retires that egress and surfaces the code', async () => {
  const t = clock()
  const pool = new ProxyPool(['direct', '127.0.0.1:7890'], { cooldownMs: 60_000 }, t.now)
  const events = []
  const response = await fetchWithPool({
    pool, url: 'https://relay.invalid/x', init: {},
    dispatcherFor: (url) => ({ url }),
    onAttempt: (e) => events.push(e),
    fetchImpl: async (_u, init) => {
      if (init.dispatcher?.url) return new Response('{}', { status: 200 })
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNREFUSED' }
      throw error
    },
  })
  assert.equal(response.status, 200)
  assert.equal(events[0].code, 'ECONNREFUSED')
  assert.equal(pool.health()[0].lastCode, 'ECONNREFUSED')
})

test('pool state never exposes proxy credentials in health or redacted urls', () => {
  const pool = new ProxyPool(['http://user:topsecret@10.0.0.2:8080'])
  const encoded = JSON.stringify(pool.health())
  assert.doesNotMatch(encoded, /topsecret/)
  assert.match(encoded, /10\.0\.0\.2:8080/)
})

test('store round-trips, survives corruption, and is created on demand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocf-proxy-'))
  try {
    const file = join(dir, 'nested', 'proxies.json')
    assert.deepEqual(loadProxyStore(file).urls, null)
    assert.equal(saveProxyStore(file, ['', 'http://127.0.0.1:7890']).ok, true)
    assert.deepEqual(loadProxyStore(file).urls, ['', 'http://127.0.0.1:7890'])
    writeFileSync(file, '{not json', 'utf8')
    assert.deepEqual(loadProxyStore(file).urls, null)
    writeFileSync(file, '{"proxies":"nope"}', 'utf8')
    assert.deepEqual(loadProxyStore(file).urls, null)
    // PowerShell and some editors prepend a UTF-8 BOM; it must still load.
    writeFileSync(file, '\uFEFF{"proxies":["direct","http://127.0.0.1:7890"]}', 'utf8')
    assert.deepEqual(loadProxyStore(file).urls, ['direct', 'http://127.0.0.1:7890'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fetchWithPool without a pool stays a plain fetch', async () => {
  const calls = []
  const response = await fetchWithPool({ url: 'https://x.invalid/', init: {}, fetchImpl: async () => { calls.push(1); return new Response('ok') } })
  assert.equal(calls.length, 1)
  assert.ok(response instanceof Response)
})
