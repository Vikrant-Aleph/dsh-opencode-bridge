/**
 * DSH LLM adapter that speaks the OpenCode free-tier wire protocol.
 */

import {
  ToolCallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { FreeModelCatalog, FreeModel } from './catalog.js'
import type { HeaderRecipe } from './opencode-protocol.js'
import { noopLogger, type LoggerLike } from './logger.js'
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
    return { id: provider, name: 'OpenCode Free' }
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
      const models = await this.catalog.list(options.signal)
      const meta = models.find((m) => m.id === options.model)
      const sessionId = this.sessionIdFor(options)
      const requestId = mintRequestId()
      const plan = planTools(this.options.toolFingerprint && !options.purpose ? options.tools ?? [] : [])
      const messages = buildChatMessages(options, plan)

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
        endpoint,
        model: options.model,
        session: sessionId,
        request: requestId,
        messages: messages.length,
        tools: plan.tools.length,
        purpose: options.purpose ?? 'chat',
      })

      const timeout = AbortSignal.timeout(this.options.requestTimeoutMs)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(this.options.recipe, sessionId, requestId),
        body: JSON.stringify(body),
        signal,
      })

      if (!response.ok) {
        throw await httpError(response)
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
          if (call.function?.name) current.name = call.function.name
          if (call.function?.arguments) current.arguments += call.function.arguments
          calls.set(slot, current)
        }
        if (chunk.usage) usage = toUsage(chunk.usage)
        const reason = chunk.choices?.[0]?.finish_reason
        if (reason) finishReason = reason
      }

      yield* close()

      const wireCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
      const normalized = wireCalls.map((call) => (this.options.toolTranslation ? normalizeToolCall(call, plan) : call))
      for (const call of normalized) {
        const id = ToolCallId(call.id || `call_${call.name}_${blockIndex}`)
        yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: call.arguments }
        yield {
          type: 'block-end',
          index: blockIndex,
          block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
        }
        blockIndex++
      }

      this.logger.info('adapter', 'completed', {
        model: options.model,
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
      const failure =
        error instanceof LlmError
          ? error.failure
          : {
              message,
              code: (error as { name?: string }).name === 'TimeoutError' ? 'TIMEOUT' : 'STREAM_FAILED',
            }
      this.logger.error('adapter', 'stream failed', { code: failure.code, error: message })
      yield { type: 'finish', reason: { kind: 'error', failure } }
    }
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

async function httpError(response: Response): Promise<LlmError> {
  let message = `opencode free tier HTTP ${response.status}`
  let type = ''
  try {
    const body = (await response.json()) as { error?: { message?: string; type?: string } }
    if (body.error?.message) message = body.error.message
    if (body.error?.type) type = body.error.type
  } catch {
    // Non-JSON error body: keep the status message.
  }
  const retryAfter = Number(response.headers.get('retry-after-ms') ?? response.headers.get('retry-after'))
  const code =
    response.status === 401
      ? 'AUTH'
      : response.status === 403 && type === 'FreeTierError'
        ? 'FREE_TIER_GATE'
        : response.status === 429
          ? 'RATE_LIMIT'
          : 'PROVIDER_HTTP_ERROR'
  return new LlmError(message, code, {
    status: response.status,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: retryAfter * (response.headers.get('retry-after-ms') ? 1 : 1000) } : {}),
    requestId: response.headers.get('x-opencode-log-id') as never,
  })
}

/** Line-based SSE reader yielding `data:` payloads. */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal.aborted) return
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
