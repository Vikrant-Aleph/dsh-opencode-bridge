/**
 * Free-model catalog shared by the adapter and model discovery.
 *
 * One source, as the official client has: the OpenCode catalog at
 * `https://models.opencode.ai/api.json`, read every five minutes.
 *
 * The bridge used to intersect that catalog with a live `/models` request to the gateway.
 * Measurement on 2026-11-15 showed the intersection changed nothing — every free,
 * non-deprecated catalog entry was also served — while adding a request shape the official
 * client never sends. The availability signal already lives in the catalog's `status`
 * field, so the extra probe is gone.
 *
 * Periodic refresh is explicitly owned by start()/dispose(); standalone callers can use
 * list()/refresh() without creating a background timer.
 */
import { noopLogger, type LoggerLike } from './logger.js'
import { fetchWithPool, type ProxyPool } from './proxy-pool.js'

export interface FreeModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: Array<'text' | 'image'>
  efforts?: Array<{ id: string; name: string }>
  api?: string
  /** Catalog-declared reasoning replay field (e.g. `interleaved.field`). */
  reasoningField?: string
}

interface CatalogModel {
  id?: string
  name?: string
  description?: string
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  interleaved?: { field?: string }
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  status?: string
  provider?: { api?: string }
  cost?: { input?: number; output?: number }
}

export interface CatalogOptions {
  includeDeprecated: boolean
  extraModels: string[]
  pool?: ProxyPool
  dispatcherFor?: (url: string) => Promise<unknown> | unknown
  /** 0 disables periodic refresh, not startup prefetch or on-demand caching. */
  refreshIntervalMs?: number
  /** Total deadline for the request, including its response body. */
  fetchTimeoutMs?: number
  /** Observer after a committed content change; host notification belongs to the caller. */
  onUpdated?: (models: readonly FreeModel[]) => void
}

/** The official client refreshes its catalog on a five-minute TTL. */
export const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 5 * 60_000
export const MIN_MODEL_REFRESH_INTERVAL_MS = 60_000
export const MAX_MODEL_REFRESH_INTERVAL_MS = 2_147_483_647
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const FAILURE_RETRY_MS = 60_000
/** Same source the official client reads. */
const CATALOG_URL = 'https://models.opencode.ai/api.json'

export function normalizeModelRefreshIntervalMs(value: unknown): number {
  if (value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_MODEL_REFRESH_INTERVAL_MS
  return Math.min(MAX_MODEL_REFRESH_INTERVAL_MS, Math.max(MIN_MODEL_REFRESH_INTERVAL_MS, Math.floor(value)))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function disposedError(): DOMException {
  return new DOMException('Model catalog disposed', 'AbortError')
}

/** One aborted caller must not cancel a refresh shared by other callers. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export class FreeModelCatalog {
  private models: readonly FreeModel[] = Object.freeze([])
  private fetchedAt: number | undefined
  private retryAt = 0
  private failed = false
  private inFlight: Promise<readonly FreeModel[]> | undefined
  private requestAbort: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private disposed = false
  readonly refreshIntervalMs: number
  private readonly fetchTimeoutMs: number

  constructor(
    private readonly options: CatalogOptions,
    private readonly logger: LoggerLike = noopLogger,
  ) {
    this.refreshIntervalMs = normalizeModelRefreshIntervalMs(options.refreshIntervalMs)
    this.fetchTimeoutMs = typeof options.fetchTimeoutMs === 'number' && Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
      ? Math.min(MAX_MODEL_REFRESH_INTERVAL_MS, Math.max(1, Math.floor(options.fetchTimeoutMs)))
      : DEFAULT_FETCH_TIMEOUT_MS
  }

  /** Network errors preserve cache; caller cancellation and disposal still reject. */
  async list(signal?: AbortSignal): Promise<readonly FreeModel[]> {
    signal?.throwIfAborted()
    if (this.disposed) throw disposedError()
    const now = Date.now()
    const ttl = this.refreshIntervalMs || DEFAULT_MODEL_REFRESH_INTERVAL_MS
    if (this.fetchedAt !== undefined && now - this.fetchedAt < ttl) return this.models
    if (!this.inFlight && now < this.retryAt) return this.models
    return this.refresh(signal)
  }

  /** Force a refresh, joining an existing one rather than racing its result. */
  async refresh(signal?: AbortSignal): Promise<readonly FreeModel[]> {
    signal?.throwIfAborted()
    if (this.disposed) throw disposedError()
    if (!this.inFlight) {
      const controller = new AbortController()
      this.requestAbort = controller
      const timeout = setTimeout(() => controller.abort(new DOMException('Model catalog refresh timed out', 'TimeoutError')), this.fetchTimeoutMs)
      timeout.unref?.()
      const task = (async () => {
        try {
          const next = await waitFor(this.fetchModels(controller.signal), controller.signal)
          controller.signal.throwIfAborted()
          if (this.disposed) throw disposedError()
          const changed = this.fetchedAt === undefined || JSON.stringify(next) !== JSON.stringify(this.models)
          this.models = Object.freeze(next)
          this.fetchedAt = Date.now()
          this.retryAt = 0
          this.failed = false
          this.logger.info('catalog', 'ready', { freeModels: next.length, changed, ids: next.map(model => model.id).join(',') })
          if (changed && this.options.onUpdated) {
            try { this.options.onUpdated(this.models) }
            catch { this.logger.warn('catalog', 'catalog observer failed; refreshed snapshot retained') }
          }
          return this.models
        } catch (error) {
          if (this.disposed) throw disposedError()
          controller.abort()
          this.failed = true
          this.retryAt = Date.now() + FAILURE_RETRY_MS
          this.logger.warn('catalog', 'refresh failed; keeping cached models', {
            error: error instanceof Error ? error.message : 'catalog source unavailable', cached: this.models.length,
          })
          return this.models
        } finally {
          clearTimeout(timeout)
          if (this.requestAbort === controller) this.requestAbort = undefined
        }
      })()
      this.inFlight = task
      // Attach both branches immediately; disposal rejection must not become unhandled.
      task.then(() => { if (this.inFlight === task) this.inFlight = undefined }, () => { if (this.inFlight === task) this.inFlight = undefined })
    }
    return waitFor(this.inFlight, signal)
  }

  /** Start one immediate prefetch plus a non-overlapping, completion-relative timer. */
  start(): () => void {
    if (this.disposed) throw disposedError()
    if (!this.started) {
      this.started = true
      void this.tick()
    }
    return () => this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.requestAbort?.abort(disposedError())
  }

  private async tick(): Promise<void> {
    try { await this.refresh() }
    catch { /* Expected on unload; refresh logs ordinary source failures. */ }
    finally {
      if (!this.disposed && this.refreshIntervalMs > 0) {
        const delay = this.failed ? Math.min(this.refreshIntervalMs, FAILURE_RETRY_MS) : this.refreshIntervalMs
        this.timer = setTimeout(() => { this.timer = undefined; void this.tick() }, delay)
        this.timer.unref?.()
      }
    }
  }

  private async fetchModels(signal: AbortSignal): Promise<FreeModel[]> {
    // A failed fetch throws and the previous snapshot is kept: a transient outage must not
    // empty the picker, and it must not be mistaken for "no free models exist".
    const models = await this.fetchCatalog(signal)
    const out: FreeModel[] = []
    for (const [key, value] of Object.entries(models)) {
      if (!record(value)) continue
      const meta = value as unknown as CatalogModel
      const id = typeof meta.id === 'string' && meta.id ? meta.id : key
      const free = meta.cost?.input === 0 && meta.cost?.output === 0
      if (!free) continue
      if (!this.options.includeDeprecated && meta.status === 'deprecated') continue
      const efforts = effortsOf(meta)
      out.push({
        id, name: typeof meta.name === 'string' ? meta.name : id,
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
        ...(typeof meta.limit?.context === 'number' && meta.limit.context > 0 ? { contextWindow: meta.limit.context } : {}),
        ...(typeof meta.limit?.output === 'number' && meta.limit.output > 0 ? { maxOutputTokens: meta.limit.output } : {}),
        ...(Array.isArray(meta.modalities?.input) ? { inputModalities: meta.modalities.input.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image') } : {}),
        ...(efforts.length ? { efforts } : {}),
        ...(typeof meta.provider?.api === 'string' ? { api: meta.provider.api } : {}),
        ...(typeof meta.interleaved?.field === 'string' && meta.interleaved.field ? { reasoningField: meta.interleaved.field } : {}),
      })
    }
    for (const id of this.options.extraModels) {
      if (!out.some(model => model.id === id)) out.push({ id, name: id })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  private async fetchCatalog(signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetchWithPool({
      pool: this.options.pool,
      url: CATALOG_URL,
      init: { headers: { accept: 'application/json' }, signal },
      signal,
      ...(this.options.dispatcherFor ? { dispatcherFor: this.options.dispatcherFor } : {}),
    })
    if (!response.ok) {
      if (!response.bodyUsed) void response.body?.cancel().catch(() => {})
      throw new Error(`catalog HTTP ${response.status}`)
    }
    const data: unknown = await response.json()
    if (!record(data) || !record(data.opencode) || !record(data.opencode.models) || Object.values(data.opencode.models).some(model => !record(model))) {
      throw new Error('the catalog returned an invalid model registry')
    }
    return data.opencode.models
  }
}

function effortsOf(meta: CatalogModel): Array<{ id: string; name: string }> {
  if (!Array.isArray(meta.reasoning_options)) return []
  for (const option of meta.reasoning_options) {
    if (option?.type === 'effort' && Array.isArray(option.values)) return option.values.filter((value): value is string => typeof value === 'string').map(value => ({ id: value, name: value }))
  }
  return []
}
