import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUN_CIPHER_LIST, BUN_TLS_EMULATION, bunTransportAvailable } from '../lib/bun-transport.js'

/**
 * Offline checks of the Bun-shaped transport configuration. These assert the
 * shape only; the live wire capture lives in research/.
 */
test('the cipher list is the captured official suite set, in capture order', () => {
  const names = BUN_CIPHER_LIST.split(':')
  assert.equal(names.length, 17)
  assert.equal(names[0], 'TLS_AES_128_GCM_SHA256')
  assert.equal(names[2], 'TLS_CHACHA20_POLY1305_SHA256')
  // Legacy suites that the capture includes but a default Node client would not.
  assert.ok(names.includes('ECDHE-ECDSA-AES128-SHA'))
  assert.ok(names.includes('AES256-SHA'))
})

test('the extension order is the captured one', () => {
  assert.deepEqual(BUN_TLS_EMULATION.tlsOptions.extensionPermutation, [
    0x0017, 0xff01, 0x000a, 0x000b, 0x0023, 0x0010,
    0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b,
  ])
})

test('the handshake offers HTTP/1.1 only, matching the official client', () => {
  // The official ClientHello advertises exactly ['http/1.1']; offering h2 would
  // change the transcript after the handshake.
  assert.deepEqual(BUN_TLS_EMULATION.tlsOptions.alpnProtocols, ['HTTP1'])
  assert.deepEqual(BUN_TLS_EMULATION.tlsOptions.alpsProtocols, [])
})

test('Chrome-only handshake features are disabled', () => {
  assert.equal(BUN_TLS_EMULATION.tlsOptions.greaseEnabled, false)
  assert.equal(BUN_TLS_EMULATION.tlsOptions.enableEchGrease, false)
  assert.equal(BUN_TLS_EMULATION.tlsOptions.permuteExtensions, false)
  // These two produce the 0x5 and 0x12 extensions the official client sends.
  assert.equal(BUN_TLS_EMULATION.tlsOptions.enableOcspStapling, true)
  assert.equal(BUN_TLS_EMULATION.tlsOptions.enableSignedCertTimestamps, true)
})

test('availability check never throws when the native binding is missing', async () => {
  const available = await bunTransportAvailable()
  assert.equal(typeof available, 'boolean')
})
