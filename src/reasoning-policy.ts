import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'

export const REASONING_PROJECTION_KEY = 'opencodeBridgeCompletedReasoning' as const
const MAX_COMPLETED = 8192
const MAX_PENDING = 512
const MAX_TOOLS = 1024
export interface ReasoningRecord { id: string; hash: string }
export interface CompletedReasoningState {
  activeTurn: number
  pending: ReasoningRecord[]
  tools: string[]
  finalReply: boolean
  unsafe: boolean
  completed: ReasoningRecord[]
}
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { opencodeBridgeCompletedReasoning: CompletedReasoningState }
}
const recordSchema = z.object({ id: z.string().min(1).max(200), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
export const completedReasoningStateSchema = z.object({
  activeTurn: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  pending: z.array(recordSchema).max(MAX_PENDING), tools: z.array(z.string().min(1).max(200)).max(MAX_TOOLS),
  finalReply: z.boolean(), unsafe: z.boolean(), completed: z.array(recordSchema).max(MAX_COMPLETED),
}).strict()
export function initialCompletedReasoningState(): CompletedReasoningState {
  return { activeTurn: -1, pending: [], tools: [], finalReply: false, unsafe: false, completed: [] }
}
function idOf(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined }
/** Fingerprints only supplied reasoning blocks; never store text in projection state. */
export function reasoningFingerprint(content: GenerateOptions['messages'][number]['content']): string | undefined {
  const texts = content.filter(block => block.type === 'reasoning').map(block => block.text)
  return texts.length ? createHash('sha256').update(JSON.stringify(texts)).digest('hex') : undefined
}
function resetCurrent(state: CompletedReasoningState, completed = state.completed): CompletedReasoningState {
  return { activeTurn: -1, pending: [], tools: [], finalReply: false, unsafe: false, completed }
}
/** Conservative canonical-log fold: never infer turns from user/message or wire roles. */
export function reduceCompletedReasoning(state: CompletedReasoningState, event: SessionEvent): CompletedReasoningState {
  if (event.type === 'session/end-seed') return resetCurrent(state)
  if (event.type === 'turn/start') {
    return { ...resetCurrent(state), activeTurn: event.data.turn }
  }
  if (event.type === 'assistant/message') {
    const { message, turn, interrupted } = event.data
    const id = idOf(message.id)
    const completed = id ? state.completed.filter(item => item.id !== id) : state.completed
    const changed = completed.length !== state.completed.length
    if (turn !== state.activeTurn || interrupted === true || event.surfaceOp !== 'append' || message.role !== 'assistant') {
      if (turn === state.activeTurn) return { ...state, completed, unsafe: true, finalReply: false }
      return changed ? { ...state, completed } : state
    }
    const calls = message.content.filter(block => block.type === 'tool-call')
    const tools = [...state.tools]
    let unsafe = state.unsafe
    for (const call of calls) {
      const callId = idOf(call.id)
      if (!callId) { unsafe = true; continue }
      if (!tools.includes(callId)) tools.push(callId)
    }
    const hash = reasoningFingerprint(message.content)
    const pending = state.pending.filter(item => item.id !== id)
    if (id && hash) pending.push({ id, hash })
    if (pending.length > MAX_PENDING || tools.length > MAX_TOOLS || !id) unsafe = true
    return { ...state, pending: pending.slice(-MAX_PENDING), tools: tools.slice(-MAX_TOOLS), completed,
      finalReply: calls.length === 0, unsafe }
  }
  if (event.type === 'tool/result' && event.data.turn === state.activeTurn) {
    const id = String(event.data.message.toolCallId)
    const tools = state.tools.filter(value => value !== id)
    return tools.length === state.tools.length ? state : { ...state, tools }
  }
  if (event.type === 'turn/end') {
    if (event.data.turn !== state.activeTurn) return resetCurrent(state)
    const eligible = event.data.reason.kind === 'completed' && state.finalReply && !state.unsafe && state.tools.length === 0
    return resetCurrent(state, eligible ? [...state.completed, ...state.pending].slice(-MAX_COMPLETED) : state.completed)
  }
  return state
}
export const completedReasoningProjection: ProjectionDefinition<typeof REASONING_PROJECTION_KEY, CompletedReasoningState> = {
  key: REASONING_PROJECTION_KEY, stateVersion: 1, stateSchema: completedReasoningStateSchema,
  init: initialCompletedReasoningState, apply: reduceCompletedReasoning,
}
export function registerReasoningProjection(ctx: Context): () => void {
  const fiber = ctx.inject(['sessionProjections'], available => available.sessionProjections.register(completedReasoningProjection))
  return () => { void fiber.dispose?.() }
}
/** Undefined means no reliable evidence; callers must keep complete history. */
export function completedReasoningForRequest(ctx: Context, options: GenerateOptions): readonly ReasoningRecord[] | undefined {
  if (!options.sessionId || options.purpose) return undefined
  try {
    const agent = ctx.get('agents')?.get(options.sessionId)
    const projections = ctx.get('sessionProjections')
    if (!agent || !projections || agent.session.id !== options.sessionId) return undefined
    return projections.stateOf(agent.session, REASONING_PROJECTION_KEY)?.completed
  } catch { return undefined }
}
export interface ReasoningProjectionResult {
  messages: GenerateOptions['messages']
  trimmedMessages: number
  trimmedCharacters: number
}
/** A request-only projection; session events, tool blocks and private replay state are untouched. */
export function trimCompletedReasoning(messages: GenerateOptions['messages'], records?: readonly ReasoningRecord[]): ReasoningProjectionResult {
  if (!records?.length) return { messages, trimmedMessages: 0, trimmedCharacters: 0 }
  const eligible = new Map(records.map(item => [item.id, item.hash]))
  let trimmedMessages = 0, trimmedCharacters = 0
  const projected = messages.map(message => {
    if (message.role !== 'assistant' || !message.id || !eligible.has(message.id)) return message
    const fingerprint = reasoningFingerprint(message.content)
    if (!fingerprint || fingerprint !== eligible.get(message.id)) return message
    const content = message.content.filter(block => {
      if (block.type !== 'reasoning') return true
      trimmedCharacters += block.text.length
      return false
    })
    trimmedMessages++
    return { ...message, content }
  })
  return { messages: trimmedMessages ? projected : messages, trimmedMessages, trimmedCharacters }
}
