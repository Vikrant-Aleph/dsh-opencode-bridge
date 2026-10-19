import { LlmError } from '@deepseek-ai/dsh-llm'
import { retryAfterMs } from './retry-after.js'

export interface HttpDiagnostics {
  status: number
  reason: string
  upstreamType?: string
  retryAfterMs?: number
  requestId?: string
}

/** Only diagnostics, never message/failure/body, may be copied into logs. */
export class UpstreamHttpError extends LlmError {
  readonly diagnostics: HttpDiagnostics

  constructor(message: string, code: string, diagnostics: HttpDiagnostics) {
    super(message, code, {
      status: diagnostics.status,
      ...(diagnostics.retryAfterMs !== undefined ? { providerRetryAfterMs: diagnostics.retryAfterMs } : {}),
      ...(diagnostics.requestId ? { requestId: diagnostics.requestId as never } : {}),
    })
    this.diagnostics = Object.freeze({ ...diagnostics })
  }
}

// Reject credentials even when they happen to fit an opaque identifier grammar.
const CREDENTIAL = /(?:bearer|password|passwd|credential|secret|api[_-]?key|access[_-]?token|auth[_-]?token|^token|^key[_-]|^sk[_-]|^pk[_-]|^gh[pousr]_|^github_pat_|^glpat-|^xox[baprs]-|^AKIA|^eyJ)/i

function requestId(value: string | null): string | undefined {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || CREDENTIAL.test(value)) return undefined
  return value
}

function upstreamType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || CREDENTIAL.test(value)) return undefined
  // Normal error identifiers only: PascalCase ending Error, or snake_case.
  if (!/^(?:[A-Z][A-Za-z0-9]*Error|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/.test(value)) return undefined
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function reason(message: string | undefined, type: string | undefined): string {
  // Exact fixed wording only: do not infer outage status or an IP quota cause.
  if (message && /^(?:Upstream request failed: )?Endpoint is unavailable\.?$/i.test(message)) return 'endpoint_unavailable'
  if (type === 'FreeTierError') return 'free_tier_gate'
  if (type && /^(?:FreeUsageLimitError|QuotaExceededError|insufficient_quota|quota_exceeded|usage_limit_exceeded)$/.test(type)) return 'quota_exceeded'
  if (type && /^(?:RateLimitError|rate_limit_error|rate_limit_exceeded)$/.test(type)) return 'rate_limit'
  if (message && /^(?:Rate limit exceeded|Too many requests)\.?$/i.test(message)) return 'rate_limit'
  if (message && /^(?:Quota exceeded|Usage limit exceeded|Insufficient quota)\.?$/i.test(message)) return 'quota_exceeded'
  return 'upstream_http_error'
}

export async function httpError(
  response: Response,
  options: { minimumRetryAfterMs?: number; now?: number } = {},
): Promise<UpstreamHttpError> {
  let rawMessage: string | undefined
  let type: string | undefined
  try {
    const body: unknown = await response.json()
    const error = record(record(body)?.error)
    if (typeof error?.message === 'string') rawMessage = error.message
    type = upstreamType(error?.type)
  } catch {
    // Bad/non-JSON bodies must not hide the observed HTTP status.
  }
  const message = rawMessage?.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').slice(0, 1000).trim()
    || `opencode free tier HTTP ${response.status}`
  const now = typeof options.now === 'number' && Number.isFinite(options.now) && Math.abs(options.now) <= 8.64e15 ? options.now : Date.now()
  const parsed = retryAfterMs(response, now)
  const minimum = options.minimumRetryAfterMs
  // A local minimum is a floor, not a backoff cap; apply the same safe overflow ceiling.
  const floor = typeof minimum === 'number' && Number.isFinite(minimum) && minimum > 0
    ? Math.min(Number.MAX_SAFE_INTEGER - Math.max(0, Math.ceil(now)), Math.ceil(minimum)) : undefined
  const hint = parsed === undefined ? floor : floor === undefined ? parsed : Math.max(parsed, floor)
  const id = requestId(response.headers.get('x-opencode-log-id'))
  const code = response.status === 401 ? 'AUTH'
    : response.status === 403 && type === 'FreeTierError' ? 'FREE_TIER_GATE'
      : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_HTTP_ERROR'
  return new UpstreamHttpError(message, code, {
    status: response.status,
    reason: reason(rawMessage, type),
    ...(type ? { upstreamType: type } : {}),
    ...(hint !== undefined ? { retryAfterMs: hint } : {}),
    ...(id ? { requestId: id } : {}),
  })
}
