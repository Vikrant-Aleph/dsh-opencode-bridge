/**
 * Bun-shaped transports for the free-tier gateway.
 *
 * The official client runs on Bun, and the gateway's free lane distinguishes
 * that transport from Node's. Node's own TLS cannot express the shape (the
 * ClientHello is OpenSSL-ordered and lacks the post-quantum key share), so this
 * module delegates the handshake to `wreq-js` (Rust + BoringSSL), configured
 * against a capture of the real client.
 *
 * Verified offline and against the live gateway:
 *  - 17 cipher suites, identical to the capture
 *  - 12 extensions in the captured order
 *  - HTTP/1.1 only, which is what the client itself offers
 *  - streaming SSE arrives incrementally
 *
 * If the module or its native binding is unavailable, callers fall back to the
 * plain fetch path; this layer never becomes a hard dependency for correctness.
 */

export interface BunTransportOptions {
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Explicit proxy URL (`http://`, `socks5://`, …); undefined uses the proxy pool. */
  proxy?: string
}

/** Cipher suites from the captured official ClientHello, in capture order. */
const CIPHER_NAMES: Record<number, string> = {
  0x1301: 'TLS_AES_128_GCM_SHA256',
  0x1302: 'TLS_AES_256_GCM_SHA384',
  0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
  0xc02b: 'ECDHE-ECDSA-AES128-GCM-SHA256',
  0xc02f: 'ECDHE-RSA-AES128-GCM-SHA256',
  0xc02c: 'ECDHE-ECDSA-AES256-GCM-SHA384',
  0xc030: 'ECDHE-RSA-AES256-GCM-SHA384',
  0xcca9: 'ECDHE-ECDSA-CHACHA20-POLY1305',
  0xcca8: 'ECDHE-RSA-CHACHA20-POLY1305',
  0xc009: 'ECDHE-ECDSA-AES128-SHA',
  0xc013: 'ECDHE-RSA-AES128-SHA',
  0xc00a: 'ECDHE-ECDSA-AES256-SHA',
  0xc014: 'ECDHE-RSA-AES256-SHA',
  0x009c: 'AES128-GCM-SHA256',
  0x009d: 'AES256-GCM-SHA384',
  0x002f: 'AES128-SHA',
  0x0035: 'AES256-SHA',
}

const CIPHER_ORDER = [
  0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8,
  0xc009, 0xc013, 0xc00a, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035,
]

/** Extension order from the same capture. */
const EXTENSION_ORDER = [
  0x0017, 0xff01, 0x000a, 0x000b, 0x0023, 0x0010,
  0x0005, 0x000d, 0x0012, 0x0033, 0x002d, 0x002b,
]

export const BUN_CIPHER_LIST = CIPHER_ORDER.map((id) => CIPHER_NAMES[id]).join(':')

/**
 * Signature algorithms in the captured order.
 *
 * `0x0807` is ed25519 (RFC 8446), spelled `ed25519` by BoringSSL, and `0x0603`
 * is ecdsa_secp521r1_sha512, spelled `ECDSA+SHA512` by its legacy parser. With
 * both present the list matches the captured client entry for entry, and the
 * ClientHello is the same length as the official one.
 */
const SIGALGS = [
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha512',
  'ed25519',
  'ECDSA+SHA512',
  'rsa_pkcs1_sha1',
].join(':')

/**
 * The `emulation.tlsOptions` block that reproduces the captured handshake.
 *
 * `curvesList` drops the extra `MLKEM768` group the default profile offers:
 * the captured client advertises `X25519MLKEM768, X25519, P-256, P-384` only,
 * and a deep extension diff showed the extra group as the one remaining
 * supported_groups difference.
 *
 * Exported so tests can assert the shape without loading the native module.
 */
export const BUN_TLS_EMULATION = {
  tlsOptions: {
    alpnProtocols: ['HTTP1'] as const,
    greaseEnabled: false,
    enableEchGrease: false,
    alpsProtocols: [] as const,
    enableOcspStapling: true,
    enableSignedCertTimestamps: true,
    cipherList: BUN_CIPHER_LIST,
    curvesList: 'X25519MLKEM768:X25519:P-256:P-384',
    sigalgsList: SIGALGS,
    extensionPermutation: EXTENSION_ORDER,
    permuteExtensions: false,
  },
}

import { OFFICIAL_ACCEPT_ENCODING } from './opencode-protocol.js'

type WreqTransport = { close: () => Promise<void>; closed?: boolean }

type WreqModule = {
  fetch: (url: string, init: Record<string, unknown>) => Promise<Response>
  createTransport?: (options: Record<string, unknown>) => Promise<WreqTransport>
}

let modulePromise: Promise<WreqModule | null> | undefined

async function loadWreq(): Promise<WreqModule | null> {
  modulePromise ??= import('wreq-js')
    .then((mod) => (typeof mod.fetch === 'function' ? (mod as unknown as WreqModule) : null))
    .catch(() => null)
  return modulePromise
}

/** True when the Bun-shaped transport is available on this machine. */
export async function bunTransportAvailable(): Promise<boolean> {
  return (await loadWreq()) !== null
}

/**
 * Header names and order of the captured official request, with the exact
 * casing it uses. HTTP treats names case-insensitively, but a gate that compares
 * them literally does not, so the wire form is reproduced exactly.
 *
 * Browser emulation would otherwise append Chrome-only headers
 * (`sec-ch-ua*`, `sec-fetch-*`, `priority`, `accept-language`, …) that the
 * official client never sends, which is why defaults are disabled.
 */
const OFFICIAL_HEADER_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['authorization', 'Authorization'],
  ['content-type', 'Content-Type'],
  ['user-agent', 'User-Agent'],
  ['b3', 'b3'],
  ['traceparent', 'traceparent'],
  ['x-opencode-client', 'x-opencode-client'],
  ['x-opencode-project', 'x-opencode-project'],
  ['x-opencode-session', 'x-opencode-session'],
  ['x-opencode-session-id', 'x-opencode-session-id'],
  ['x-session-affinity', 'x-session-affinity'],
  ['x-session-id', 'x-session-id'],
  ['connection', 'Connection'],
  ['accept', 'Accept'],
  // Host, Accept-Encoding and Content-Length are supplied explicitly so they
  // land in the captured positions with the captured casing instead of being
  // appended by the transport at the end.
  ['host', 'Host'],
  ['accept-encoding', 'Accept-Encoding'],
  ['content-length', 'Content-Length'],
] as const

/**
 * Reorder the caller's headers into the official sequence, dropping extras and
 * synthesising the three the transport would otherwise append (`Host`,
 * `Accept-Encoding`, `Content-Length`) so their position and casing match the
 * captured request exactly.
 */
function orderHeaders(url: string, body: string | undefined, init?: RequestInit, input?: RequestInfo | URL): Array<[string, string]> {
  const source = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const lookup = new Map<string, string>()
  source.forEach((value, key) => lookup.set(key.toLowerCase(), value))
  // The official client always offers these encodings; undici-equivalent
  // decoding was verified for gzip, deflate, br and zstd.
  lookup.set('accept-encoding', OFFICIAL_ACCEPT_ENCODING)
  try { lookup.set('host', new URL(url).host) } catch { /* leave unset for a malformed URL */ }
  if (body !== undefined) lookup.set('content-length', String(Buffer.byteLength(body)))
  const ordered: Array<[string, string]> = []
  for (const [lower, wireName] of OFFICIAL_HEADER_ORDER) {
    const value = lower === 'connection' ? 'keep-alive' : lookup.get(lower)
    if (value !== undefined) ordered.push([wireName, value])
  }
  return ordered
}

/**
 * A `fetch`-compatible function that performs the Bun-shaped handshake.
 *
 * Holds one persistent `wreq` Transport, so TCP/TLS connections are pooled
 * across requests exactly as the official client pools them. Verified locally:
 * three sequential requests share one socket with a persistent transport and
 * three sockets without it.
 *
 * A pooled connection is only returned to the pool once its response body has
 * been fully read, which the streaming caller does by consuming the body.
 *
 * Throws when the module is unavailable so callers can fall back.
 */
export async function createBunFetch(options: BunTransportOptions): Promise<typeof fetch> {
  const wreq = await loadWreq()
  if (!wreq) throw new Error('wreq-js is unavailable; cannot use the Bun-shaped transport')

  let transport: WreqTransport | undefined
  if (typeof wreq.createTransport === 'function') {
    transport = await wreq.createTransport({
      browser: 'chrome_149',
      emulation: BUN_TLS_EMULATION,
      // Only the idle timeout is set explicitly: 300s keeps a pooled connection
      // alive across turns without pinning pool limits we do not have evidence
      // for. Pool size and per-host limits stay at the library defaults.
      poolIdleTimeout: 300_000,
      connectTimeout: options.timeoutMs,
      ...(options.proxy ? { proxy: options.proxy } : {}),
    })
  }

  const bunFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = typeof init?.body === 'string' ? init.body : undefined
    // The pool selects an egress per attempt and hands the URL alongside undici's
    // `dispatcher`, which this transport cannot use. Honour the URL so proxy
    // rotation keeps working when the Bun-shaped transport is active.
    const perRequestProxy = (init as { proxyUrl?: string } | undefined)?.proxyUrl
    const proxy = perRequestProxy ?? options.proxy
    const response = await wreq.fetch(url, {
      method: init?.method ?? 'POST',
      body,
      headers: orderHeaders(url, body, init, input),
      // Never let browser emulation add headers the official client does not send.
      disableDefaultHeaders: true,
      timeout: options.timeoutMs,
      ...(proxy ? { proxy } : {}),
      ...(transport ? { transport } : { browser: 'chrome_149', emulation: BUN_TLS_EMULATION }),
      // AbortSignal is not part of wreq's API; the caller's deadline covers it.
    })
    return response as unknown as Response
  }) as typeof fetch & { close?: () => Promise<void> }

  // Let the plugin release pooled connections when it unloads.
  if (transport) bunFetch.close = async () => { await transport!.close().catch(() => {}) }
  return bunFetch
}
