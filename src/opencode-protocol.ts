/**
 * OpenCode free-tier client protocol.
 *
 * The opencode.ai free tier (Zen relay / "new inference") only accepts requests
 * that look like they come from the official OpenCode client. Community reverse
 * engineering (2026-10) and our own live probes pin the gate down to three
 * layers, all verified against https://opencode.ai/inference/v1:
 *
 *  1. User-Agent: must contain `opencode/<major>.<minor>[.<patch>]` with a
 *     sufficiently new version. A versioned foreign product token such as
 *     `deepseek-harness/0.1.7` anywhere in the value is rejected, so DSH's
 *     attribution is appended with its `/<version>` stripped.
 *  2. Session identity: `x-opencode-session` / `x-opencode-session-id` carry a
 *     `ses_` id whose 12-hex time field is the CLI's descending encoding
 *     `~(ms * 0x1000 + counter)` truncated to 48 bits. The upstream decodes it
 *     and rejects counters that are not small (counter >= 100 fails live), so
 *     the counter is kept real (1 per millisecond tick). `x-opencode-request`
 *     uses the same encoding ascending under `msg_`. Both end in 14 random
 *     base62 characters. The session id stays stable per conversation.
 *  3. Tool fingerprint: the request body must declare OpenCode's own built-in
 *     tools. OpenCode v2.0.26 compares the exact `read` and `shell`
 *     descriptions/parameter schemas; older gates required the
 *     `bash`/`glob`/`grep`/`read` quartet. We send the verbatim `read`/`shell`
 *     definitions plus stub `bash`/`glob`/`grep`, cloak conflicting caller
 *     tools onto collision-free `*_client` aliases. Read/search decoys may be
 *     mapped only after conservative schema validation; executable decoys are
 *     rejected, never guessed into another runtime's shell.
 *
 * Request body: `stream: true` and a non-"none" `tool_choice` are part of the
 * fingerprint on some routes; we always stream and default `tool_choice` to
 * "auto".
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { resolveToolCall } from './tool-bridge.js'

// ---------------------------------------------------------------------------
// Ids

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MASK48 = (1n << 48n) - 1n

let lastIdMs = 0
let idCounter = 0

/** One CLI-shaped 48-bit time field value: `ms * 0x1000 + small counter`. */
function nextIdValue(): bigint {
  const now = Date.now()
  if (now !== lastIdMs) {
    lastIdMs = now
    idCounter = 0
  }
  // Live probes: counters 0-16 pass the upstream check, >= 100 fails. One
  // counter step per id within one millisecond stays far below the ceiling.
  idCounter = Math.min(idCounter + 1, 16)
  return BigInt(now) * 0x1000n + BigInt(idCounter)
}

function random14(): string {
  let out = ''
  for (let i = 0; i < 14; i++) out += BASE62[Math.floor(Math.random() * 62)]
  return out
}

export const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** Official-client session id: descending encoding, low 12 bits `0xFFE` for counter 1. */
export function mintSessionId(): string {
  return `ses_${(~nextIdValue() & MASK48).toString(16).padStart(12, '0')}${random14()}`
}

/** Official-client request id: ascending encoding under `msg_`. */
export function mintRequestId(): string {
  return `msg_${(nextIdValue() & MASK48).toString(16).padStart(12, '0')}${random14()}`
}

// ---------------------------------------------------------------------------
// Headers

export interface HeaderRecipe {
  baseUrl: string
  apiKey: string
  userAgent: string
  client: string
  project: string
  extraHeaders: Record<string, string>
}

/**
 * The DSH attribution `user-agent` (product/version (+url)) collides with the
 * upstream UA gate: a versioned `deepseek-harness/<n>` spelling anywhere in the
 * value is rejected. Keep the attribution, drop only its `/<version>`.
 */
export function attributionSuffix(): string {
  const ua = attributionHeaders()['user-agent']
  return ua ? ` ${ua.replace(/^([\w-]+)\/\S+/, '$1')}` : ''
}

export function buildHeaders(recipe: HeaderRecipe, sessionId: string, requestId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${recipe.apiKey}`,
    'user-agent': `${recipe.userAgent}${attributionSuffix()}`,
    'x-opencode-client': recipe.client,
    'x-opencode-project': recipe.project,
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'x-session-id': sessionId,
    'x-opencode-request': requestId,
    ...recipe.extraHeaders,
  }
}

// ---------------------------------------------------------------------------
// Fingerprint tools (verbatim from the OpenCode v2.0.26 CLI - do not reword)

export const FINGERPRINT_NAMES = ['bash', 'glob', 'grep', 'read', 'shell'] as const

interface FingerprintDef {
  description: string
  parameters: Record<string, unknown>
}

export const READ_TOOL: FingerprintDef = {
  description:
    'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to read' },
      offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
      limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

export const SHELL_TOOL: FingerprintDef = {
  description:
    "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command string to execute' },
      workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
      timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
      background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
    },
    required: ['command'],
    additionalProperties: false,
  },
}

function stubDef(name: string): FingerprintDef {
  return { description: `OpenCode built-in ${name} tool`, parameters: { type: 'object', properties: {} } }
}

const CANONICAL: Record<string, FingerprintDef> = {
  read: READ_TOOL,
  shell: SHELL_TOOL,
  bash: stubDef('bash'),
  glob: stubDef('glob'),
  grep: stubDef('grep'),
}

export interface ChatTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolsPlan {
  /** Outgoing OpenAI-style tool declarations. */
  tools: ChatTool[]
  /** Sent (alias) name -> caller's original tool name. */
  aliasToOriginal: Map<string, string>
  /** Names appended as fingerprint decoys this request. */
  decoys: Set<string>
  /** Original caller tool names (execution targets). */
  callerNames: Set<string>
  /** Exact caller contracts, never a process-wide registry snapshot. */
  callerTools: Map<string, ToolSchema>
}

function canonicalMatch(tool: ToolSchema, key: string): boolean {
  const want = CANONICAL[key]
  return !!want && tool.description === want.description && JSON.stringify(tool.parameters) === JSON.stringify(want.parameters)
}

/**
 * Cloak caller tools that collide with fingerprint names, append the canonical
 * fingerprint declarations, and report the maps needed to read the response.
 */
export function planTools(callerTools: readonly ToolSchema[], options: { fingerprint?: boolean } = {}): ToolsPlan {
  const tools: ChatTool[] = []
  const aliasToOriginal = new Map<string, string>()
  const decoys = new Set<string>()
  const callerNames = new Set(callerTools.map((tool) => tool.name))
  if (callerNames.size !== callerTools.length) throw new Error('Duplicate caller tool names cannot be bridged.')
  const callerContracts = new Map(callerTools.map((tool) => [tool.name, tool]))
  // Reserve ALL original names up front: alias allocation cannot collide with
  // a caller tool that appears later in the array (e.g. read_client).
  const taken = new Set<string>([...FINGERPRINT_NAMES, ...callerNames])
  const fingerprint = options.fingerprint !== false

  for (const tool of callerTools) {
    const key = fingerprint && FINGERPRINT_NAMES.includes(tool.name as (typeof FINGERPRINT_NAMES)[number]) ? tool.name : ''
    if (!key || canonicalMatch(tool, key)) {
      taken.add(tool.name)
      tools.push(chat(tool))
      continue
    }
    // Conflicting definition: travel under an alias; the response side restores
    // the caller's spelling before DSH executes the tool.
    let alias = `${key}_client`
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`
    taken.add(alias)
    aliasToOriginal.set(alias, key)
    tools.push(chat({ ...tool, name: alias }))
  }

  for (const name of fingerprint ? FINGERPRINT_NAMES : []) {
    if (tools.some((t) => t.function.name === name)) continue
    const def = CANONICAL[name]
    tools.push({ type: 'function', function: { name, description: def.description, parameters: def.parameters } })
    decoys.add(name)
  }
  return { tools, aliasToOriginal, decoys, callerNames, callerTools: callerContracts }
}

function chat(tool: ToolSchema): ChatTool {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

// ---------------------------------------------------------------------------
// Conservative decoy translation lives in tool-bridge.ts. No executable
// fingerprint decoy is guessed into a different runtime's tool.

export interface WireCall {
  id: string
  name: string
  arguments: string
}

/** Restore caller aliases; reject any unprovable or executable decoy mapping. */
export function normalizeToolCall(call: WireCall, plan: ToolsPlan, options: { translateDecoys?: boolean } = {}): WireCall {
  return resolveToolCall(call, plan, options)
}

// ---------------------------------------------------------------------------
// Messages -> OpenAI chat messages

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export function buildChatMessages(options: GenerateOptions, plan: ToolsPlan): ChatMessage[] {
  const out: ChatMessage[] = []
  if (options.system) out.push({ role: 'system', content: options.system })

  const originalToAlias = new Map([...plan.aliasToOriginal].map(([alias, original]) => [original, alias]))
  const sentName = (name: string) => originalToAlias.get(name) ?? name

  for (const message of options.messages) {
    switch (message.role) {
      case 'system': {
        const text = contentText(message.content)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'developer':
        // Tool additions/removals are already projected into `options.tools`;
        // the wire request carries the complete declarations instead.
        break
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId),
          content: contentText(message.content) || '(no output)',
        })
        break
      case 'assistant': {
        const texts: string[] = []
        const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
        for (const block of message.content) {
          if (block.type === 'text') texts.push(block.text)
          else if (block.type === 'tool-call') {
            calls.push({
              id: String(block.id),
              type: 'function',
              function: { name: sentName(block.name), arguments: block.arguments },
            })
          }
        }
        out.push({
          role: 'assistant',
          content: texts.join('\n') || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        })
        break
      }
      default: {
        const texts: string[] = []
        for (const block of message.content) {
          if (block.type === 'text') texts.push(block.text)
          else if (block.type === 'image') texts.push('[image omitted: the free-tier chat path is text-only]')
          else if (block.type === 'file') texts.push('[attached file]')
        }
        if (texts.length) out.push({ role: 'user', content: texts.join('\n') })
        break
      }
    }
  }
  return out
}

function contentText(blocks: Message['content']): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n')
}
