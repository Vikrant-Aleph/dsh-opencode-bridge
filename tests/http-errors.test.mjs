import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { retryAfterMs } from '../lib/retry-after.js'
import { httpError, UpstreamHttpError } from '../lib/http-errors.js'

const now = Date.UTC(2026, 9, 19, 12, 0, 0)
const hint = (headers, clock = now) => retryAfterMs({ headers: new Headers(headers) }, clock)
const response = (status, error, headers = {}) => new Response(JSON.stringify({ error }), { status, headers })

test('429 endpoint unavailable preserves HTTP routing and bounded safe diagnostics', async () => {
  for (const message of ['Endpoint is unavailable', 'Upstream request failed: Endpoint is unavailable']) {
    const error = await httpError(response(429, { message, code: 503, type: 'ProviderError' }))
    assert.ok(error instanceof UpstreamHttpError && error instanceof LlmError)
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.equal(error.failure.status, 429)
    assert.deepEqual(error.diagnostics, { status: 429, reason: 'endpoint_unavailable', upstreamType: 'ProviderError' })
    assert.equal(Object.hasOwn(error.failure, 'requestId'), false)
    assert.equal(Object.hasOwn(error.diagnostics, 'requestId'), false)
  }
})

test('401, 403 free-tier gate, ordinary 403 and 503 use actual status', async () => {
  for (const [status, type, code] of [[401, 'FreeTierError', 'AUTH'], [403, 'FreeTierError', 'FREE_TIER_GATE'], [403, 'OtherError', 'PROVIDER_HTTP_ERROR'], [503, 'RateLimitError', 'PROVIDER_HTTP_ERROR'], [429, 'FreeTierError', 'RATE_LIMIT']]) {
    const error = await httpError(response(status, { type, code: 401 }))
    assert.equal(error.failure.status, status)
    assert.equal(error.failure.code, code)
  }
})

test('strict request id and error type validation never leaks credential-shaped metadata', async () => {
  const bad = ['https://user:password@example.test/?token=abc', 'Bearer abcdefghijkl', 'sk-abcdefghijklmno', 'token_abcdefghijklmno', 'password_hello', 'secret-hello', 'api_key_abc', 'ghp_abcdefghijklmno', 'xoxb-abc', 'eyJabcdefghijklmno', 'white space', 'bad\tcontrol', 'x'.repeat(129)]
  for (const value of bad) {
    // Custom header facade exercises controls that native Headers rejects at construction.
    const res = { status: 429, headers: { get: name => name === 'x-opencode-log-id' ? value : null }, json: async () => ({ error: { type: value, message: 'private password=hidden' } }) }
    const error = await httpError(res)
    assert.deepEqual(error.diagnostics, { status: 429, reason: 'upstream_http_error' }, value)
    assert.equal(Object.hasOwn(error.failure, 'requestId'), false)
  }
  const good = await httpError(response(429, { type: 'rate_limit_error' }, { 'x-opencode-log-id': 'req_ABC-123' }))
  assert.equal(good.diagnostics.upstreamType, 'rate_limit_error')
  assert.equal(good.failure.requestId, 'req_ABC-123')
})

test('body secrets are UI-only, controls removed and message bounded; diagnostics contain no arbitrary body', async () => {
  const secret = 'body-secret-password'
  const error = await httpError(response(429, { message: `\u0000${secret}\n${'x'.repeat(2000)}`, nested: { headers: secret } }))
  assert.ok(error.message.includes(secret))
  assert.ok(error.message.length <= 1000)
  assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f]/)
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /body-secret|password|message|headers|nested/)
  assert.equal(error.diagnostics.reason, 'upstream_http_error')
})

test('non-JSON/null/odd bodies cannot mask HTTP status', async () => {
  for (const body of ['not JSON secret', 'null', '[]', '1', '"secret"', '{"error":null}', '{"error":[]}', '{"error":{"message":{},"type":42}}']) {
    const error = await httpError(new Response(body, { status: 503 }))
    assert.equal(error.failure.status, 503)
    assert.equal(error.failure.code, 'PROVIDER_HTTP_ERROR')
    assert.equal(error.message, 'opencode free tier HTTP 503')
  }
})

test('reason recognizes fixed endpoint/rate/quota/type but never substrings from arbitrary prose', async () => {
  for (const [message, type, reason] of [['Rate limit exceeded', undefined, 'rate_limit'], ['Quota exceeded', undefined, 'quota_exceeded'], ['anything', 'FreeUsageLimitError', 'quota_exceeded'], ['anything', 'rate_limit_error', 'rate_limit'], ['secret Endpoint is unavailable', undefined, 'upstream_http_error']]) {
    assert.equal((await httpError(response(429, { message, type }))).diagnostics.reason, reason)
  }
})

test('positive decimal ms priority, fractional seconds rounding, no local 30 minute cap', () => {
  assert.equal(hint({ 'retry-after-ms': '1.01', 'retry-after': '100' }), 2)
  assert.equal(hint({ 'retry-after': '1.0001' }), 1001)
  assert.equal(hint({ 'retry-after': '7200' }), 7_200_000)
  assert.equal(hint({ 'retry-after-ms': '0.0001' }), 1)
  assert.equal(hint({ 'retry-after-ms': '0'.repeat(400) + '.000' + '0'.repeat(400) + '1' }), 1)
})

test('invalid/zero/negative ms falls back; invalid date/numeric grammar is not accepted', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e3', '+2', '1.', '.5', 'abc', '1,2']) {
    assert.equal(hint({ 'retry-after-ms': value, 'retry-after': '2' }), 2000, value)
    assert.equal(hint({ 'retry-after': value }), undefined, value)
  }
  for (const value of ['1.5x', '2026-10-19', 'Mon, 32 Oct 2026 12:00:00 GMT', 'Mon, 19 Oct 2026 25:00:00 GMT', 'Mon, 31 Feb 2026 12:00:00 GMT', 'Tue, 19 Oct 2026 12:01:00 GMT']) {
    assert.equal(hint({ 'retry-after': value }), undefined, value)
  }
})

test('HTTP-date standard formats, zero/past and malformed server Date fallback', () => {
  for (const date of ['Mon, 19 Oct 2026 12:01:00 GMT', 'Monday, 19-Oct-26 12:01:00 GMT', 'Mon Oct 19 12:01:00 2026']) assert.equal(hint({ 'retry-after': date }), 60_000)
  assert.equal(hint({ 'retry-after': new Date(now).toUTCString() }), undefined)
  assert.equal(hint({ 'retry-after': new Date(now - 1000).toUTCString() }), undefined)
  assert.equal(hint({ 'retry-after': new Date(now + 60_000).toUTCString(), date: '1.5' }), 60_000)
})

test('server Date avoids local clock skew in either direction; positive numeric hints ignore Date', () => {
  const headers = { date: new Date(now).toUTCString(), 'retry-after': new Date(now + 60_000).toUTCString() }
  assert.equal(hint(headers, now + 3_600_000), 60_000)
  assert.equal(hint(headers, now - 3_600_000), 60_000)
  assert.equal(hint({ ...headers, 'retry-after-ms': '1500' }), 1500)
})

test('large and overflow positive waits saturate safely rather than shortening to immediate retry', () => {
  assert.equal(hint({ 'retry-after-ms': '1000000000000000' }), 1e15)
  const ceiling = Number.MAX_SAFE_INTEGER - now
  for (const headers of [{ 'retry-after-ms': '9'.repeat(500) }, { 'retry-after': '9'.repeat(500) }]) {
    const result = hint(headers)
    assert.equal(result, ceiling)
    assert.ok(Number.isSafeInteger(result + now))
  }
})

test('minimum combines with parsed hint as a floor, including date hint and absent hint', async () => {
  for (const [headers, minimum, expected] of [[{ 'retry-after': '7200' }, 1000, 7_200_000], [{ 'retry-after-ms': '2' }, 5000, 5000], [{}, 2.1, 3], [{}, -1, undefined], [{}, Infinity, undefined], [{ date: new Date(now).toUTCString(), 'retry-after': new Date(now + 60_000).toUTCString() }, 90_000, 90_000]]) {
    const error = await httpError(response(429, {}, headers), { minimumRetryAfterMs: minimum, now })
    assert.equal(error.failure.providerRetryAfterMs, expected)
    assert.equal(error.diagnostics.retryAfterMs, expected)
  }
})
