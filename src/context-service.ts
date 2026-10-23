import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

export const CONTEXT_RPC_NAMESPACE = 'opencode-bridge-context'
export interface ContextPreferenceView { trimCompletedReasoning: boolean; writable: boolean; revision?: number }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function validContextWrite(value: unknown): value is { trimCompletedReasoning: boolean } {
  return record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'trimCompletedReasoning') && typeof value.trimCompletedReasoning === 'boolean'
}
/** Uses only DSH's volatile Config/settings API; never writes profile files itself. */
export class ContextPreferencesService {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly ctx: Context, private readonly current: () => boolean) {}
  currentTrim(): boolean { try { return this.current() === true } catch { return false } }
  private descriptor() {
    const settings = this.ctx.get?.('settings')
    const editor = this.ctx.get?.('configEditor')
    const entries = editor?.entries() as Array<{ fiber?: Context['fiber']; options: { id?: string } }> | undefined
    const entry = entries?.find(row => row.fiber === this.ctx.fiber)
    const ns = entry?.options.id
    if (!settings || typeof ns !== 'string') return undefined
    const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === ns)
    return descriptor ? { settings, ns, descriptor } : undefined
  }
  read(): ContextPreferenceView {
    const base = { trimCompletedReasoning: this.currentTrim(), writable: false }
    try {
      const found = this.descriptor()
      return found ? { ...base, writable: true, revision: found.descriptor.revision } : base
    } catch { return base }
  }
  write(payload: unknown): Promise<ContextPreferenceView> {
    if (!validContextWrite(payload)) return Promise.reject(new TypeError('Expected only {trimCompletedReasoning:boolean}.'))
    const desired = payload.trimCompletedReasoning
    const task = this.writes.then(async () => {
      const found = this.descriptor()
      if (!found) throw new Error('Live settings are unavailable for this plugin instance.')
      await found.settings.update(found.ns, { trimCompletedReasoning: desired }, found.descriptor.revision)
      // The volatile reference is updated by the official commit, not by this service.
      if (this.currentTrim() !== desired) throw new Error('Live setting was not applied.')
      return this.read()
    })
    this.writes = task.catch(() => {})
    return task
  }
}

export function createContextPreferenceTool(service: ContextPreferencesService) {
  return {
    name: 'opencode_bridge_context',
    description: 'Read or change OpenCode Bridge reasoning-history preferences. Completed-turn trimming keeps the current tool chain and required reasoning_content fields; it does not delete local history or guarantee token savings.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'write'], description: 'Read preferences or save the supplied preference.' },
      trimCompletedReasoning: { type: 'boolean', description: 'Required for write: true trims only confirmed completed successful turns; false (default) retains all reasoning. Affects new requests.' },
    }, required: ['action'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { trimCompletedReasoning: { type: 'boolean' }, writable: { type: 'boolean' }, revision: { type: 'number' } }, required: ['trimCompletedReasoning', 'writable'], additionalProperties: false },
      render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: unknown) => {
      if (!record(args) || !Object.hasOwn(args, 'action')) throw new TypeError('Expected a context preference action.')
      if (args.action === 'read' && Object.keys(args).length === 1) return service.read()
      if (args.action === 'write' && Object.keys(args).length === 2 && Object.hasOwn(args, 'trimCompletedReasoning') && typeof args.trimCompletedReasoning === 'boolean') return service.write({ trimCompletedReasoning: args.trimCompletedReasoning })
      throw new TypeError('Expected read or write with trimCompletedReasoning.')
    },
  }
}

export function registerContextAccess(ctx: Context, service: ContextPreferencesService): () => void {
  const disposers: Array<() => void | Promise<void>> = []
  const settingsFiber = ctx.inject(['settings'], available => available.settings.configure({ auto: false }, ctx.fiber))
  disposers.push(() => settingsFiber.dispose?.())
  const connectionFiber = ctx.inject(['connection'], available => {
    const connection = (available as unknown as { connection: { fetch: { register(route: unknown): () => void | Promise<void> } } }).connection
    const routes = ['read', 'write'].map(endpoint => connection.fetch.register({
      path: `/api/${CONTEXT_RPC_NAMESPACE}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async (request: Request) => {
        let envelope: unknown
        try { envelope = await request.json() } catch { return new Response('invalid JSON', { status: 400 }) }
        if (!record(envelope)) return new Response('invalid request', { status: 400 })
        const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
        const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
        const fail = (code: string, message: string) => reply({ ok: false, error: { code, message, details: {} } })
        if (!rpcId || rpcId.length > 200 || envelope.method !== `${CONTEXT_RPC_NAMESPACE}/${endpoint}`) return fail('bad-request', 'Context request does not match its endpoint.')
        if (endpoint === 'read' && envelope.payload !== undefined && (!record(envelope.payload) || Object.keys(envelope.payload).length > 0)) return fail('bad-request', 'Read takes no preference fields.')
        if (endpoint === 'write' && !validContextWrite(envelope.payload)) return fail('bad-request', 'Expected only {trimCompletedReasoning:boolean}.')
        try {
          const value = endpoint === 'read' ? service.read() : await service.write(envelope.payload)
          return reply({ ok: true, value })
        } catch (error) {
          return fail((error as { code?: string })?.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'unavailable', 'Preference could not be saved. Refresh and try again.')
        }
      },
    }))
    return () => { for (const dispose of routes) void dispose() }
  })
  disposers.push(() => connectionFiber.dispose?.())
  try {
    const tools = ctx.get?.('tools') as { register(definition: unknown): () => void } | undefined
    if (tools) disposers.push(tools.register(createContextPreferenceTool(service)))
  } catch { /* The optional agent tool cannot disable model calls or the UI. */ }
  return () => { for (const dispose of disposers) void dispose() }
}
