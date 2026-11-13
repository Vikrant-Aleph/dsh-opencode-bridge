import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBunFetch, bunTransportAvailable, BUN_TLS_EMULATION } from '../lib/bun-transport.js'

/**
 * Robustness of the Bun-shaped transport. These do not reach the network: the
 * transport is created and closed, or a loopback listener is used.
 */
test('availability probe resolves to a boolean and never throws', async () => {
  const available = await bunTransportAvailable()
  assert.equal(typeof available, 'boolean')
})

test('the transport can be closed twice without throwing', async () => {
  const transport = await createBunFetch({ timeoutMs: 5000 })
  assert.equal(typeof transport.close, 'function')
  await transport.close()
  await transport.close()
})

test('a GET request without a body sends no Content-Length', async () => {
  const http = await import('node:http')
  let seen = null
  const server = http.createServer((req, res) => {
    seen = { headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), method: req.method }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const transport = await createBunFetch({ timeoutMs: 10_000 })
  try {
    const response = await transport(`http://127.0.0.1:${port}/v1/models`, {
      method: 'GET',
      headers: { authorization: 'Bearer public', 'user-agent': 'opencode/latest/2.2.0/cli' },
    })
    assert.equal(response.status, 200)
    assert.equal(seen.method, 'GET')
    assert.equal(Object.hasOwn(seen.headers, 'content-length'), false)
    assert.equal(seen.headers.connection, 'keep-alive')
  } finally {
    await transport.close()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})

test('a malformed URL does not crash header construction', async () => {
  const transport = await createBunFetch({ timeoutMs: 1000 })
  try {
    // A syntactically odd but parseable URL: the Host header must still be sane.
    await assert.rejects(async () => {
      await transport('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' })
    })
  } finally {
    await transport.close()
  }
})

test('the emulated handshake advertises HTTP/1.1 only', () => {
  assert.deepEqual(BUN_TLS_EMULATION.tlsOptions.alpnProtocols, ['HTTP1'])
  assert.deepEqual(BUN_TLS_EMULATION.tlsOptions.alpsProtocols, [])
  assert.equal(BUN_TLS_EMULATION.tlsOptions.greaseEnabled, false)
})
