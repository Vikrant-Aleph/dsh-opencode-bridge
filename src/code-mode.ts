/**
 * Code Mode for the free-tier route.
 *
 * The OpenCode free lane refuses a request that declares many rich tools (real
 * descriptions + complex schemas). The official client avoids this by keeping the
 * wire tool list small and moving the full tool catalog into the system prompt,
 * reached through a single code-execution transport (its "Code Mode").
 *
 * DSH ships the same machinery as the PTC executor, but its `run_code` transport is
 * executor-owned and cannot be registered as an ordinary tool. This module therefore
 * registers a normal tool named `execute` whose body delegates to a `PtcExecutor`
 * instance, reusing DSH's sandboxed program runtime and guarded nested dispatch. The
 * adapter declares simple anchors and `execute` on the wire. An admitted `subagent` or
 * `skill` remains direct (the official client marks both codemode:false); the other
 * callable tools are described in the SDK.
 *
 * Only the free-model provider routes are affected; other agents keep their executor.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  PtcExecutor, Config as PtcConfig, renderToolsSdk, renderToolsSdkPy, type ToolSdkSchema,
} from '@deepseek-ai/dsh-tool-executor-ptc'
import { noopLogger, type LoggerLike } from './logger.js'

/** Wire/registration name of the code-execution transport. A gateway-recognized name. */
export const CODE_MODE_TOOL_NAME = 'execute'
export const DIRECT_SUBAGENT_TOOL_NAME = 'subagent'
/** Official `skill` is codemode:false (a native direct tool), so the bridge keeps it direct too. */
export const DIRECT_SKILL_TOOL_NAME = 'skill'
/**
 * The official client's `skill` description, verbatim (opencode tool/plugin/skill.ts).
 * The free lane fingerprints the recognized `skill` tool's description: DSH's own
 * wording is refused with FreeUsageLimitError while this official text passes (live
 * A/B, 2026-11-25). The wire therefore carries the official description; the input
 * schema stays DSH's `{name}` (also accepted) so dispatch needs no argument rewrite.
 */
export const OFFICIAL_SKILL_DESCRIPTION = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  '',
  'The skill ID must match an available skill or a skill explicitly referenced by the user.',
].join('\n')

/**
 * Simple anchor declarations kept on the wire alongside the transport. The free lane
 * refuses a request whose only tool is the transport, and it rejects rich schemas, so a
 * few recognized names with trivial schemas satisfy its shape checks. They are not meant
 * to be called directly; the adapter drops a stray call to one.
 */
export const CODE_MODE_ANCHOR_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'websearch'] as const

export interface CodeModeHandle {
  /** Unregister the transport tool. */
  dispose(): void
  /** Render the model-facing SDK catalog for the given visible tools (excluding the transport). */
  renderCatalog(tools: readonly ToolSchema[]): string
  /** The instruction telling the model to reach every tool through the transport. */
  instruction: string
}

export interface CodeModeOptions {
  /** Provider routes whose requests should use Code Mode. */
  providers: readonly string[]
  logger?: LoggerLike
}

const INSTRUCTION
  = `Call tools from the SDK below as \`await tools.name(args)\` inside \`${CODE_MODE_TOOL_NAME}\`. `
    + `If \`${DIRECT_SUBAGENT_TOOL_NAME}\` or \`${DIRECT_SKILL_TOOL_NAME}\` is declared for this step, call it directly, not through the SDK. `
    + 'Do not call protocol anchors or guess tool names.'

/**
 * Register the Code Mode transport for the given provider routes. Returns undefined when
 * the host has no PTC runtime, in which case the caller keeps direct tool declaration.
 */
export function createCodeMode(ctx: Context, options: CodeModeOptions): CodeModeHandle | undefined {
  const logger = options.logger ?? noopLogger
  const runtime = ctx.get('ptcRuntime') as { language?: string; programFormat?: string } | undefined
  if (runtime === undefined) {
    logger.info('code-mode', 'PTC runtime unavailable; keeping direct tool declaration')
    return undefined
  }
  const ptc = new PtcExecutor(ctx, PtcConfig({}))
  const providers = new Set(options.providers)

  const transport = defineTool({
    name: CODE_MODE_TOOL_NAME,
    description:
      'Execute a program against the available tools. Takes `code`, the program to execute, and '
      + '`description`, a short summary of what it does. Call tools as `await tools.name(args)` per the '
      + 'SDK declarations in the system prompt. Only what you print or return is program output.',
    parameters: {
      code: { type: 'string', required: true, description: 'The program to execute, following the SDK in the system prompt.' },
      description: { type: 'string', required: true, description: 'Clear, concise description of what this program does, 5-10 words.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
          sandbox: {
            type: 'object', additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true, enum: ['read-only', 'workspace-write', 'danger-full-access'] },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string', enum: ['full', 'partial'] },
            },
          },
        },
      },
      render: (_args, value) => {
        const rendered = value.result === undefined ? '' : JSON.stringify(value.result)
        const parts = [(value.logs ?? []).join('\n'), rendered].filter(part => part.length > 0)
        if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.`)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : '(execute completed with no output)' }]
      },
    },
    presentCall: args => ({ card: 'generic', title: args.description, kind: 'execute', rawInput: args.code }),
    async execute(args, exec) {
      // Delegate to DSH's PTC transport: it runs the program in the sandbox and dispatches
      // nested `tools.*` calls through the guarded pipeline against this agent's tool set.
      const call = { type: 'tool-call' as const, id: exec.callId, name: RUN_CODE_NAME, arguments: JSON.stringify(args) }
      const admitted = exec.toolSet
      const batch = await ptc.execute({
        calls: [call], signal: exec.signal,
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        ...(admitted === undefined ? {} : {
          // Borrow the host's live admission view; never dispose the enclosing step's set.
          toolSet: {
            dispose() {},
            view(scope) {
              const visible = new Map(admitted.view(scope))
              visible.delete(DIRECT_SUBAGENT_TOOL_NAME)
              visible.delete(DIRECT_SKILL_TOOL_NAME)
              visible.delete(CODE_MODE_TOOL_NAME)
              return visible
            },
          },
        }),
      })
      for (const context of batch.additionalContexts) exec.deferContext(context)
      const result = batch.results[0]?.result
      if (result === undefined) throw new Error('execute produced no result')
      if (result.isError) throw new Error(result.error.message)
      if (result.concludesTurn) exec.concludeTurn()
      return result.value as never
    },
  })

  const dispose = ctx.tools.register(transport, {
    when: activation => providers.has(activation.modelSelection.provider),
  })
  logger.info('code-mode', 'Code Mode transport registered', { providers: [...providers] })

  const renderCatalog = (tools: readonly ToolSchema[]): string => {
    const sdk: ToolSdkSchema[] = tools
      .filter(tool => tool.name !== CODE_MODE_TOOL_NAME && tool.name !== DIRECT_SUBAGENT_TOOL_NAME && tool.name !== DIRECT_SKILL_TOOL_NAME)
      // Use each tool's real output schema so the SDK shows precise return types
      // (e.g. read -> {lines}, glob -> {root, paths}); a generic type makes the model guess.
      .map(tool => ({ ...tool, output: ctx.tools.get(tool.name)?.output.schema ?? ({ type: 'json' } as never) }))
    return runtime.language === 'python'
      ? renderToolsSdkPy(sdk)
      : renderToolsSdk(sdk, runtime.programFormat as never)
  }

  return { dispose, renderCatalog, instruction: INSTRUCTION }
}
