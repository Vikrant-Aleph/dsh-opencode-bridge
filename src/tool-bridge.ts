/** Fail-closed, read-only protocol bridge. No I/O and no tool execution. */
import type { ToolsPlan, WireCall } from './opencode-protocol.js'

export type ToolBridgeReason = 'UNKNOWN_TOOL' | 'TRANSLATION_DISABLED' | 'EXECUTABLE_DECOY' | 'NO_CALLER_TARGET' | 'UNSUPPORTED_TARGET_SCHEMA' | 'INVALID_ARGUMENTS'
export class ToolBridgeError extends Error {
  readonly reason: ToolBridgeReason
  constructor(reason: ToolBridgeReason) {
    super(`Tool bridge rejected call: ${reason}`)
    this.name = 'ToolBridgeError'
    this.reason = reason
  }
}
export interface ToolBridgeOptions { translateDecoys?: boolean }
type Row = Record<string, unknown>
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(reason: ToolBridgeReason): never { throw new ToolBridgeError(reason) }
const routes: Record<string, { required: string; keys: Record<string, string> }> = {
  read: { required: 'path', keys: { path: 'file_path', offset: 'offset', limit: 'limit' } },
  glob: { required: 'pattern', keys: { pattern: 'pattern', path: 'path' } },
  grep: { required: 'pattern', keys: { pattern: 'pattern', path: 'path', include: 'include' } },
}
const annotations = new Set(['title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly'])
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'anyOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Deliberately a conservative JSON Schema subset, not a complete implementation. */
function supported(schema: unknown, depth = 0): boolean {
  if (depth > 40) return false
  if (typeof schema === 'boolean') return true
  if (!object(schema)) return false
  for (const [key, value] of Object.entries(schema)) {
    if (annotations.has(key)) continue
    if (!keywords.has(key)) return false
    switch (key) {
      case 'type': {
        const list = Array.isArray(value) ? value : [value]
        if (!list.length || list.some(t => typeof t !== 'string' || !types.has(t))) return false
        break
      }
      case 'properties':
        if (!object(value) || !Object.values(value).every(s => supported(s, depth + 1))) return false
        break
      case 'required':
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return false
        break
      case 'additionalProperties': case 'items':
        if (!supported(value, depth + 1)) return false
        break
      case 'oneOf': case 'anyOf':
        if (!Array.isArray(value) || !value.length || !value.every(s => supported(s, depth + 1))) return false
        break
      case 'enum':
        if (!Array.isArray(value) || !value.length) return false
        break
      case 'const': break
      case 'minLength': case 'maxLength': case 'minItems': case 'maxItems': case 'minProperties': case 'maxProperties':
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false
        break
      default:
        if (typeof value !== 'number' || !Number.isFinite(value) || (key === 'multipleOf' && value <= 0)) return false
    }
  }
  return true
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (object(a) && object(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equal(a[k], b[k]))
  }
  return false
}
function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return object(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    default: return typeof value === type
  }
}
function valid(value: unknown, schema: unknown): boolean {
  if (typeof schema === 'boolean') return schema
  const s = schema as Row
  if (own(s, 'type') && !(Array.isArray(s.type) ? s.type : [s.type]).some(t => matchesType(value, t))) return false
  if (own(s, 'const') && !equal(value, s.const)) return false
  if (own(s, 'enum') && !(s.enum as unknown[]).some(v => equal(value, v))) return false
  if (own(s, 'oneOf') && (s.oneOf as unknown[]).filter(child => valid(value, child)).length !== 1) return false
  if (own(s, 'anyOf') && !(s.anyOf as unknown[]).some(child => valid(value, child))) return false
  if (typeof value === 'number') {
    if (own(s, 'minimum') && value < (s.minimum as number)) return false
    if (own(s, 'maximum') && value > (s.maximum as number)) return false
    if (own(s, 'exclusiveMinimum') && value <= (s.exclusiveMinimum as number)) return false
    if (own(s, 'exclusiveMaximum') && value >= (s.exclusiveMaximum as number)) return false
    if (own(s, 'multipleOf') && !Number.isInteger(value / (s.multipleOf as number))) return false
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (own(s, 'minLength') && length < (s.minLength as number)) return false
    if (own(s, 'maxLength') && length > (s.maxLength as number)) return false
  }
  if (Array.isArray(value)) {
    if (own(s, 'minItems') && value.length < (s.minItems as number)) return false
    if (own(s, 'maxItems') && value.length > (s.maxItems as number)) return false
    if (own(s, 'items') && !value.every(v => valid(v, s.items))) return false
  }
  if (object(value)) {
    const keys = Object.keys(value)
    if (own(s, 'minProperties') && keys.length < (s.minProperties as number)) return false
    if (own(s, 'maxProperties') && keys.length > (s.maxProperties as number)) return false
    if (own(s, 'required') && !(s.required as string[]).every(k => own(value, k))) return false
    const props = own(s, 'properties') ? s.properties as Row : Object.create(null) as Row
    for (const k of keys) {
      if (own(props, k)) { if (!valid(value[k], props[k])) return false }
      else if (own(s, 'additionalProperties') && !valid(value[k], s.additionalProperties)) return false
    }
  }
  return true
}
/** Reject only statically obvious exclusion of the required string field; not SAT. */
function mayAcceptString(schema: unknown): boolean {
  if (typeof schema === 'boolean') return schema
  const s = schema as Row
  if (own(s, 'type') && !(Array.isArray(s.type) ? s.type : [s.type]).includes('string')) return false
  if (own(s, 'const') && typeof s.const !== 'string') return false
  if (own(s, 'enum') && !(s.enum as unknown[]).some(value => typeof value === 'string')) return false
  if (own(s, 'anyOf') && !(s.anyOf as unknown[]).some(mayAcceptString)) return false
  if (own(s, 'oneOf') && !(s.oneOf as unknown[]).some(mayAcceptString)) return false
  return true
}
function targetSchema(name: string, plan: ToolsPlan): Row {
  const route = own(routes, name) ? routes[name] : undefined
  if (!route || !plan.callerNames.has(name) || !plan.callerTools.has(name)) fail('NO_CALLER_TARGET')
  const schema: unknown = plan.callerTools.get(name)!.parameters
  const key = route.keys[route.required]
  if (!object(schema) || !own(schema, 'type') || schema.type !== 'object' || !own(schema, 'properties') || !object(schema.properties) || !own(schema.properties, key) || !supported(schema)) fail('UNSUPPORTED_TARGET_SCHEMA')
  if (!mayAcceptString(schema.properties[key])) fail('UNSUPPORTED_TARGET_SCHEMA')
  const allowed = new Set(Object.values(route.keys))
  if (own(schema, 'required') && (schema.required as string[]).some(k => !allowed.has(k))) fail('UNSUPPORTED_TARGET_SCHEMA')
  return schema
}
function preflight(name: string, plan: ToolsPlan, options: ToolBridgeOptions): Row {
  // Executable decoys are never translated, irrespective of platform or caller tools.
  if (name === 'bash' || name === 'shell') fail('EXECUTABLE_DECOY')
  if (options.translateDecoys === false) fail('TRANSLATION_DISABLED')
  return targetSchema(name, plan)
}
function nativeArguments(raw: string): void {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail('INVALID_ARGUMENTS') }
  if (!object(value)) fail('INVALID_ARGUMENTS')
}
export function resolveToolCall(call: WireCall, plan: ToolsPlan, options: ToolBridgeOptions = {}): WireCall {
  const original = plan.aliasToOriginal.get(call.name)
  if (original !== undefined) {
    nativeArguments(call.arguments)
    return { ...call, name: original }
  }
  if (!plan.decoys.has(call.name)) {
    if (plan.callerNames.has(call.name)) {
      nativeArguments(call.arguments)
      return call
    }
    return fail('UNKNOWN_TOOL')
  }
  const schema = preflight(call.name, plan, options)
  const route = routes[call.name]
  let args: unknown
  try { args = JSON.parse(call.arguments) } catch { return fail('INVALID_ARGUMENTS') }
  if (!object(args) || !own(args, route.required) || typeof args[route.required] !== 'string') fail('INVALID_ARGUMENTS')
  const mapped: Row = Object.create(null) as Row
  for (const [key, value] of Object.entries(args)) {
    if (!own(route.keys, key)) fail('INVALID_ARGUMENTS')
    if (key === 'offset' || key === 'limit') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_ARGUMENTS')
    } else if (typeof value !== 'string') fail('INVALID_ARGUMENTS')
    mapped[route.keys[key]] = value
  }
  if (!valid(mapped, schema)) fail('INVALID_ARGUMENTS')
  return { ...call, name: call.name, arguments: JSON.stringify(mapped) }
}
/** Contains names and decisions only: never prompts, schemas, arguments, or errors. */
export function auditToolBridge(plan: ToolsPlan, options: ToolBridgeOptions = {}) {
  const decoys = [...plan.decoys].sort().map(name => {
    try {
      preflight(name, plan, options)
      return { name, action: 'translate' as const, target: name }
    } catch (error) {
      return { name, action: 'reject' as const, reason: error instanceof ToolBridgeError ? error.reason : 'UNSUPPORTED_TARGET_SCHEMA' as ToolBridgeReason }
    }
  })
  const aliases = [...plan.aliasToOriginal].sort(([a], [b]) => a.localeCompare(b)).map(([wireName, callerName]) => ({ wireName, callerName }))
  const availableNativeWireNames = plan.tools.map(t => t.function.name).filter(name => !plan.decoys.has(name)).sort()
  return {
    policy: 'read-only-decoy-translation; executable-decoys-rejected',
    validation: 'conservative-json-schema-subset; candidate mappings still require per-call validation; native-caller-validation-remains-authoritative',
    noNetwork: true, noExecution: true,
    callerNames: [...plan.callerNames].sort(), availableNativeWireNames, aliases, decoys,
    counts: { callers: plan.callerNames.size, aliases: aliases.length, decoys: decoys.length, translated: decoys.filter(d => d.action === 'translate').length, rejected: decoys.filter(d => d.action === 'reject').length },
  }
}
