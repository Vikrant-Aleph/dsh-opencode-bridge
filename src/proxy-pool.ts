/**
 * Egress pool for the relay.
 *
 * Some quota failures are egress-scoped; only ready configured exits may be
 * selected. Request-scoped errors and server-requested waits must not be
 * bypassed by immediate failover. Entries are the machine's IP ("direct") or an
 * HTTP(S) CONNECT or SOCKS proxy.
 *
 * Selection/state are testable independently of I/O; fetch and per-proxy
 * dispatcher helpers below are shared by inference and connectivity tests.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { retryAfterMs } from './retry-after.js'
export { retryAfterMs } from './retry-after.js'

/** One configured egress: an empty url means "use this machine's IP". */
export interface ProxyEntry {
  id: string
  url: string
}

export interface ProxyHealth {
  /** Stable, credential-free identity. */
  id: string
  /** URL with credentials removed; safe to show in the UI and logs. */
  display: string
  state: 'ready' | 'cooling'
  coolingUntil?: number
  failures: number
  lastCode?: string
}

export interface PoolOptions {
  /** Base cooldown after a rate-limit rejection. */
  cooldownMs?: number
  /** Upper bound for locally generated cooldowns (never a cap on server hints). */
  maxCooldownMs?: number
  /** Injectable randomness for non-negative fallback jitter. */
  random?: () => number
}

export const DIRECT_ID = 'direct'
const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 30 * 60_000
const CONNECT_FAILURE_COOLDOWN_MS = 15_000

interface Slot {
  entry: ProxyEntry
  coolingUntil: number
  failures: number
  lastCode?: string
}

/**
 * Normalize one user-provided entry: bare `host:port` (HTTP), HTTP(S)/SOCKS
 * proxy URL, or the literal `direct`/empty string for the local IP.
 */
export function normalizeEntry(raw: string): { ok: true; entry: ProxyEntry } | { ok: false; reason: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.toLowerCase() === 'direct' || text.toLowerCase() === 'none') {
    return { ok: true, entry: { id: DIRECT_ID, url: '' } }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }
  const supported = ['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']
  if (!supported.includes(url.protocol)) {
    return { ok: false, reason: 'unsupported proxy protocol; use HTTP(S), SOCKS4/4a or SOCKS5/5h' }
  }
  if (!url.hostname) return { ok: false, reason: 'a proxy needs a host' }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, reason: 'proxy URLs must not contain a path, query or fragment' }
  }
  if (url.protocol === 'socks:') url.protocol = 'socks5h:'
  if (url.protocol.startsWith('socks')) {
    if (!url.port) url.port = '1080'
    try {
      const user = decodeURIComponent(url.username)
      const password = decodeURIComponent(url.password)
      if (user.includes('\0') || password.includes('\0')) return { ok: false, reason: 'proxy credentials cannot contain NUL' }
      if (url.protocol.startsWith('socks4') && password) return { ok: false, reason: 'SOCKS4 supports a user ID, not password authentication; use SOCKS5' }
      if (url.protocol.startsWith('socks5') && (Buffer.byteLength(user) > 255 || Buffer.byteLength(password) > 255 || (!user && password))) {
        return { ok: false, reason: 'SOCKS5 credentials require a username and at most 255 bytes per field' }
      }
    } catch {
      return { ok: false, reason: 'proxy credentials contain invalid URL encoding' }
    }
  }
  // Credentials stay in the private URL, never in the outward-facing id/display.
  const canonicalUrl = url.toString().replace(/\/$/, '')
  const digest = createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 8)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return { ok: true, entry: { id: `proxy:${url.hostname}:${port}#${digest}`, url: canonicalUrl } }
}

/** Remove userinfo so a URL can be logged or displayed. */
export function redactProxyUrl(url: string): string {
  if (!url) return 'direct (this machine)'
  try {
    const parsed = new URL(url)
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${parsed.protocol}//${parsed.hostname}${port}`
  } catch {
    return 'invalid proxy url'
  }
}

/** Normalize a whole list, dropping duplicates while keeping the first position. */
export function normalizeList(raw: readonly string[]): { entries: ProxyEntry[]; rejected: Array<{ raw: string; reason: string }> } {
  const entries: ProxyEntry[] = []
  const rejected: Array<{ raw: string; reason: string }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    const result = normalizeEntry(item)
    if (!result.ok) {
      rejected.push({ raw: redactProxyUrl(String(item)), reason: result.reason })
      continue
    }
    if (seen.has(result.entry.id)) continue
    seen.add(result.entry.id)
    entries.push(result.entry)
  }
  return { entries, rejected }
}

/**
 * Ordered egress selection with per-entry cooldowns.
 *
 * A healthy pool keeps using the earliest entry, so one profile normally keeps
 * one egress IP; a throttled or unreachable entry is retired for its cooldown.
 * acquire() returns only ready entries. A fully cooling pool refuses network
 * work until a deadline expires; the caller can report the remaining wait.
 */
export class ProxyPool {
  private slots: Slot[] = []
  private readonly cooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number
  private readonly random: () => number

  constructor(entries: readonly string[] = [], options: PoolOptions = {}, now: () => number = Date.now) {
    const base = options.cooldownMs
    this.cooldownMs = typeof base === 'number' && Number.isFinite(base) ? Math.max(1000, base) : DEFAULT_COOLDOWN_MS
    const cap = options.maxCooldownMs
    this.maxCooldownMs = Math.max(this.cooldownMs, typeof cap === 'number' && Number.isFinite(cap) ? cap : MAX_COOLDOWN_MS)
    this.now = now
    this.random = options.random ?? Math.random
    this.replace(entries)
  }

  get size(): number {
    return this.slots.length
  }

  /** Replace the configured egresses, preserving cooldown state for kept ids. */
  replace(entries: readonly string[]): void {
    const { entries: normalized } = normalizeList(entries)
    const list = normalized.length ? normalized : [{ id: DIRECT_ID, url: '' }]
    const previous = new Map(this.slots.map((slot) => [slot.entry.id, slot]))
    this.slots = list.map((entry) => previous.get(entry.id) ?? { entry, coolingUntil: 0, failures: 0 })
  }

  entryAt(index: number): ProxyEntry | undefined {
    return this.slots[index]?.entry
  }

  /** Raw entries including any credentials; never send these to the UI. */
  rawEntries(): ProxyEntry[] {
    return this.slots.map((slot) => slot.entry)
  }

  /** Remove one entry by its credential-free id. Returns false when absent. */
  removeById(id: string): boolean {
    const index = this.slots.findIndex((slot) => slot.entry.id === id)
    if (index < 0) return false
    this.slots.splice(index, 1)
    // A pool is never empty: removing the last entry restores the local IP.
    if (!this.slots.length) this.slots.push({ entry: { id: DIRECT_ID, url: '' }, coolingUntil: 0, failures: 0 })
    return true
  }

  /** Append one entry; returns false when it is a duplicate. */
  add(raw: string): { ok: boolean; reason?: string } {
    const result = normalizeEntry(raw)
    if (!result.ok) return { ok: false, reason: result.reason }
    if (this.slots.some((slot) => slot.entry.id === result.entry.id)) return { ok: false, reason: 'already in the pool' }
    // A pool that was only "direct" gains a proxy without losing the local IP.
    this.slots.push({ entry: result.entry, coolingUntil: 0, failures: 0 })
    return { ok: true }
  }

  /** Earliest ready egress; excluded IDs prevent repeating an exit in one request. */
  acquire(excluded: ReadonlySet<string> = new Set()): { index: number; cooling: false } | null {
    const now = this.now()
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[index]
      if (!excluded.has(slot.entry.id) && slot.coolingUntil <= now) return { index, cooling: false }
    }
    return null
  }

  /** Match an in-flight response to its exit even after live edits reorder the pool. */
  indexOf(id: string): number {
    return this.slots.findIndex(slot => slot.entry.id === id)
  }

  /** A probe is subject to the same deadlines as an inference request. */
  waitAt(index: number): number {
    const until = this.slots[index]?.coolingUntil ?? 0
    return Math.max(0, Math.ceil(until - this.now()))
  }

  /** Milliseconds until the next entry becomes usable again (0 when ready). */
  waitMs(): number {
    if (!this.slots.length) return 0
    const now = this.now()
    if (this.slots.some((slot) => slot.coolingUntil <= now)) return 0
    return Math.min(...this.slots.map((slot) => slot.coolingUntil)) - now
  }

  succeeded(index: number): void {
    const slot = this.slots[index]
    // An earlier request or metadata probe cannot erase a concurrent throttle.
    if (!slot || slot.coolingUntil > this.now()) return
    slot.failures = 0
    slot.coolingUntil = 0
    delete slot.lastCode
  }

  /** Rate limit (or any "this egress is exhausted" answer). */
  rateLimited(index: number, retryAfterMs?: number): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.failures += 1
    slot.lastCode = 'RATE_LIMIT'
    const escalated = Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** Math.min(52, slot.failures - 1))
    const random = this.random()
    const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0
    const wait = Number.isFinite(retryAfterMs) && (retryAfterMs as number) > 0
      ? retryAfterMs as number
      : Math.min(this.maxCooldownMs, Math.ceil(escalated * (1 + 0.2 * jitter)))
    const now = this.now()
    slot.coolingUntil = Math.max(slot.coolingUntil, Math.min(Number.MAX_SAFE_INTEGER, now + wait))
  }

  /** Transport failure: unreachable proxy, DNS, reset. Short cooldown. */
  failed(index: number, code: string): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.failures += 1
    slot.lastCode = code
    slot.coolingUntil = Math.max(slot.coolingUntil, this.now() + Math.min(CONNECT_FAILURE_COOLDOWN_MS, this.cooldownMs))
  }

  health(): ProxyHealth[] {
    const now = this.now()
    return this.slots.map((slot) => ({
      id: slot.entry.id,
      display: redactProxyUrl(slot.entry.url),
      state: slot.coolingUntil > now ? 'cooling' : 'ready',
      ...(slot.coolingUntil > now ? { coolingUntil: slot.coolingUntil } : {}),
      failures: slot.failures,
      ...(slot.lastCode ? { lastCode: slot.lastCode } : {}),
    }))
  }

  /** Configured urls in order, for persistence. */
  urls(): string[] {
    return this.slots.map((slot) => slot.entry.url)
  }
}

// ---------------------------------------------------------------------------
// Persistence

export interface ProxyStore {
  path: string
  /** Entries loaded from disk; empty when the file is absent or unusable. */
  urls: string[] | null
}

export function defaultProxyStorePath(): string {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh')
  return path.join(base, 'data', 'dsh-opencode-bridge', 'proxies.json')
}

export function loadProxyStore(file: string): ProxyStore {
  try {
    // Strip a UTF-8 BOM: editors and PowerShell write one, and JSON.parse rejects it.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text) as { proxies?: unknown }
    if (!Array.isArray(parsed.proxies)) return { path: file, urls: null }
    return { path: file, urls: parsed.proxies.filter((v): v is string => typeof v === 'string') }
  } catch {
    return { path: file, urls: null }
  }
}

export function saveProxyStore(file: string, urls: readonly string[]): { ok: true } | { ok: false; reason: string } {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, proxies: urls }, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Pooled fetch

export interface AttemptEvent {
  /** Redacted egress description. */
  egress: string
  status?: number
  code?: string
  rotated: boolean
}

export interface PooledFetchInput {
  pool?: ProxyPool | undefined
  url: string
  init: RequestInit & { dispatcher?: unknown }
  signal?: AbortSignal
  dispatcherFor?: (url: string) => Promise<unknown> | unknown
  onAttempt?: (event: AttemptEvent) => void
  /** Response statuses eligible for throttle handling. */
  throttledStatuses?: readonly number[]
  /** Provider-specific scope. A request-scoped throttle must not rotate proxies. */
  throttleScope?: (response: Response, egress: string) => Promise<'request' | 'egress'>
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

/** No HTTP request was sent: the caller must honor the pool's remaining wait. */
export class EgressCoolingError extends Error {
  readonly code = 'EGRESS_COOLING'
  readonly retryAfterMs: number
  constructor(wait: number) {
    const delay = Math.max(1, Math.ceil(wait))
    super(`All configured egresses are cooling down; retry after ${Math.ceil(delay / 1000)} seconds.`)
    this.name = 'EgressCoolingError'
    this.retryAfterMs = delay
  }
}

function transportCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } })?.cause
  if (cause && typeof cause.code === 'string') return cause.code
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string') return code
  if ((error as { name?: string })?.name === 'TimeoutError') return 'TIMEOUT'
  return 'TRANSPORT_ERROR'
}

/**
 * Bounded pre-response failover, not an independent retry loop. Each exit is
 * attempted at most once. A positive server wait always ends this invocation;
 * request-scoped throttles never rotate exits. Already cooling exits are never
 * selected, including metadata/background calls. No timers are started here.
 */
export async function fetchWithPool(input: PooledFetchInput): Promise<Response> {
  const { pool } = input
  const signal = input.signal ?? input.init.signal
  signal?.throwIfAborted()
  const init = { ...input.init, ...(signal ? { signal } : {}) }
  const doFetch = input.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  if (!pool || pool.size === 0) return doFetch(input.url, init as RequestInit)
  const throttled = input.throttledStatuses ?? [429]
  const attempts = pool.size
  const attempted = new Set<string>()
  const rejected: Response[] = []
  let lastResponse: Response | undefined
  let lastError: unknown
  let retained: Response | undefined
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted()
      const lease = pool.acquire(attempted)
      if (!lease) {
        if (lastResponse || lastError) break
        throw new EgressCoolingError(pool.waitMs())
      }
      const entry = pool.entryAt(lease.index)
      if (!entry) break
      attempted.add(entry.id)
      const egress = redactProxyUrl(entry.url)
      let response: Response
      try {
        const dispatcher = entry.url ? await (input.dispatcherFor ?? dispatcherFor)(entry.url) : undefined
        if (entry.url && !dispatcher) throw new Error('Proxy dispatcher unavailable')
        signal?.throwIfAborted()
        response = await doFetch(input.url, { ...init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
      } catch (error) {
        if (signal?.aborted) throw error
        const code = transportCode(error)
        const current = pool.indexOf(entry.id)
        if (current >= 0) pool.failed(current, code)
        lastError = error
        input.onAttempt?.({ egress, code, rotated: attempt + 1 < attempts && pool.acquire(attempted) !== null })
        continue
      }
      signal?.throwIfAborted()
      if (throttled.includes(response.status)) {
        rejected.push(response)
        const scope = input.throttleScope ? await input.throttleScope(response, egress) : 'egress'
        signal?.throwIfAborted()
        const hint = retryAfterMs(response)
        const current = pool.indexOf(entry.id)
        if (scope === 'egress' && current >= 0) pool.rateLimited(current, hint)
        lastResponse = response
        const rotate = hint === undefined && scope === 'egress' && attempt + 1 < attempts && pool.acquire(attempted) !== null
        input.onAttempt?.({ egress, status: response.status, rotated: rotate, code: 'RATE_LIMIT' })
        if (rotate) continue
      } else {
        const current = pool.indexOf(entry.id)
        if (current >= 0) pool.succeeded(current)
        input.onAttempt?.({ egress, status: response.status, rotated: false })
      }
      retained = response
      return response
    }
    if (lastResponse) { retained = lastResponse; return lastResponse }
    throw lastError ?? new Error('no egress available')
  } finally {
    // Keep a returned error response readable. Other rejected bodies must not
    // tie up CONNECT/SOCKS connections after this bounded operation finishes.
    for (const response of rejected) {
      if (response !== retained && !response.bodyUsed) void response.body?.cancel().catch(() => {})
    }
  }
}


// ---------------------------------------------------------------------------
// Dispatcher (lazy: undici is loaded only once a proxy is actually used)

interface ProxyDispatcher {
  dispatcher: unknown
  close(): Promise<void>
}
const dispatchers = new Map<string, Promise<ProxyDispatcher>>()

/** Cache initialization too: parallel requests must share one agent per URL. */
export async function dispatcherFor(raw: string): Promise<unknown> {
  if (!raw) return undefined
  const parsed = normalizeEntry(raw)
  if (!parsed.ok) throw new Error(`Invalid proxy configuration: ${parsed.reason}`)
  const url = parsed.entry.url
  if (!url) return undefined
  let creating = dispatchers.get(url)
  if (!creating) {
    creating = (async (): Promise<ProxyDispatcher> => {
      if (new URL(url).protocol.startsWith('socks')) {
        const { createSocksDispatcher } = await import('./socks-dispatcher.js')
        return createSocksDispatcher(url)
      }
      const { ProxyAgent } = await import('undici')
      const agent = new ProxyAgent(url)
      return { dispatcher: agent, close: async () => { await agent.destroy() } }
    })()
    dispatchers.set(url, creating)
  }
  try {
    return (await creating).dispatcher
  } catch {
    if (dispatchers.get(url) === creating) dispatchers.delete(url)
    throw new Error('Proxy dispatcher initialization failed')
  }
}

/** Release pooled sockets and in-progress SOCKS negotiations on plugin unload. */
export async function clearDispatchers(): Promise<void> {
  const entries = [...dispatchers.values()]
  dispatchers.clear()
  await Promise.allSettled(entries.map(async creating => { await (await creating).close() }))
}
