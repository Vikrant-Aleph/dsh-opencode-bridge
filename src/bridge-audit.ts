/** Offline, agent-scoped inspection of the safe tool bridge. No network or execution. */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import { planTools } from './opencode-protocol.js'
import { auditToolBridge } from './tool-bridge.js'

export interface BridgeSettings {
  fingerprint: boolean
  translateDecoys: boolean
}
export interface ScopedToolRegistry {
  schemas(scope: object): ToolSchema[]
}
interface AuditExecution {
  agent?: object
  signal?: AbortSignal
}

/** A tool definition kept factory-shaped so its real execution path can be tested. */
export function createBridgeAuditTool(registry: ScopedToolRegistry, settings: BridgeSettings) {
  return {
    name: 'opencode_bridge_audit',
    description:
      'Inspect OpenCode tool-bridge compatibility for the current agent: aliases, allowed read/search mappings, ' +
      'and blocked fingerprint tools with reason codes. Offline and read-only; no prompts, arguments, ' +
      'schema descriptions or defaults are returned. This audits the scoped native tool registry; ' +
      'Code Mode presentation may differ from the actual request.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum names shown per list, 1–200; default 80. Counts and all fingerprint decisions remain complete.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{
        type: 'text', text: value && typeof value === 'object' && 'text' in value && typeof value.text === 'string'
          ? value.text : 'Bridge audit unavailable.',
      }],
    },
    execute: async (args: unknown, exec: AuditExecution = {}): Promise<{ text: string }> => {
      const result = (value: unknown) => ({ text: JSON.stringify(value, null, 2) })
      // schemas(undefined) is a GLOBAL view. Never fall back to it.
      if (!exec.agent || typeof exec.agent !== 'object') {
        return result({ status: 'unavailable', code: 'AGENT_SCOPE_REQUIRED', noNetwork: true, noExecution: true })
      }
      if (exec.signal?.aborted) {
        return result({ status: 'cancelled', code: 'ABORTED', noNetwork: true, noExecution: true })
      }
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
      const limit = input.limit === undefined ? 80 : input.limit
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        return result({ status: 'invalid-input', code: 'LIMIT_OUT_OF_RANGE' })
      }
      try {
        const schemas = registry.schemas(exec.agent)
        const report = auditToolBridge(planTools(schemas, { fingerprint: settings.fingerprint }), settings)
        const omitted = {
          callerNames: Math.max(0, report.callerNames.length - limit),
          nativeWireNames: Math.max(0, report.availableNativeWireNames.length - limit),
          aliases: Math.max(0, report.aliases.length - limit),
        }
        return result({
          status: 'ok', schemaVersion: 1,
          basis: 'current-agent-scoped-native-registry',
          note: 'Actual requests use GenerateOptions.tools; Code Mode and auxiliary calls may expose a different set. No permissions are granted by this audit.',
          ...report,
          callerNames: report.callerNames.slice(0, limit),
          availableNativeWireNames: report.availableNativeWireNames.slice(0, limit),
          aliases: report.aliases.slice(0, limit),
          truncated: Object.values(omitted).some(count => count > 0), omitted,
        })
      } catch {
        // Never echo arbitrary tool definitions or service error strings.
        return result({ status: 'unavailable', code: 'TOOL_PLAN_UNAVAILABLE', noNetwork: true, noExecution: true })
      }
    },
  }
}

/** Only a documented optional Service; no DSH source changes or global patches. */
export function registerBridgeAudit(ctx: Context, settings: BridgeSettings): void {
  ctx.inject(['tools'], (scope: Context) => {
    const tools = scope.get('tools') as (ScopedToolRegistry & { register(definition: unknown): () => void }) | undefined
    if (!tools) return
    return tools.register(createBridgeAuditTool(tools, settings))
  })
}
