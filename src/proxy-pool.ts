/**
 * Egress pool for the relay.
 *
 * The free tier throttles per egress IP. A pool lets one profile rotate a
 * rate-limited IP out of rotation and try the next entry instead of failing the
 * whole request. Entries are either the machine's own IP ("direct") or an
 * HTTP(S) proxy reached through a CONNECT tunnel.
 *
 * This module is pure state plus small filesystem helpers: it never performs a
 * network request itself, so rotation policy is testable offline.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

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
  /** Upper bound for escalated cooldowns. */
  maxCooldownMs?: number
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
 * Normalize one user-provided entry. Accepts a bare `host:port`, an HTTP(S)
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `${url.protocol.replace(':', '')} is unsupported; use an http:// or https:// proxy` }
  }
  if (!url.hostname || !url.port) return { ok: false, reason: 'a proxy needs a host and a port' }
  // Keep credentials in the url (undici needs them) but give the entry a stable
  // id that does not embed a secret.
  const auth = url.username ? `${url.username}:${url.password}@` : ''
  const secretFree = url.toString().replace(/\/$/, '')
  const digest = createHash('sha256').update(`${auth}${secretFree}`).digest('hex').slice(0, 8)
  return { ok: true, entry: { id: `proxy:${url.hostname}:${url.port}#${digest}`, url: secretFree } }
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
 * one egress IP; a throttled or unreachable entry is retired for its cooldown
 * and the next one takes over. `acquire()` never reports "nothing to try" while
 * any entry exists: when every entry is cooling it returns the one whose
 * cooldown expires first, marked `cooling: true`, so a single-egress profile
 * still behaves exactly like a plain fetch.
 */
export class ProxyPool {
  private slots: Slot[] = []
  private readonly cooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number

  constructor(entries: readonly string[] = [], options: PoolOptions = {}, now: () => number = Date.now) {
    this.cooldownMs = Math.max(1000, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    this.maxCooldownMs = Math.max(this.cooldownMs, options.maxCooldownMs ?? MAX_COOLDOWN_MS)
    this.now = now
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

  /**
   * The next egress to use: the earliest configured entry that is not cooling.
   *
   * Selection is order-based, not round-robin, so a healthy profile keeps one
   * stable egress (better for per-IP quota accounting) and only moves on when
   * that egress is cooling. When everything is cooling, the entry that recovers
   * soonest is returned with `cooling: true` so the caller can still try.
   */
  acquire(): { index: number; cooling: boolean } | null {
    if (!this.slots.length) return null
    const now = this.now()
    for (let index = 0; index < this.slots.length; index++) {
      if (this.slots[index].coolingUntil <= now) return { index, cooling: false }
    }
    let best = 0
    for (let i = 1; i < this.slots.length; i++) {
      if (this.slots[i].coolingUntil < this.slots[best].coolingUntil) best = i
    }
    return { index: best, cooling: true }
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
    if (!slot) return
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
    const escalated = Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** (slot.failures - 1))
    const wait = Number.isFinite(retryAfterMs) && (retryAfterMs as number) > 0
      ? Math.min(this.maxCooldownMs, retryAfterMs as number)
      : escalated
    slot.coolingUntil = this.now() + wait
  }

  /** Transport failure: unreachable proxy, DNS, reset. Short cooldown. */
  failed(index: number, code: string): void {
    const slot = this.slots[index]
    if (!slot) return
    slot.failures += 1
    slot.lastCode = code
    slot.coolingUntil = this.now() + Math.min(CONNECT_FAILURE_COOLDOWN_MS, this.cooldownMs)
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
  /** Response statuses that retire the egress instead of failing the request. */
  throttledStatuses?: readonly number[]
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

/** `retry-after-ms` wins over `retry-after`; an HTTP-date is not parsed. */
export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after-ms') ?? response.headers.get('retry-after')
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return response.headers.get('retry-after-ms') ? value : value * 1000
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
 * Fetch through the pool, retiring a throttled or unreachable egress and trying
 * the next one. Reached only before a response body exists, so a retry can never
 * duplicate streamed content. Returns the last response (a 429 when every egress
 * throttled) so the caller keeps its existing error mapping.
 */
export async function fetchWithPool(input: PooledFetchInput): Promise<Response> {
  const { pool } = input
  const doFetch = input.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  if (!pool || pool.size === 0) return doFetch(input.url, input.init as RequestInit)
  const throttled = input.throttledStatuses ?? [429]
  const attempts = pool.size
  let lastResponse: Response | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lease = pool.acquire()
    if (!lease) break
    const entry = pool.entryAt(lease.index)
    if (!entry) break
    const egress = redactProxyUrl(entry.url)
    try {
      const dispatcher = entry.url && input.dispatcherFor ? await input.dispatcherFor(entry.url) : undefined
      const response = await doFetch(input.url, { ...input.init, ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
      if (throttled.includes(response.status)) {
        pool.rateLimited(lease.index, retryAfterMs(response))
        lastResponse = response
        input.onAttempt?.({ egress, status: response.status, rotated: attempt + 1 < attempts, code: 'RATE_LIMIT' })
        continue
      }
      pool.succeeded(lease.index)
      input.onAttempt?.({ egress, status: response.status, rotated: false })
      return response
    } catch (error) {
      if (input.signal?.aborted) throw error
      const code = transportCode(error)
      pool.failed(lease.index, code)
      lastError = error
      input.onAttempt?.({ egress, code, rotated: attempt + 1 < attempts })
    }
  }
  if (lastResponse) return lastResponse
  throw lastError ?? new Error('no egress available')
}


// ---------------------------------------------------------------------------
// Dispatcher (lazy: undici is loaded only once a proxy is actually used)

const dispatchers = new Map<string, unknown>()

/** One cached CONNECT agent per proxy URL. */
export async function dispatcherFor(url: string): Promise<unknown> {
  if (!url) return undefined
  const cached = dispatchers.get(url)
  if (cached) return cached
  const { ProxyAgent } = (await import('undici')) as { ProxyAgent: new (url: string) => unknown }
  const agent = new ProxyAgent(url)
  dispatchers.set(url, agent)
  return agent
}

export function clearDispatchers(): void {
  dispatchers.clear()
}
