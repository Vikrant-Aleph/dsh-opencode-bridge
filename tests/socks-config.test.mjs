import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeEntry, normalizeList, ProxyPool, fetchWithPool, loadProxyStore, redactProxyUrl } from '../lib/proxy-pool.js'
import { ProxyService } from '../lib/proxy-service.js'

for (const protocol of ['socks4', 'socks4a', 'socks5', 'socks5h']) {
  test(`${protocol}: default port and IPv6 proxy host normalize consistently`, () => {
    const value = normalizeEntry(`${protocol}://proxy.example`)
    assert.equal(value.ok, true)
    assert.equal(value.entry.url, `${protocol}://proxy.example:1080`)
    assert.equal(normalizeEntry(`${protocol}://[::1]:1081`).ok, true)
    assert.equal(redactProxyUrl(`${protocol}://user:secret@[::1]:1081`), `${protocol}://[::1]:1081`)
  })
}
test('socks alias deduplicates with socks5h, not with local-DNS socks5', () => {
  const { entries, rejected } = normalizeList(['socks://proxy.example', 'socks5h://proxy.example:1080', 'socks5://proxy.example:1080'])
  assert.equal(entries.length, 2)
  assert.equal(rejected.length, 0)
  assert.deepEqual(entries.map(entry => entry.url), ['socks5h://proxy.example:1080', 'socks5://proxy.example:1080'])
})
test('SOCKS validation rejects unusable paths and auth fields without echoing input', () => {
  for (const url of [
    'socks5://user:SECRET@proxy.example/path', 'socks5://proxy.example?SECRET',
    'socks5://proxy.example#SECRET', 'socks4://user:SECRET@proxy.example',
    'socks5://user:bad%ZZ@proxy.example', 'socks5://user:bad%00@proxy.example',
    'socks5://:SECRET@proxy.example', `socks5://user:${'a'.repeat(256)}@proxy.example`,
    'socks5://proxy.example:99999', 'ftp://user:SECRET@proxy.example',
  ]) {
    const result = normalizeEntry(url)
    assert.equal(result.ok, false, 'invalid proxy must not be accepted')
    assert.doesNotMatch(result.reason, /SECRET|bad%|aaaaa/)
  }
  assert.equal(normalizeEntry('socks4://user@proxy.example').ok, true)
})
test('HTTP(S) default ports remain valid', () => {
  assert.equal(normalizeEntry('http://proxy.example:80').ok, true)
  assert.equal(normalizeEntry('https://proxy.example:443').ok, true)
})
test('service add, bulk replace and restart preserve SOCKS config but never expose its credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-socks-config-'))
  try {
    const storePath = join(dir, 'proxies.json')
    const pool = new ProxyPool(['direct'])
    const service = new ProxyService(pool, { storePath, baseUrl: 'https://relay.invalid' })
    const added = service.write({ add: 'socks5h://user:SECRET@proxy.example:1080' })
    assert.equal(added.saved, true)
    assert.equal(added.rejected.length, 0)
    assert.doesNotMatch(JSON.stringify(service.read()), /SECRET|user:/)
    const restored = new ProxyPool(loadProxyStore(storePath).urls)
    assert.equal(restored.size, 2)
    assert.ok(restored.urls()[1].includes('user:SECRET@'))
    const replaced = service.write({ proxies: ['none', 'socks://proxy.example:1080'] })
    assert.equal(replaced.rejected.length, 0)
    assert.equal(pool.urls()[1], 'socks5h://proxy.example:1080')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('configured proxy with an absent dispatcher fails instead of fetching directly', async () => {
  let fetches = 0
  await assert.rejects(fetchWithPool({
    pool: new ProxyPool(['socks5h://proxy.example:1080']), url: 'https://relay.invalid', init: {},
    dispatcherFor: () => undefined, fetchImpl: async () => { fetches++; return new Response('unexpected') },
  }), /Proxy dispatcher unavailable/)
  assert.equal(fetches, 0)
})
test('cancelled init.signal never marks proxies as broken or attempts any fetch', async () => {
  const pool = new ProxyPool(['socks5h://proxy.example:1080'])
  let called = false
  await assert.rejects(fetchWithPool({
    pool, url: 'https://relay.invalid', init: { signal: AbortSignal.abort() },
    dispatcherFor: () => { called = true },
  }), { name: 'AbortError' })
  assert.equal(called, false)
  assert.equal(pool.health()[0].failures, 0)
})
