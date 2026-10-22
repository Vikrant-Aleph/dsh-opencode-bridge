/**
 * dsh-opencode-bridge: OpenCode free models for DeepSeek Harness.
 *
 * Registers an LLM adapter that simulates the official OpenCode client wire
 * protocol so DSH can use the keyless free-tier models hosted at opencode.ai
 * (big-pickle, mimo-v2.6-flash-free, glm-5.3-flash-free, ...).
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { AdapterRegistrationHandle, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { FreeModelCatalog, DEFAULT_MODEL_REFRESH_INTERVAL_MS, MAX_MODEL_REFRESH_INTERVAL_MS } from './catalog.js'
import { DEFAULT_IMAGE_INPUT_POLICY } from './image-input.js'
import { OpenCodeFreeAdapter } from './adapter.js'
import type { HeaderRecipe } from './opencode-protocol.js'
import { PluginLogger, defaultLogDir, type LogLevel } from './logger.js'
import { LogService, registerLogAccess } from './log-service.js'
import { registerBridgeAudit } from './bridge-audit.js'
import { ProxyPool, defaultProxyStorePath, dispatcherFor, clearDispatchers, loadProxyStore } from './proxy-pool.js'
import { ProxyService, registerProxyAccess } from './proxy-service.js'

export { FreeModelCatalog } from './catalog.js'
export { OpenCodeFreeAdapter } from './adapter.js'
export { prepareImageProjection, requestImageTarget, resolveImageInputPolicy, DEFAULT_IMAGE_INPUT_POLICY } from './image-input.js'
export type { ImageInputPolicy } from './image-input.js'
export * from './opencode-protocol.js'
export { PluginLogger, defaultLogDir } from './logger.js'
export { LogService } from './log-service.js'
export { auditToolBridge, resolveToolCall, ToolBridgeError } from './tool-bridge.js'
export { createBridgeAuditTool } from './bridge-audit.js'
export { ProxyPool, EgressCoolingError, retryAfterMs, normalizeEntry, redactProxyUrl, fetchWithPool } from './proxy-pool.js'
export { ProxyService } from './proxy-service.js'

export interface Config {
  /** OpenAI-compatible relay base. The free tier lives at /inference/v1. */
  baseUrl: string
  /** Credential sent as `Bearer <key>`; the signed-out client sentinel is `public`. */
  apiKey: string
  /** User-Agent of the simulated client; must contain `opencode/<version>`. */
  userAgent: string
  /** `x-opencode-client` value (official client reports `cli` or `desktop`). */
  client: string
  /** `x-opencode-project` value; the official default project is `global`. */
  project: string
  /** Provider routes this adapter serves. */
  providers: string[]
  /** Offer models the registry marks deprecated when the relay still lists them. */
  includeDeprecated: boolean
  /** Extra model ids to offer even when unknown to the registry. */
  extraModels: string[]
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number
  /** Periodic catalog refresh; 0 disables background refresh, positive values clamp to at least 60s. */
  modelRefreshIntervalMs: number
  /** Maximum pixels in a prepared image; geometry matches DSH coordinate mapping. */
  requestImagePixelBudget: number
  /** Per-image encoded byte target for the official attachment request version. */
  requestImageMaxBytes: number
  /** Sum of retained image base64 bytes per request before requesting offload. */
  maxRequestImageBytes: number
  /** Maximum retained image occurrences per request, including repeated images. */
  maxRequestImages: number
  /** Forward tool output images via associated user image parts on vision routes. */
  toolResultImages: boolean
  /** Send the OpenCode tool fingerprint the free-tier gate requires. */
  toolFingerprint: boolean
  /** Allow schema-checked read/search decoy mapping. Executable decoys are always rejected. */
  toolTranslation: boolean
  /** Minimum log level written to disk: `debug` | `info` | `warn` | `error` | `off`. */
  logLevel: string
  /** Log directory; empty means the profile default (`<profile>/logs/dsh-opencode-bridge`). */
  logDir: string
  /** Per-file size ceiling in bytes before rotation. */
  logMaxBytes: number
  /** Total log files kept (active + rotated); oldest is deleted first on overflow. */
  logMaxFiles: number
  /** Egress pool: `direct`, HTTP(S) or SOCKS proxy URLs, tried in order. */
  proxies: string[]
  /** Local fallback cooldown for egress quota; server waits are never shortened. */
  proxyCooldownMs: number
  /** Pool store written by the Settings page; empty means the profile data dir. */
  proxyStorePath: string
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default('https://opencode.ai/inference/v1'),
  apiKey: Schema.string().default('public'),
  userAgent: Schema.string().default('opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'),
  client: Schema.string().default('cli'),
  project: Schema.string().default('global'),
  providers: Schema.array(Schema.string()).default(['opencode-bridge']),
  includeDeprecated: Schema.boolean().default(false),
  extraModels: Schema.array(Schema.string()).default([]),
  requestTimeoutMs: Schema.number().default(600_000),
  modelRefreshIntervalMs: Schema.number().min(0).max(MAX_MODEL_REFRESH_INTERVAL_MS).step(1).default(DEFAULT_MODEL_REFRESH_INTERVAL_MS),
  requestImagePixelBudget: Schema.number().min(1).max(100_000_000).step(1).default(DEFAULT_IMAGE_INPUT_POLICY.maxPixels),
  requestImageMaxBytes: Schema.number().min(1).max(32 * 1024 * 1024).step(1).default(DEFAULT_IMAGE_INPUT_POLICY.maxImageBytes),
  maxRequestImageBytes: Schema.number().min(1).max(128 * 1024 * 1024).step(1).default(DEFAULT_IMAGE_INPUT_POLICY.maxRequestImageBytes),
  maxRequestImages: Schema.number().min(1).max(100).step(1).default(DEFAULT_IMAGE_INPUT_POLICY.maxImages),
  toolResultImages: Schema.boolean().default(true),
  toolFingerprint: Schema.boolean().default(true),
  toolTranslation: Schema.boolean().default(true),
  logLevel: Schema.string().default('warn'),
  logDir: Schema.string().default(''),
  logMaxBytes: Schema.number().default(512 * 1024),
  logMaxFiles: Schema.number().default(5),
  proxies: Schema.array(Schema.string()).default([]),
  proxyCooldownMs: Schema.number().default(60_000),
  proxyStorePath: Schema.string().default(''),
})

export const name = 'dsh-opencode-bridge'
export const inject = ['llm']

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'off']

function normalizeLevel(value: string): LogLevel {
  return (LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : 'warn'
}

export function apply(ctx: Context, config: Config): void {
  const logger = new PluginLogger({
    level: normalizeLevel(config.logLevel),
    dir: config.logDir || defaultLogDir(),
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
    // Scrub the configured API key; proxy URLs/errors are redacted by the proxy layer.
    secrets: [config.apiKey],
    mirror: (line) => console.log(`[dsh-opencode-bridge] ${line}`),
  })
  logger.info('plugin', 'starting', {
    providers: config.providers.join(','),
    baseUrl: config.baseUrl,
    logLevel: logger.getLevel(),
  })

  const logService = new LogService(logger)
  ctx.effect(() => registerLogAccess(ctx, logService))

  // Egress pool: the Settings page owns a JSON store; plugin config seeds it.
  const proxyStorePath = config.proxyStorePath || defaultProxyStorePath()
  const storedProxies = loadProxyStore(proxyStorePath)
  const pool = new ProxyPool(storedProxies.urls ?? config.proxies, { cooldownMs: config.proxyCooldownMs })
  ctx.effect(() => () => clearDispatchers())
  const proxyService = new ProxyService(pool, { storePath: proxyStorePath, baseUrl: config.baseUrl, logger, dispatcherFor })
  ctx.effect(() => registerProxyAccess(ctx, proxyService))
  logger.info('proxy', 'egress pool ready', {
    source: storedProxies.urls ? 'settings-store' : 'plugin-config',
    entries: pool.health().map((entry) => entry.display).join(', '),
  })

  const recipe: HeaderRecipe = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    userAgent: config.userAgent,
    client: config.client,
    project: config.project,
    extraHeaders: {},
  }
  let registration: AdapterRegistrationHandle | undefined
  const providers = config.providers.length ? [...config.providers] : ['opencode-bridge']
  let refreshNotificationUnavailable = false
  const catalog = new FreeModelCatalog(
    config.baseUrl,
    {
      includeDeprecated: config.includeDeprecated, extraModels: config.extraModels, pool, dispatcherFor,
      refreshIntervalMs: config.modelRefreshIntervalMs,
      onUpdated: () => {
        if (typeof registration?.replace === 'function') {
          // Public atomic route replacement announces a genuine registration
          // update to DSH's model directory. Keep the SAME adapter and routes:
          // already prepared calls and session selections are not disposed.
          // This recaptures provider metadata/policy and may move route order.
          registration.replace(providers)
        } else if (!refreshNotificationUnavailable) {
          refreshNotificationUnavailable = true
          logger.warn('catalog', 'model cache updated; this DSH version needs a page reload to refresh its model picker')
        }
      },
    },
    logger,
  )
  registerBridgeAudit(ctx, { fingerprint: config.toolFingerprint, translateDecoys: config.toolTranslation })
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new DOMException('OpenCode Bridge was unloaded', 'AbortError')))
  const adapter = new OpenCodeFreeAdapter(catalog, {
    providerRoute: config.providers[0] ?? 'opencode-bridge',
    recipe,
    requestTimeoutMs: config.requestTimeoutMs,
    toolFingerprint: config.toolFingerprint,
    toolTranslation: config.toolTranslation,
    getAttachments: () => typeof ctx.get === 'function' ? ctx.get('attachments') : undefined,
    toolImages: config.toolResultImages,
    imagePolicy: {
      maxPixels: config.requestImagePixelBudget, maxImageBytes: config.requestImageMaxBytes,
      maxRequestImageBytes: config.maxRequestImageBytes, maxImages: config.maxRequestImages,
    },
    lifetimeSignal: lifetime.signal,
    logger,
    pool,
    dispatcherFor,
  })

  try {
    registration = ctx.llm.registerAdapter(providers, adapter)
    logger.info('plugin', 'LLM adapter registered', { providers: config.providers.join(',') })
  } catch (error) {
    logger.error('plugin', 'failed to register LLM adapter', { error: String(error) })
    return
  }

  if (typeof ctx.llm.registerConfigurableProviders === 'function') {
    try {
      ctx.llm.registerConfigurableProviders(
        (config.providers.length ? config.providers : ['opencode-bridge']).map((provider) => ({
          provider,
          displayName: 'OpenCode Bridge',
          settingsNs: 'opencode-bridge',
          settingsPath: [] as string[],
        })),
      )
    } catch (error) {
      logger.warn('plugin', 'registerConfigurableProviders note', { error: String(error) })
    }
  }

  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    try {
      ctx.llm.registerModelDiscovery('opencode-bridge', async (_request, signal): Promise<readonly LlmDiscoveredModel[]> => {
        const models = await catalog.list(signal)
        return models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
        }))
      })
    } catch (error) {
      logger.warn('plugin', 'registerModelDiscovery note', { error: String(error) })
    }
  }

  ctx.effect(() => () => {
    registration?.()
  })

  ctx.effect(() => catalog.start())
}
