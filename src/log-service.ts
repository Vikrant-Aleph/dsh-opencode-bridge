/**
 * Log service: one implementation, two callers.
 *
 * Per DSH plugin practice ("one operation, two callers"), the read/stat/clear/
 * level operations live here once and are reachable from both:
 *
 * - the settings UI, through package-private JSON RPC routes registered on
 *   `connection.fetch` under `/api/opencode-bridge-logs/*` (the same transport a
 *   verified shipped plugin uses), and
 * - the agent, through the `opencode_bridge_log` tool.
 *
 * Every byte served is already redacted by `PluginLogger`; nothing in this
 * module adds formatting that could reintroduce sensitive material.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { PluginLogger, type LogLevel } from './logger.js'

const RPC_NAMESPACE = 'opencode-bridge-logs'
const RPC_CHANNEL = '/api'
const RPC_ENDPOINTS = ['read', 'stat', 'clear', 'level'] as const
type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

export interface ReadValue {
  lines: string[]
  truncated: boolean
  level: LogLevel
  dir: string
  totalBytes: number
  files: Array<{ name: string; bytes: number }>
}

export class LogService {
  constructor(private readonly logger: PluginLogger) {}

  read(level?: LogLevel, limit?: number): ReadValue {
    const stat = this.logger.stat()
    const { lines, truncated } = this.logger.read({ ...(level ? { level } : {}), ...(limit ? { limit } : {}) })
    return {
      lines,
      truncated,
      level: stat.level,
      dir: stat.dir,
      totalBytes: stat.totalBytes,
      files: stat.files,
    }
  }

  clear(): { removed: number } {
    const removed = this.logger.clear()
    this.logger.info('log-service', 'logs cleared on request', { removed })
    return { removed }
  }

  setLevel(level: LogLevel): { level: LogLevel } {
    this.logger.setLevel(level)
    this.logger.info('log-service', 'runtime log level changed', { level })
    return { level: this.logger.getLevel() }
  }
}

interface RpcEnvelope {
  rpcId?: unknown
  method?: unknown
  payload?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'off'
}

function parsePayload(endpoint: RpcEndpoint, payload: unknown): { ok: true; args: { level?: LogLevel; limit?: number } } | { ok: false; message: string } {
  if (!isRecord(payload)) return { ok: false, message: `${endpoint} expects an object payload` }
  const level = payload.level
  if (level !== undefined && !isValidLevel(level)) return { ok: false, message: 'level must be debug|info|warn|error|off' }
  const limit = payload.limit
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    return { ok: false, message: 'limit must be a positive number' }
  }
  return {
    ok: true,
    args: {
      ...(level !== undefined ? { level: level as LogLevel } : {}),
      ...(limit !== undefined ? { limit: Math.floor(limit as number) } : {}),
    },
  }
}

/**
 * Register the `/api/opencode-bridge-logs/*` routes and the `opencode_bridge_log`
 * tool. Returns one disposer for everything registered here.
 */
export function registerLogAccess(ctx: Context, service: LogService): () => void {
  const disposers: Array<() => void | Promise<void>> = []

  ctx.inject(['connection'], (ctxWithConnection: Context) => {
    const connection = (ctxWithConnection as unknown as { connection: { fetch: { register: (route: unknown) => () => Promise<void> | void } } }).connection
    if (!connection?.fetch?.register) return () => {}
    const routeDisposers = RPC_ENDPOINTS.map((endpoint) =>
      connection.fetch.register({
        path: `${RPC_CHANNEL}/${RPC_NAMESPACE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let envelope: RpcEnvelope
          try {
            envelope = (await request.json()) as RpcEnvelope
          } catch {
            return new Response('invalid JSON', { status: 400 })
          }
          const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
          const method = typeof envelope.method === 'string' ? envelope.method : ''
          // DSH's browser RPC client validates this exact envelope and returns
          // `result` to the caller; any other shape fails as
          // "invalid server-response envelope".
          const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
          const failure = (code: string, message: string) =>
            reply({ ok: false, error: { code, message, details: {} } })
          if (method !== `${RPC_NAMESPACE}/${endpoint}`) return failure('bad-request', 'log request method does not match its endpoint')
          const parsed = parsePayload(endpoint, envelope.payload)
          if (!parsed.ok) return failure('bad-request', parsed.message)
          try {
            let value: unknown
            if (endpoint === 'read') {
              value = service.read(parsed.args.level, parsed.args.limit)
            } else if (endpoint === 'stat') {
              const read = service.read()
              value = {
                level: read.level,
                dir: read.dir,
                totalBytes: read.totalBytes,
                files: read.files,
                lines: read.lines.length,
              }
            } else if (endpoint === 'clear') {
              value = service.clear()
            } else {
              value = service.setLevel(parsed.args.level ?? 'info')
            }
            return reply({ ok: true, value })
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

  // Agent tool: same operations, so the model can pull its own diagnostics.
  const tools = ctx.get?.('tools') as { register: (definition: unknown) => () => void } | undefined
  if (tools) {
    try {
      disposers.push(
        tools.register({
          name: 'opencode_bridge_log',
          description:
            'Read or manage the dsh-opencode-bridge plugin diagnostic log (the log of the OpenCode free-model adapter). ' +
            'Use action "read" to fetch recent log lines, "stat" for file sizes and the current level, ' +
            '"level" to change the runtime verbosity (debug|info|warn|error|off), and "clear" to delete all log files. ' +
            'Log lines are already scrubbed of credentials and message content.',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['read', 'stat', 'clear', 'level'],
                description: 'Which operation to run.',
              },
              level: {
                type: 'string',
                enum: ['debug', 'info', 'warn', 'error', 'off'],
                description: 'Minimum level for read, or the new level for the level action.',
              },
              limit: {
                type: 'integer',
                description: 'Maximum log lines to return for read (default 500).',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Human-readable operation result.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
            render: (_args: unknown, value: unknown): ContentBlock[] => {
              const text = isRecord(value) && typeof value.text === 'string' ? value.text : JSON.stringify(value)
              return [{ type: 'text', text }]
            },
          },
          execute: async (args: unknown): Promise<unknown> => {
            const input = isRecord(args) ? args : {}
            const action = typeof input.action === 'string' ? input.action : ''
            const level = isValidLevel(input.level) ? input.level : undefined
            const limit = typeof input.limit === 'number' ? input.limit : undefined
            if (action === 'read') {
              const read = service.read(level, limit)
              const header = `# ${read.lines.length} line(s), level>=${level ?? 'debug'}, ${read.totalBytes} bytes in ${read.dir}`
              return { text: [header, ...(read.truncated ? ['# (truncated to the newest lines)'] : []), ...read.lines].join('\n') }
            }
            if (action === 'stat') {
              const read = service.read()
              const files = read.files.map((f) => `  ${f.name}: ${f.bytes} bytes`).join('\n')
              return {
                text: [
                  `dir: ${read.dir}`,
                  `level: ${read.level}`,
                  `total: ${read.totalBytes} bytes`,
                  `records: ${read.lines.length}`,
                  `files:`,
                  files || '  (none)',
                ].join('\n'),
              }
            }
            if (action === 'level') {
              const next = service.setLevel(level ?? 'info')
              return { text: `runtime log level is now ${next.level}` }
            }
            if (action === 'clear') {
              const result = service.clear()
              return { text: `removed ${result.removed} log file(s)` }
            }
            return { text: `unknown action "${action}" — expected read|stat|clear|level` }
          },
        }),
      )
    } catch {
      // Tools service unavailable; the settings UI path still works.
    }
  }

  return () => {
    for (const dispose of disposers) void dispose()
  }
}

export { RPC_NAMESPACE, RPC_CHANNEL }
