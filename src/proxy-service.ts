/**
 * Proxy-pool service: one implementation, two callers.
 *
 * The Settings page edits the pool through package-private JSON RPC routes and
 * the same methods are reachable from the host, mirroring the log service. The
 * pool itself is live: a saved change takes effect on the next request without
 * restarting the profile.
 */

import type { Context } from '@deepseek-ai/cordis'
import { noopLogger, type LoggerLike } from './logger.js'
import {
  ProxyPool,
  loadProxyStore,
  saveProxyStore,
  redactProxyUrl,
  retryAfterMs,
  dispatcherFor,
  type ProxyHealth,
} from './proxy-pool.js'

export const PROXY_RPC_NAMESPACE = 'opencode-free-proxies'
const RPC_CHANNEL = '/api'
const RPC_ENDPOINTS = ['read', 'write', 'test'] as const
type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

export interface ProxyView {
  entries: ProxyHealth[]
  store: string
  /** True when the values came from the UI store rather than plugin config. */
  managed: boolean
}

export interface ProbeResult {
  id: string
  display: string
  ok: boolean
  ms: number
  status?: number
  code?: string
}

export interface ProxyServiceOptions {
  storePath: string
  baseUrl: string
  /** Probe timeout per egress. */
  probeTimeoutMs?: number
  dispatcherFor?: (url: string) => Promise<unknown> | unknown
  logger?: LoggerLike
}

export class ProxyService {
  private readonly logger: LoggerLike
  private readonly probeTimeoutMs: number

  constructor(
    private readonly pool: ProxyPool,
    private readonly options: ProxyServiceOptions,
  ) {
    this.logger = options.logger ?? noopLogger
    this.probeTimeoutMs = Math.max(1000, options.probeTimeoutMs ?? 8000)
  }

  read(): ProxyView {
    const stored = loadProxyStore(this.options.storePath)
    return { entries: this.pool.health(), store: this.options.storePath, managed: stored.urls !== null }
  }

  /**
   * Apply one edit to the live pool and persist it.
   *
   * The UI never receives or echoes proxy credentials, so it sends operations
   * (`add`/`remove`/`reset`) rather than a replacement list. A full `proxies`
   * array stays available for callers that own the values, such as tests.
   */
  write(payload: unknown): { entries: ProxyHealth[]; rejected: Array<{ raw: string; reason: string }>; saved: boolean; storeError?: string } {
    const rejected: Array<{ raw: string; reason: string }> = []
    if (!isRecord(payload)) throw new Error('write expects { add } | { remove } | { reset } | { proxies }')

    if (typeof payload.add === 'string') {
      const result = this.pool.add(payload.add)
      if (!result.ok) rejected.push({ raw: redactProxyUrl(payload.add), reason: result.reason ?? 'rejected' })
    } else if (typeof payload.remove === 'string') {
      if (!this.pool.removeById(payload.remove)) rejected.push({ raw: payload.remove, reason: 'unknown entry' })
    } else if (payload.reset === true) {
      this.pool.replace(['direct'])
    } else if (Array.isArray(payload.proxies)) {
      const urls = payload.proxies.filter((value): value is string => typeof value === 'string')
      this.pool.replace(urls)
      const accepted = new Set(this.pool.rawEntries().map((entry) => entry.url).filter(Boolean))
      for (const raw of urls) {
        const trimmed = raw.trim()
        if (!trimmed || trimmed.toLowerCase() === 'direct') continue
        const normalized = normalizeQuiet(trimmed)
        if (!normalized || !accepted.has(normalized)) rejected.push({ raw: redactProxyUrl(trimmed), reason: 'unsupported or duplicate proxy' })
      }
    } else {
      throw new Error('write expects { add } | { remove } | { reset } | { proxies }')
    }

    const saved = saveProxyStore(this.options.storePath, this.pool.urls())
    this.logger.info('proxy', 'pool updated', {
      size: this.pool.size,
      entries: this.pool.health().map((entry) => entry.display).join(', '),
      rejected: rejected.length,
    })
    return {
      entries: this.pool.health(),
      rejected,
      saved: saved.ok,
      ...(saved.ok ? {} : { storeError: saved.reason }),
    }
  }

  /**
   * Probe every egress with the relay's own model listing (metadata only, no
   * prompt). A throttled probe retires that egress exactly like a real call.
   */
  async test(): Promise<{ results: ProbeResult[]; reachable: number }> {
    const results: ProbeResult[] = []
    for (let index = 0; index < this.pool.size; index++) {
      const entry = this.pool.entryAt(index)
      if (!entry) continue
      const display = redactProxyUrl(entry.url)
      const started = Date.now()
      const timeout = AbortSignal.timeout(this.probeTimeoutMs)
      try {
        const dispatcher = entry.url ? await (this.options.dispatcherFor ?? dispatcherFor)(entry.url) : undefined
        const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/models`, {
          method: 'GET',
          headers: { 'user-agent': 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
          signal: timeout,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit)
        const ms = Date.now() - started
        if (response.status === 429) {
          this.pool.rateLimited(index, retryAfterMs(response))
          results.push({ id: entry.id, display, ok: false, ms, status: 429, code: 'RATE_LIMIT' })
        } else if (!response.ok) {
          results.push({ id: entry.id, display, ok: false, ms, status: response.status, code: 'HTTP_ERROR' })
        } else {
          this.pool.succeeded(index)
          results.push({ id: entry.id, display, ok: true, ms, status: response.status })
        }
      } catch (error) {
        const code = transportCode(error)
        this.pool.failed(index, code)
        results.push({ id: entry.id, display, ok: false, ms: Date.now() - started, code })
      }
    }
    this.logger.info('proxy', 'probe finished', {
      reachable: results.filter((r) => r.ok).length,
      total: results.length,
    })
    return { results, reachable: results.filter((r) => r.ok).length }
  }
}

function normalizeQuiet(raw: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
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

interface RpcEnvelope {
  rpcId?: unknown
  method?: unknown
  payload?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `/api/opencode-free-proxies/{read,write,test}` for the Settings page. */
export function registerProxyAccess(ctx: Context, service: ProxyService): () => void {
  const disposers: Array<() => void | Promise<void>> = []

  ctx.inject(['connection'], (ctxWithConnection: Context) => {
    const connection = (ctxWithConnection as unknown as { connection: { fetch: { register: (route: unknown) => () => Promise<void> | void } } }).connection
    if (!connection?.fetch?.register) return () => {}
    const routeDisposers = RPC_ENDPOINTS.map((endpoint) =>
      connection.fetch.register({
        path: `${RPC_CHANNEL}/${PROXY_RPC_NAMESPACE}/${endpoint}`,
        requestBody: 'buffered',
        handler: async (request: Request) => {
          let envelope: RpcEnvelope
          try {
            envelope = (await request.json()) as RpcEnvelope
          } catch {
            return new Response('invalid JSON', { status: 400 })
          }
          const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
          const method = typeof envelope.method === 'string' ? envelope.method : ''
          const failure = (code: string, message: string) =>
            Response.json({ rpcId, ok: false, error: { code, message, details: {} } })
          if (method !== `${PROXY_RPC_NAMESPACE}/${endpoint}`) return failure('bad-request', 'proxy request method does not match its endpoint')
          try {
            if (endpoint === 'read') return Response.json({ rpcId, ok: true, value: service.read() })
            if (endpoint === 'write') return Response.json({ rpcId, ok: true, value: service.write(envelope.payload) })
            return Response.json({ rpcId, ok: true, value: await service.test() })
          } catch (error) {
            return failure('internal', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    )
    return () => {
      for (const dispose of routeDisposers) void dispose()
    }
  })

  return () => {
    for (const dispose of disposers) void dispose()
  }
}
