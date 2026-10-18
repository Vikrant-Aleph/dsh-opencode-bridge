/**
 * Free-model catalog for the opencode relay.
 *
 * Metadata (limits, reasoning efforts, modalities) comes from the public
 * models.dev registry entry for the `opencode` provider; live availability
 * comes from the relay's own `GET /models` listing. A model is offered when it
 * is zero-cost in models.dev and currently listed by the relay. Both sources
 * are fetched together and share one 10-minute in-memory cache; nothing is
 * persisted to disk.
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
  /** Selectable reasoning efforts, when the registry publishes effort levels. */
  efforts?: Array<{ id: string; name: string }>
  /** Per-model upstream API base when the registry overrides the provider default. */
  api?: string
  live: boolean
}

interface ModelsDevModel {
  id: string
  name?: string
  description?: string
  attachment?: boolean
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  modalities?: { input?: string[] }
  limit?: { context?: number; output?: number }
  status?: string
  provider?: { api?: string }
  cost?: { input?: number }
}

const MODELS_DEV_URL = 'https://models.dev/api.json'

export class FreeModelCatalog {
  private models: FreeModel[] = []
  private fetchedAt = 0

  constructor(
    private readonly baseUrl: string,
    private readonly options: { includeDeprecated: boolean; extraModels: string[]; pool?: ProxyPool | undefined; dispatcherFor?: ((url: string) => Promise<unknown> | unknown) | undefined },
    private readonly logger: LoggerLike = noopLogger,
  ) {}

  /** Cached model list; refreshes when stale. Never throws - degrades to cache. */
  async list(signal?: AbortSignal): Promise<readonly FreeModel[]> {
    const now = Date.now()
    if (now - this.fetchedAt < 10 * 60_000 && this.models.length) return this.models
    try {
      this.models = await this.fetchModels(signal)
      this.fetchedAt = now
    } catch (error) {
      this.logger.warn('catalog', 'refresh failed; keeping cached models', {
        error: String(error),
        cached: this.models.length,
      })
      if (!this.models.length) this.fetchedAt = now - 5 * 60_000
    }
    return this.models
  }

  private async fetchModels(signal?: AbortSignal): Promise<FreeModel[]> {
    const [registry, live] = await Promise.all([
      this.fetchRegistry(signal).catch(() => ({}) as Record<string, ModelsDevModel>),
      this.fetchLive(signal).catch(() => null as Set<string> | null),
    ])

    const out: FreeModel[] = []
    for (const meta of Object.values(registry)) {
      const zeroCost = meta.cost?.input === 0
      const wanted = zeroCost && (this.options.includeDeprecated || meta.status !== 'deprecated')
      const listed = live ? live.has(meta.id) : true
      if (!wanted || !listed) continue
      out.push({
        id: meta.id,
        name: meta.name ?? meta.id,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.limit?.context ? { contextWindow: meta.limit.context } : {}),
        ...(meta.limit?.output ? { maxOutputTokens: meta.limit.output } : {}),
        ...(meta.modalities?.input?.length
          ? { inputModalities: meta.modalities.input.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image') }
          : {}),
        ...(effortsOf(meta).length ? { efforts: effortsOf(meta) } : {}),
        ...(meta.provider?.api ? { api: meta.provider.api } : {}),
        live: listed,
      })
    }

    // Relay lists models the registry may not know yet (or vice versa): keep
    // explicitly configured extras alive and surface unknown live free models.
    for (const id of this.options.extraModels) {
      if (!out.some((m) => m.id === id)) out.push({ id, name: id, live: live ? live.has(id) : true })
    }
    if (live) {
      for (const id of live) {
        if (!out.some((m) => m.id === id) && /(-free$|^big-pickle$)/.test(id)) {
          out.push({ id, name: id, live: true })
        }
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id))
    this.logger.info('catalog', 'ready', {
      freeModels: out.length,
      live: live ? 'yes' : 'no',
      ids: out.map((m) => m.id).join(','),
    })
    return out
  }

  private async fetchRegistry(signal?: AbortSignal): Promise<Record<string, ModelsDevModel>> {
    const res = await fetch(MODELS_DEV_URL, { signal })
    if (!res.ok) throw new Error(`models.dev ${res.status}`)
    const data = (await res.json()) as { opencode?: { models?: Record<string, ModelsDevModel> } }
    return data.opencode?.models ?? {}
  }

  private async fetchLive(signal?: AbortSignal): Promise<Set<string> | null> {
    // The live listing is IP-throttled too, so it uses the same egress pool.
    const res = await fetchWithPool({
      pool: this.options.pool,
      url: `${this.baseUrl.replace(/\/$/, '')}/models`,
      init: {
        headers: { 'user-agent': 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
        ...(signal ? { signal } : {}),
      } as RequestInit,
      ...(signal ? { signal } : {}),
      ...(this.options.dispatcherFor ? { dispatcherFor: this.options.dispatcherFor } : {}),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    return new Set((data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string'))
  }
}

function effortsOf(meta: ModelsDevModel): Array<{ id: string; name: string }> {
  for (const option of meta.reasoning_options ?? []) {
    if (option.type === 'effort' && option.values?.length) {
      return option.values.map((value) => ({ id: value, name: value }))
    }
  }
  return []
}
