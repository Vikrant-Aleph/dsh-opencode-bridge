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
import type { FreeModelCatalog, FreeModel } from './catalog.js'
import type { HeaderRecipe } from './opencode-protocol.js'
import { noopLogger, type LoggerLike } from './logger.js'
import { ToolBridgeError } from './tool-bridge.js'
import { fetchWithPool, EgressCoolingError, retryAfterMs, type ProxyPool } from './proxy-pool.js'
import { httpError, UpstreamHttpError } from './http-errors.js'
import {
  buildChatMessages,
  buildHeaders,
  mintRequestId,
  mintSessionId,
  normalizeToolCall,
  planTools,
  type WireCall,
} from './opencode-protocol.js'

export interface AdapterOptions {
  providerRoute: string
  recipe: HeaderRecipe
  requestTimeoutMs: number
  toolFingerprint: boolean
  toolTranslation: boolean
  /** Leveled diagnostic logger. Messages must stay metadata-only (see logger.ts). */
  logger?: LoggerLike
  /** Optional egress pool; absent means a plain fetch from this machine. */
  pool?: ProxyPool
  /** Build the CONNECT dispatcher for one proxy URL (injectable for tests). */
  dispatcherFor?: (url: string) => Promise<unknown> | unknown
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

  constructor(
    private readonly catalog: FreeModelCatalog,
    private readonly options: AdapterOptions,
  ) {
    super()
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

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog.list().then((models) => models.map((model) => this.toModelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.catalog.list(_signal).then((models) => {
      const found = models.find((m) => m.id === model)
      const base = found
        ? this.toModelInfo(provider, found)
        : { provider, id: model, name: model, inputModalities: ['text' as const] }
      return {
        ...base,
        ...(found?.contextWindow ? { context: { contextWindow: found.contextWindow } } : {}),
        ...(found?.maxOutputTokens ? { defaultMaxTokens: found.maxOutputTokens } : {}),
        ...(found?.efforts?.length
          ? {
              reasoning: {
                efforts: found.efforts.map((effort) => ({ id: ReasoningEffortId(effort.id), name: effort.name })),
              },
            }
          : {}),
      }
    })
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.resolveModel(provider, model, signal).then((resolved) => ({
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options),
    }))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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
      const requestWait = this.remainingRequestWait(options.model)
      if (requestWait > 0) throw new LlmError(`This model request is cooling down; retry after ${Math.ceil(requestWait / 1000)} seconds.`, 'REQUEST_COOLING', { providerRetryAfterMs: requestWait })
      const models = await this.catalog.list(options.signal)
      const meta = models.find((m) => m.id === options.model)
      const sessionId = this.sessionIdFor(options)
      requestId = mintRequestId()
      const plan = planTools(options.purpose ? [] : options.tools ?? [], { fingerprint: this.options.toolFingerprint })
      const messages = buildChatMessages(options, plan)
      if (plan.decoys.size) {
        const nativeCommands = plan.tools.filter(tool => ['pwsh', 'bash', 'shell'].includes(plan.aliasToOriginal.get(tool.function.name) ?? tool.function.name) && !plan.decoys.has(tool.function.name)).map(tool => tool.function.name)
        const aliases = [...plan.aliasToOriginal].map(([wire, original]) => `${wire} = caller ${original}`).join('; ')
        messages.unshift({
          role: 'system',
          content: 'Tool bridge policy: injected fingerprint declarations do not grant execution authority. ' +
            'Do not call injected bash or shell; use the caller\'s native tools in their declared runtime, never reinterpret Bash commands as PowerShell. ' +
            `Native command wire names: ${nativeCommands.join(', ') || '(none)'}. ` +
            `Prefer caller aliases where supplied: ${aliases || '(none)'}. ` +
            (plan.callerNames.size ? 'Injected read/search calls are accepted only after conservative schema validation.' : 'This request has no executable caller tools; return text only.'),
        })
      }

      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        tools: plan.tools,
        tool_choice: 'auto',
        prompt_cache_key: sessionId.replace(/^ses_/, ''),
      }
      if (options.maxTokens) body.max_tokens = options.maxTokens
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

      const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      signal.throwIfAborted()
      const errors = new WeakMap<Response, UpstreamHttpError>()
      const responseExits = new WeakMap<Response, string>()
      const response = await fetchWithPool({
        pool: this.options.pool,
        url: endpoint,
        init: {
          method: 'POST',
          headers: buildHeaders(this.options.recipe, sessionId, requestId),
          body: JSON.stringify(body),
          signal,
        },
        signal,
        ...(this.options.dispatcherFor ? { dispatcherFor: this.options.dispatcherFor } : {}),
        throttleScope: async (res, exit) => {
          observedStatus = res.status
          egress = exit
          responseExits.set(res, exit)
          const error = await httpError(res)
          errors.set(res, error)
          serverWaitMs = retryAfterMs(res)
          if (serverWaitMs !== undefined) this.rememberRequestWait(options.model, serverWaitMs)
          // Only an explicit free-egress quota signal permits immediate failover.
          // A model/backend outage or unknown 429 is not evidence of an exhausted IP.
          return error.diagnostics.upstreamType === 'FreeUsageLimitError' && error.diagnostics.reason !== 'endpoint_unavailable' ? 'egress' : 'request'
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
      // Validate the WHOLE returned batch before emitting any executable tool
      // block. If one decoy is unsafe, none of this batch can reach DSH dispatch.
      // Aliases are always restored, even when decoy translation is disabled.
      const normalized = wireCalls.map((call) => normalizeToolCall(call, plan, { translateDecoys: this.options.toolTranslation }))
      for (const call of normalized) {
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
        finish: normalized.length ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop',
        toolCalls: normalized.length,
        ...(usage ? { input: usage.inputTokens, output: usage.outputTokens } : {}),
      })
      if (usage) yield { type: 'usage', usage }
      yield {
        type: 'finish',
        reason: normalized.length
          ? { kind: 'tool-calls' }
          : finishReason === 'length'
            ? { kind: 'max-tokens' }
            : { kind: 'stop' },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
        return
      }
      const original =
        error instanceof ToolBridgeError
          ? { message, code: 'TOOL_BRIDGE_REJECTED' }
          : error instanceof EgressCoolingError
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
        ...(error instanceof ToolBridgeError ? { bridgeReason: error.reason } : {}),
        ...(requestId ? { request: requestId } : {}),
        ...(egress ? { egress } : {}),
        ...(diagnostic ? diagnostic : observedStatus !== undefined ? { status: observedStatus } : {}),
        ...('providerRetryAfterMs' in original && original.providerRetryAfterMs ? { retryAfterMs: original.providerRetryAfterMs } : {}),
        ...(serverWaitMs !== undefined ? { serverRetryAfterMs: serverWaitMs } : {}),
        outputStarted, retryEligible,
        // Raw server message/body/header values may contain user content. The
        // bounded UI failure retains context; persistent logs use fixed summaries.
        error: diagnostic ? `Upstream HTTP ${diagnostic.status}: ${diagnostic.reason}`
          : error instanceof ToolBridgeError ? 'Tool bridge rejected a returned call'
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

  private toModelInfo(provider: string, model: FreeModel): LlmModelInfo {
    return {
      provider,
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.inputModalities?.length ? { inputModalities: model.inputModalities } : {}),
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
