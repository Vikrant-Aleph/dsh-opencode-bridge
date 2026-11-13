/**
 * DSH LLM adapter that speaks the OpenCode free-tier wire protocol.
 */

import {
  ToolCallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { prepareImageProjection, requestImageTarget, resolveImageInputPolicy, type ImageInputPolicy } from './image-input.js'
import { trimCompletedReasoning, type ReasoningRecord } from './reasoning-policy.js'
import type { FreeModelCatalog, FreeModel } from './catalog.js'
import type { HeaderRecipe } from './opencode-protocol.js'
import { noopLogger, type LoggerLike } from './logger.js'
import { fetchWithPool, EgressCoolingError, retryAfterMs, type ProxyPool } from './proxy-pool.js'
import { httpError, UpstreamHttpError } from './http-errors.js'
import {
  buildChatMessages,
  buildHeaders,
  mintRequestId,
  mintSessionId,
  defaultEnvironmentBlock,
  normalizeToolCall,
  planTools,
  READ_ANCHOR,
  requiresReasoningReplay,
  type WireCall,
} from './opencode-protocol.js'

export interface AdapterOptions {
  providerRoute: string
  recipe: HeaderRecipe
  requestTimeoutMs: number
  /** OpenCode 2.x omits `x-opencode-request`; set for 1.x-compatible relays. */
  requestIdHeader?: boolean
  /** Send `strict: false` on tool declarations, as OpenCode does for compatible providers. */
  toolStrict?: boolean
  /**
   * Lower bound for `max_completion_tokens`. The official client sends its
   * catalog output limit (32000), so small caller budgets are raised to match.
   */
  minOutputTokens?: number
  /** Append the DSH attribution token to User-Agent (off by default: the gate compares the UA). */
  userAgentAttribution?: boolean
  /** Attach the official `b3`/`traceparent` tracing pair, as the official runtime does. */
  tracing?: boolean
  /**
   * System-prompt environment block. Defaults to a block derived from the process
   * working directory; the gateway refuses requests that omit one.
   */
  environment?: string
  /**
   * Bun-shaped transport. The gateway's free lane distinguishes the official
   * client's TLS stack from Node's, which Node cannot reproduce on its own.
   * Absent means the plain `fetch` path is used.
   */
  bunFetch?: typeof fetch
  /** Leveled diagnostic logger. Messages must stay metadata-only (see logger.ts). */
  logger?: LoggerLike
  /** Optional egress pool; absent means a plain fetch from this machine. */
  pool?: ProxyPool
  /** Build the CONNECT dispatcher for one proxy URL (injectable for tests). */
  dispatcherFor?: (url: string) => Promise<unknown> | unknown
  /** Official DSH attachment seam; no filesystem-path resolution in the adapter. */
  attachments?: Pick<AttachmentStore, 'readImageRequest'>
  getAttachments?: () => Pick<AttachmentStore, 'readImageRequest'> | undefined
  imagePolicy?: Partial<ImageInputPolicy>
  /** Standard tool-result image hoist for vision routes; false is an explicit opt-out. */
  toolImages?: boolean
  /** Owned by the plugin context, in addition to caller cancellation/deadline. */
  lifetimeSignal?: AbortSignal
  /** Canonical completed-turn evidence captured once when a request starts; absent means full. */
  getCompletedReasoning?: (options: GenerateOptions) => readonly ReasoningRecord[] | undefined
  /** Plugin-owned persistence; standalone callers retain in-memory waits. */
  requestWaitState?: { remaining(model: string): number; remember(model: string, delay: number): void }
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  error?: { message?: string; type?: string }
}

export class OpenCodeFreeAdapter extends LlmAdapter {
  private readonly sessions = new Map<string, string>()
  private readonly requestWaits = new Map<string, number>()
  private overflowWaitUntil = 0
  private readonly imagePolicy: Readonly<ImageInputPolicy>

  /**
   * Install the transport used for upstream requests.
   *
   * The Bun-shaped transport resolves asynchronously after the adapter is
   * constructed, so it is attached here rather than at construction time. A
   * promise is accepted and awaited on first use, which closes the window where
   * an early request would silently fall back to plain `fetch`. Passing
   * `undefined` (or a promise resolving to it) falls back to the global `fetch`.
   */
  setTransport(transport: typeof fetch | Promise<typeof fetch | undefined> | undefined): void {
    this.transportReady = Promise.resolve(transport).then(
      (resolved) => { this.options.bunFetch = resolved },
      () => { this.options.bunFetch = undefined },
    )
  }

  /** Resolved before every request so a pending transport never leaks a fallback. */
  private transportReady: Promise<void> = Promise.resolve()

  constructor(
    private readonly catalog: FreeModelCatalog,
    private readonly options: AdapterOptions,
  ) {
    super()
    this.imagePolicy = resolveImageInputPolicy(options.imagePolicy)
  }

  /** Leveled logger; defaults to a no-op so standalone use needs no wiring. */
  private get logger(): LoggerLike {
    return this.options.logger ?? noopLogger
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode Bridge' }
  }

  /** DSH alone owns retry timers/budgets; never retry partial streams or tool failures. */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({
      mode: 'normal', maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'EGRESS_COOLING', 'REQUEST_COOLING'],
      backoff: { initialDelayMs: 2000, maxDelayMs: 120_000, jitterRatio: 0.2 },
    }, 'opencode-bridge retry policy')
  }

  /** Same geometry/byte target as serialization, including screenshot coordinate mapping. */
  override imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget {
    return requestImageTarget(image, this.imagePolicy)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.list().then((models) => models.map((model) => this.toModelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.list(signal).then(models => this.resolvedModelInfo(provider, model, models.find(item => item.id === model)))
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.catalog.list(signal).then(models => {
      const item = models.find(entry => entry.id === model)
      const snapshot = item ? {
        ...item,
        ...(item.inputModalities ? { inputModalities: [...item.inputModalities] } : {}),
        ...(item.efforts ? { efforts: item.efforts.map(effort => ({ ...effort })) } : {}),
      } : null
      return {
        model: this.resolvedModelInfo(provider, model, snapshot ?? undefined),
        stream: (options: GenerateOptions) => this.streamWithModel(options, snapshot),
      }
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithModel(options)
  }

  private async *streamWithModel(options: GenerateOptions, snapshot?: FreeModel | null): AsyncIterable<StreamChunk> {
    let blockIndex = 0
    let open: { index: number; kind: 'text' | 'reasoning'; text: string } | null = null
    let outputStarted = false
    let requestId: string | undefined
    let egress: string | undefined = this.options.pool ? undefined : 'direct (this machine)'
    let observedStatus: number | undefined
    let serverWaitMs: number | undefined
    let lastTransportCode: string | undefined

    const close = function* (): Generator<StreamChunk> {
      if (!open) return
      yield {
        type: 'block-end',
        index: open.index,
        block: open.kind === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
      }
      open = null
    }

    try {
      options.signal?.throwIfAborted()
      this.options.lifetimeSignal?.throwIfAborted()
      let completedReasoning: readonly ReasoningRecord[] | undefined
      if (!options.purpose) {
        try { completedReasoning = this.options.getCompletedReasoning?.(options) } catch { /* Fail safe: retain full history. */ }
      }
      const reasoningHistory = trimCompletedReasoning(options.messages, completedReasoning)
      const projectedOptions = reasoningHistory.messages === options.messages ? options : { ...options, messages: reasoningHistory.messages }
      const requestWait = Math.max(this.remainingRequestWait(options.model), this.options.requestWaitState?.remaining(options.model) ?? 0)
      if (requestWait > 0) throw new LlmError(`This model request is cooling down; retry after ${Math.ceil(requestWait / 1000)} seconds.`, 'REQUEST_COOLING', { providerRetryAfterMs: requestWait })
      const meta = snapshot === undefined ? (await this.catalog.list(options.signal)).find(model => model.id === options.model) : snapshot ?? undefined
      const sessionId = this.sessionIdFor(options)
      requestId = mintRequestId()
      const plan = planTools(options.purpose ? [] : options.tools ?? [], {
        // OpenCode sends `strict: false` on OpenAI Chat tools for providers that accept it.
        strict: this.options.toolStrict ?? true,
      })
      const signals = [AbortSignal.timeout(this.options.requestTimeoutMs), options.signal, this.options.lifetimeSignal].filter((value): value is AbortSignal => value !== undefined)
      const signal = AbortSignal.any(signals)
      signal.throwIfAborted()
      const imageProjection = await prepareImageProjection(projectedOptions.messages, {
        supportsImages: meta?.inputModalities?.includes('image') === true,
        toolImages: this.options.toolImages ?? true,
        attachments: this.options.attachments ?? this.options.getAttachments?.(),
        policy: this.imagePolicy, signal,
      })
      const messages = buildChatMessages(projectedOptions, plan, imageProjection, {
        requireReasoning: requiresReasoningReplay(meta, options.model, this.options.recipe.baseUrl),
        // The gateway refuses a request whose system prompt carries no <env>
        // block; the values inside it are not checked.
        environment: this.options.environment ?? defaultEnvironmentBlock(),
      })

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        tools: plan.tools,
      }
      // Match the current OpenCode OpenAI Chat encoder. `auto` is the API
      // default; cache affinity remains in headers instead of an undeclared
      // prompt_cache_key body option. Never send both token-limit spellings.
      // The official client sends its catalog output limit (32000 for the free
      // models we captured), not a caller-supplied smaller budget.
      const outputLimit = options.maxTokens && options.maxTokens > 0
        ? Math.max(options.maxTokens, this.options.minOutputTokens ?? 0)
        : undefined
      if (outputLimit) body.max_completion_tokens = outputLimit
      if (options.temperature !== undefined) body.temperature = options.temperature
      if (options.stop?.length) body.stop = options.stop
      if (options.reasoningEffort && meta?.efforts?.some((e) => e.id === String(options.reasoningEffort))) {
        body.reasoning_effort = String(options.reasoningEffort)
      }

      const api = (meta?.api ?? this.options.recipe.baseUrl).replace(/\/$/, '')
      const endpoint = `${api}/chat/completions`
      this.logger.debug('adapter', 'request', {
        origin: safeOrigin(endpoint),
        model: safeModelId(options.model),
        session: sessionId,
        request: requestId,
        messages: messages.length,
        tools: plan.tools.length,
        purpose: options.purpose ?? 'chat',
      })

      signal.throwIfAborted()
      const errors = new WeakMap<Response, UpstreamHttpError>()
      const responseExits = new WeakMap<Response, string>()
      // Wait for a transport that is still resolving, so the first request after
      // plugin load does not silently use the plain-fetch fallback.
      await this.transportReady
      const response = await fetchWithPool({
        pool: this.options.pool,
        url: endpoint,
        init: {
          method: 'POST',
          headers: buildHeaders(this.options.recipe, sessionId, requestId, {
            requestIdHeader: this.options.requestIdHeader,
            attribution: this.options.userAgentAttribution,
            tracing: this.options.tracing ?? true,
          }),
          body: JSON.stringify(body),
          signal,
        },
        signal,
        ...(this.options.bunFetch ? { fetchImpl: this.options.bunFetch } : {}),
        ...(this.options.dispatcherFor ? { dispatcherFor: this.options.dispatcherFor } : {}),
        throttleScope: async (res, exit) => {
          observedStatus = res.status
          egress = exit
          responseExits.set(res, exit)
          const error = await httpError(res)
          errors.set(res, error)
          serverWaitMs = retryAfterMs(res)
          if (serverWaitMs !== undefined) this.rememberRequestWait(options.model, serverWaitMs)
          // A named free-usage rejection does not establish an IP-wide scope.
          // Preserve its request wait, but do not rotate identities or poison
          // the shared metadata/other-model pool on that inference alone.
          return 'request'
        },
        onAttempt: (event) => {
          egress = event.egress
          if (event.status !== undefined) {
            observedStatus = event.status
            lastTransportCode = undefined
          } else lastTransportCode = safeTransportCode(event.code)
          this.logger.info('proxy', 'egress attempt', { model: safeModelId(options.model), request: requestId, ...event })
        },
      })

      observedStatus = response.status
      lastTransportCode = undefined
      egress = responseExits.get(response) ?? egress
      if (!response.ok) {
        let error = errors.get(response) ?? await httpError(response)
        if (response.status === 429) {
          serverWaitMs = retryAfterMs(response)
          if (serverWaitMs !== undefined) this.rememberRequestWait(options.model, serverWaitMs)
          const wait = Math.max(error.diagnostics.retryAfterMs ?? 0, this.options.pool?.waitMs() ?? 0)
          if (wait > 0) error = new UpstreamHttpError(
            `${error.message} Retry after at least ${Math.ceil(wait / 1000)} seconds.`, error.failure.code,
            { ...error.diagnostics, retryAfterMs: wait },
          )
        }
        throw error
      }
      if (!response.body) throw new LlmError('opencode free tier returned an empty stream', 'PROVIDER_HTTP_ERROR')

      const calls = new Map<number, WireCall>()
      let usage: TokenUsage | undefined
      let finishReason: string | null = null

      for await (const event of sseEvents(response.body, signal)) {
        if (event === '[DONE]') break
        let chunk: ChatChunk
        try {
          chunk = JSON.parse(event) as ChatChunk
        } catch {
          continue
        }
        if (chunk.error) {
          throw new LlmError(chunk.error.message ?? 'opencode free tier stream error', 'PROVIDER_STREAM_ERROR')
        }
        const delta = chunk.choices?.[0]?.delta
        const text = delta?.content
        if (text) {
          if (open && open.kind !== 'text') yield* close()
          if (!open) {
            outputStarted = true
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            open = { index: blockIndex, kind: 'text', text: '' }
            blockIndex++
          }
          open.text += text
          yield { type: 'text-delta', index: open.index, text }
        }
        const reasoning = delta?.reasoning_content
        if (reasoning) {
          if (open && open.kind !== 'reasoning') yield* close()
          if (!open) {
            outputStarted = true
            yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' }
            open = { index: blockIndex, kind: 'reasoning', text: '' }
            blockIndex++
          }
          open.text += reasoning
          yield { type: 'reasoning-delta', index: open.index, text: reasoning }
        }
        for (const call of delta?.tool_calls ?? []) {
          const slot = call.index ?? 0
          const current = calls.get(slot) ?? { id: '', name: '', arguments: '' }
          if (call.id) current.id = call.id
          if (call.function?.name) current.name += call.function.name
          if (call.function?.arguments) current.arguments += call.function.arguments
          calls.set(slot, current)
        }
        if (chunk.usage) usage = toUsage(chunk.usage)
        const reason = chunk.choices?.[0]?.finish_reason
        if (reason) finishReason = reason
      }

      signal.throwIfAborted()
      yield* close()

      const wireCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
      if (wireCalls.length && finishReason !== 'tool_calls') {
        throw new LlmError('Tool call batch did not finish completely; no tools were emitted.', 'TOOL_BRIDGE_INCOMPLETE')
      }
      // Pass returned calls through under their own names. The one declaration
      // DSH cannot execute is the protocol placeholder, which exists only to
      // satisfy the gateway's "at least one tool" rule. A call to it is dropped
      // rather than failing the turn, so a stray call costs one tool call instead
      // of the whole response.
      const normalized = wireCalls.map((call) => normalizeToolCall(call))
      const dispatchable = plan.readAnchor
        ? normalized.filter((call) => call.name !== READ_ANCHOR.function.name)
        : normalized
      if (dispatchable.length !== normalized.length) {
        this.logger.warn('adapter', 'dropped a call to the protocol placeholder tool', {
          model: safeModelId(options.model),
          dropped: normalized.length - dispatchable.length,
        })
      }
      for (const call of dispatchable) {
        signal.throwIfAborted()
        const id = ToolCallId(call.id || `call_${call.name}_${blockIndex}`)
        outputStarted = true
        yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
        signal.throwIfAborted()
        yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: call.arguments }
        signal.throwIfAborted()
        yield {
          type: 'block-end',
          index: blockIndex,
          block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
        }
        blockIndex++
      }

      signal.throwIfAborted()
      this.logger.info('adapter', 'completed', {
        model: safeModelId(options.model),
        session: sessionId,
        finish: dispatchable.length ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop',
        toolCalls: dispatchable.length,
        ...(usage ? { input: usage.inputTokens, output: usage.outputTokens } : {}),
      })
      if (usage) yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: dispatchable.length
          ? { kind: 'tool-calls' }
          : finishReason === 'length'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted || this.options.lifetimeSignal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
        return
      }
      const original =
        error instanceof EgressCoolingError
          ? { message, code: error.code, providerRetryAfterMs: error.retryAfterMs }
          : error instanceof LlmError
            ? error.failure
            : { message, code: (error as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'STREAM_FAILED' }
      const partial = outputStarted && !['TOOL_BRIDGE_REJECTED', 'TOOL_BRIDGE_INCOMPLETE'].includes(original.code)
      const failure = partial ? { ...original, code: 'PARTIAL_STREAM_ERROR' } : original
      const diagnostic = error instanceof UpstreamHttpError ? error.diagnostics : undefined
      const retryEligible = !outputStarted && ['RATE_LIMIT', 'EGRESS_COOLING', 'REQUEST_COOLING'].includes(failure.code)
      const transport = lastTransportCode ?? safeTransportCode((error as { cause?: { code?: unknown } })?.cause?.code)
      const data = {
        model: safeModelId(options.model), code: failure.code,
        ...(partial ? { originalCode: original.code } : {}),
        ...(transport ? { transportCode: transport } : {}),
        ...(requestId ? { request: requestId } : {}),
        ...(egress ? { egress } : {}),
        ...(diagnostic ? diagnostic : observedStatus !== undefined ? { status: observedStatus } : {}),
        ...('providerRetryAfterMs' in original && original.providerRetryAfterMs ? { retryAfterMs: original.providerRetryAfterMs } : {}),
        ...(serverWaitMs !== undefined ? { serverRetryAfterMs: serverWaitMs } : {}),
        outputStarted, retryEligible,
        // Raw server message/body/header values may contain user content. The
        // bounded UI failure retains context; persistent logs use fixed summaries.
        error: diagnostic ? `Upstream HTTP ${diagnostic.status}: ${diagnostic.reason}`
          : retryEligible ? 'Request deferred until retry policy permits another attempt'
            : partial ? 'Provider stream failed after output started; automatic replay disabled'
              : 'Provider request failed',
      }
      if (retryEligible) this.logger.warn('adapter', 'request deferred', data)
      else this.logger.error('adapter', 'stream failed', data)
      if (outputStarted) yield* close()
      yield { type: 'finish', reason: { kind: 'error', failure } }
    }
  }

  /** Keep server waits even across manual calls and concurrent successful requests. */
  private rememberRequestWait(model: string, delay: number): void {
    this.options.requestWaitState?.remember(model, delay)
    const now = Date.now()
    const until = Math.min(Number.MAX_SAFE_INTEGER, now + delay)
    for (const [id, deadline] of this.requestWaits) if (deadline <= now) this.requestWaits.delete(id)
    if (this.requestWaits.has(model) || this.requestWaits.size < 256) {
      this.requestWaits.set(model, Math.max(this.requestWaits.get(model) ?? 0, until))
    } else {
      // Never evict a still-blocked model and forget its server deadline.
      this.overflowWaitUntil = Math.max(this.overflowWaitUntil, until)
    }
  }

  private remainingRequestWait(model: string): number {
    const now = Date.now()
    const deadline = this.requestWaits.get(model) ?? 0
    if (deadline <= now) this.requestWaits.delete(model)
    return Math.max(0, Math.ceil(Math.max(deadline, this.overflowWaitUntil) - now))
  }

  private sessionIdFor(options: GenerateOptions): string {
    const key = options.sessionId ? String(options.sessionId) : ''
    const cached = key ? this.sessions.get(key) : undefined
    if (cached) return cached
    const minted = mintSessionId()
    if (key) {
      if (this.sessions.size >= 64) this.sessions.delete(this.sessions.keys().next().value!)
      this.sessions.set(key, minted)
    }
    return minted
  }

  private resolvedModelInfo(provider: string, model: string, found?: FreeModel): LlmResolvedModelInfo {
    const base = found ? this.toModelInfo(provider, found) : { provider, id: model, name: model, inputModalities: ['text' as const] }
    return {
      ...base,
      ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
      ...(found?.maxOutputTokens ? { defaultMaxTokens: found.maxOutputTokens } : {}),
      ...(found?.efforts?.length ? { reasoning: { efforts: found.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.name })) } } : {}),
    }
  }

  private toModelInfo(provider: string, model: FreeModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.inputModalities?.length ? { inputModalities: [...model.inputModalities] } : {}),
    }
  }
}

function toUsage(usage: NonNullable<ChatChunk['usage']>): TokenUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

function safeModelId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value)
    && !/^(?:sk-|pk-|gh[pousr]_|github_pat_|token[_-]|secret[_-])/i.test(value) ? value : '[redacted-model]'
}

function safeTransportCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:E[A-Z_]{1,32}|UND_ERR_[A-Z_]{1,40}|SOCKS_[A-Z_]{1,40}|CERT_[A-Z_]{1,40}|ERR_TLS_[A-Z_]{1,40}|TRANSPORT_ERROR|TIMEOUT)$/.test(value) ? value : undefined
}

function safeOrigin(endpoint: string): string {
  try { return new URL(endpoint).origin } catch { return '(unavailable)' }
}

/** Line-based SSE reader yielding `data:` payloads. */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload) yield payload
        }
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
