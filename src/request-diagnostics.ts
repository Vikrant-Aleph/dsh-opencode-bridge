/** Content-free, bounded facts about the exact serialized request. Never retain input objects in the result. */
export const REQUEST_DIAGNOSTICS_VERSION = 1
export type DiagnosticFacts = Record<string, string | number | boolean>
export interface WireDiagnosticInput {
  endpoint: string
  headers: Readonly<Record<string, string>>
  serializedBody: string
  configuredTransport: boolean
}
export interface WireDiagnostics { request: DiagnosticFacts; tools: DiagnosticFacts }
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_MESSAGES = 512
const MAX_TOOLS = 128
const MAX_SCHEMA_NODES = 8192
const MAX_DEPTH = 32
const BODY_KEYS = ['model', 'messages', 'stream', 'stream_options', 'tools', 'max_completion_tokens', 'max_tokens', 'temperature', 'stop', 'reasoning_effort']
const PATHS = new Set(['/inference/v1/chat/completions', '/inference/openai/v1/chat/completions', '/zen/v1/chat/completions'])
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer'])
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const bytes = (value: unknown): number => typeof value === 'string' ? Buffer.byteLength(value) : 0
const nameValid = (value: unknown): boolean => typeof value === 'string' && /^[a-z0-9]+$/.test(value)
const numeric = (value: unknown): number | string => value === undefined ? 'absent' : typeof value === 'number' && Number.isFinite(value) ? value : 'invalid'
function tagCount(text: string, tag: string): number {
  let count = 0, start = 0
  while (count < 4096) { const found = text.indexOf(tag, start); if (found < 0) break; count++; start = found + tag.length }
  return count
}
function resolves(root: Record<string, unknown>, ref: string): boolean | undefined {
  if (ref === '#') return true
  if (ref.length > 2048) return undefined
  try {
    const tokens = ref.slice(2).split('/')
    if (tokens.length > MAX_DEPTH) return undefined
    let current: unknown = root
    for (const token of tokens.map(part => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) return false
      current = (current as Record<string, unknown>)[token]
    }
    return true
  } catch { return false }
}

export function summarizeWireRequest(input: WireDiagnosticInput): WireDiagnostics {
  // Every returned string is a fixed enum, known public path, validated UA or role sequence.
  // Caller strings (including tool names, schema property names, refs and IDs) never escape.
  const request: DiagnosticFacts = { schemaVersion: REQUEST_DIAGNOSTICS_VERSION, transport: input.configuredTransport ? 'configured' : 'node-fetch', bodyBytes: bytes(input.serializedBody) }
  const tools: DiagnosticFacts = { schemaVersion: REQUEST_DIAGNOSTICS_VERSION }
  try {
    try {
      const url = new URL(input.endpoint)
      request.route = url.protocol === 'https:' && url.hostname === 'opencode.ai' && !url.port
        ? PATHS.has(url.pathname) ? url.pathname : 'opencode-other'
        : 'custom'
      request.urlQuery = Boolean(url.search)
      request.urlCredentials = Boolean(url.username || url.password)
    } catch { request.route = 'invalid' }
    const headers = new Map(Object.entries(input.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key.toLowerCase(), value]))
    const ua = headers.get('user-agent') ?? ''
    request.ua = /^opencode\/(?:latest|stable|dev|canary)\/\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:rc|beta|alpha)\.\d{1,4})?\/(?:cli|desktop)$/.test(ua) ? ua : 'custom'
    request.uaDshAttribution = ua.includes('deepseek-harness')
    request.authPublic = headers.get('authorization') === 'Bearer public'
    request.clientCli = headers.get('x-opencode-client') === 'cli'
    const aliases = ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id'].map(key => headers.get(key))
    request.sessionValid = typeof aliases[0] === 'string' && /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/.test(aliases[0])
    request.sessionAliasesEqual = Boolean(aliases[0]) && aliases.every(value => value === aliases[0])
    const parent = headers.get('x-opencode-parent-session-id')
    const parentAlias = headers.get('x-parent-session-id')
    request.hasParentSession = parent !== undefined || parentAlias !== undefined
    request.parentAffinityMatches = Boolean(parent) && parent === parentAlias
      && aliases[0] === parent && aliases[2] === parent && aliases[3] === parent && aliases[1] !== parent
    request.traceHeaders = /^[a-f0-9]{32}-[a-f0-9]{16}-1-[a-f0-9]{16}$/.test(headers.get('b3') ?? '') && /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(headers.get('traceparent') ?? '')
    if (Number(request.bodyBytes) > MAX_BODY_BYTES) { request.bodyCapped = true; tools.capped = true; return { request, tools } }
    const body = record(JSON.parse(input.serializedBody))
    request.keys = BODY_KEYS.filter(key => Object.hasOwn(body, key)).join(',')
    request.otherKeys = Object.keys(body).filter(key => !BODY_KEYS.includes(key)).length
    request.maxCompletionTokens = numeric(body.max_completion_tokens)
    request.maxTokens = numeric(body.max_tokens)
    request.temperature = numeric(body.temperature)
    const efforts = ['none', 'off', 'disabled', 'low', 'medium', 'high', 'xhigh', 'max']
    request.effort = body.reasoning_effort === undefined ? 'absent' : typeof body.reasoning_effort === 'string' && efforts.includes(body.reasoning_effort) ? body.reasoning_effort : 'custom'
    request.stopCount = array(body.stop).length
    request.stream = body.stream === true
    request.includeUsage = record(body.stream_options).include_usage === true
    const declarations = array(body.tools)
    const declared = new Set(declarations.map(tool => record(record(tool).function).name).filter((name): name is string => typeof name === 'string'))
    const messages = array(body.messages)
    request.messages = messages.length
    request.messagesCapped = messages.length > MAX_MESSAGES
    request.roles = messages.slice(0, 16).map(message => { const role = record(message).role; return typeof role === 'string' && ROLES.has(role) ? role : 'other' }).join(',')
    let users = 0, systems = 0, textBytes = 0, systemBytes = 0, starts = 0, ends = 0, images = 0, calls = 0, results = 0, invalidHistoryNames = 0, undeclaredHistoryNames = 0
    const callIds = new Set<string>(), resultIds = new Set<string>()
    for (const raw of messages.slice(0, MAX_MESSAGES)) {
      const message = record(raw)
      if (message.role === 'user') users++
      if (message.role === 'system') systems++
      const texts: string[] = typeof message.content === 'string' ? [message.content] : []
      for (const rawPart of array(message.content)) {
        const part = record(rawPart)
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
        if (part.type === 'image_url') images++
      }
      for (const text of texts) {
        textBytes += bytes(text)
        if (message.role === 'system') { systemBytes += bytes(text); starts += tagCount(text, '<env>'); ends += tagCount(text, '</env>') }
      }
      for (const rawCall of array(message.tool_calls)) {
        const call = record(rawCall), name = record(call.function).name
        calls++
        if (typeof call.id === 'string') callIds.add(call.id)
        if (!nameValid(name)) invalidHistoryNames++
        if (typeof name !== 'string' || !declared.has(name)) undeclaredHistoryNames++
      }
      if (message.role === 'tool') { results++; if (typeof message.tool_call_id === 'string') resultIds.add(message.tool_call_id) }
    }
    Object.assign(request, { users, systems, textBytes, systemBytes, envStarts: starts, envEnds: ends, images, calls, results, invalidHistoryNames, undeclaredHistoryNames,
      orphanResults: [...resultIds].filter(id => !callIds.has(id)).length, unansweredCalls: [...callIds].filter(id => !resultIds.has(id)).length })

    let invalidNames = 0, duplicateNames = 0, missingParameters = 0, rootObject = 0, strictFalse = 0, strictTrue = 0, strictAbsent = 0, descriptionBytes = 0
    let nodes = 0, depth = 0, properties = 0, required = 0, localRefs = 0, externalRefs = 0, missingRefs = 0, oneOf = 0, anyOf = 0, allOf = 0, enums = 0, nullable = 0, additionalTrue = 0, additionalFalse = 0, capped = declarations.length > MAX_TOOLS
    const names = new Set<string>()
    for (const raw of declarations.slice(0, MAX_TOOLS)) {
      const fn = record(record(raw).function), parameters = record(fn.parameters)
      if (!nameValid(fn.name)) invalidNames++
      if (typeof fn.name === 'string') { if (names.has(fn.name)) duplicateNames++; names.add(fn.name) }
      if (fn.parameters === null || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) missingParameters++
      if (parameters.type === 'object' || array(parameters.type).includes('object')) rootObject++
      if (fn.strict === false) strictFalse++; else if (fn.strict === true) strictTrue++; else strictAbsent++
      descriptionBytes += bytes(fn.description)
      const stack: Array<[unknown, number]> = [[parameters, 0]]
      while (stack.length) {
        if (nodes >= MAX_SCHEMA_NODES) { capped = true; break }
        const [value, currentDepth] = stack.pop()!
        nodes++; depth = Math.max(depth, currentDepth)
        if (currentDepth >= MAX_DEPTH) { capped = true; continue }
        if (value === null || typeof value !== 'object') continue
        const schema = record(value)
        properties += Object.keys(record(schema.properties)).length
        required += array(schema.required).length
        oneOf += array(schema.oneOf).length; anyOf += array(schema.anyOf).length; allOf += array(schema.allOf).length
        enums += array(schema.enum).length
        if (array(schema.type).includes('null')) nullable++
        if (schema.additionalProperties === true) additionalTrue++; else if (schema.additionalProperties === false) additionalFalse++
        if (typeof schema.$ref === 'string') {
          if (schema.$ref === '#' || schema.$ref.startsWith('#/')) {
            localRefs++
            const found = resolves(parameters, schema.$ref)
            if (found === undefined) capped = true
            else if (!found) missingRefs++
          } else if (schema.$ref.startsWith('#')) localRefs++
          else externalRefs++
        }
        const children = Array.isArray(value) ? value : Object.values(schema)
        const room = Math.max(0, MAX_SCHEMA_NODES - nodes - stack.length)
        for (const child of children.slice(0, room)) stack.push([child, currentDepth + 1])
        if (children.length > room) capped = true
      }
    }
    Object.assign(tools, { count: declarations.length, inspected: Math.min(declarations.length, MAX_TOOLS), capped, invalidNames, duplicateNames, missingParameters, rootObject,
      hasRead: declared.has('read'), strictFalse, strictTrue, strictAbsent, descriptionBytes, nodes, depth, properties, required,
      localRefs, externalRefs, missingRefs, oneOf, anyOf, allOf, enums, nullable, additionalTrue, additionalFalse })
  } catch {
    // Parsing/diagnostic failures never expose the exception (which may quote input).
    request.unavailable = true
    tools.unavailable = true
  }
  return { request, tools }
}
