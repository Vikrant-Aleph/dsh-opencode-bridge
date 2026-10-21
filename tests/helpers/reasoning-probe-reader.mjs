// Validation helper only: never records model text/reasoning or executes tools.
export async function consumeProbeResponse(response, signal) {
  if (!response.body) return { state: 'inconclusive', problem: 'empty_stream' }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = '', data = [], event = '', parsed = 0, deltas = 0, finish = false, done = false
  let problem, fieldError = false
  const dispatch = () => {
    const kind = event
    event = ''
    const raw = data.join('\n')
    data = []
    if (/(?:^|[._-])(?:error|failed|failure)(?:$|[._-])/i.test(kind)) problem ??= 'error_event'
    if (!raw.trim()) return
    if (raw.trim() === '[DONE]') { done = true; return }
    let chunk
    try { chunk = JSON.parse(raw) } catch { problem ??= 'malformed_sse_json'; return }
    parsed++
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) { problem ??= 'invalid_sse_envelope'; return }
    if (chunk.error || /(?:^|[._-])(?:error|failed|failure)(?:$|[._-])/i.test(chunk.type ?? '')) {
      problem ??= 'stream_error'
      const message = chunk.error?.message ?? chunk.message ?? ''
      if (typeof message === 'string' && /reasoning_content/i.test(message)) fieldError = true
    }
    if (problem && kind.toLowerCase().includes('error')) {
      const message = chunk.error?.message ?? chunk.message ?? ''
      if (typeof message === 'string' && /reasoning_content/i.test(message)) fieldError = true
    }
    for (const choice of chunk.choices ?? []) {
      if (choice.delta && (typeof choice.delta.content === 'string' || typeof choice.delta.reasoning_content === 'string' || Array.isArray(choice.delta.tool_calls))) deltas++
      if (!choice.finish_reason) continue
      if (['stop', 'length', 'tool_calls', 'function_call'].includes(choice.finish_reason)) finish = true
      else problem ??= 'non_success_finish_reason'
    }
  }
  const line = value => {
    if (!value) { dispatch(); return }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const key = colon < 0 ? value : value.slice(0, colon)
    let content = colon < 0 ? '' : value.slice(colon + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (key === 'data') data.push(content)
    else if (key === 'event') event = content
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      pending += decoder.decode(item.value, { stream: true })
      if (pending.length + data.reduce((n, value) => n + value.length, 0) > 1_000_000) { problem = 'oversized_sse_record'; break }
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        line(pending.slice(0, newline).replace(/\r$/, ''))
        pending = pending.slice(newline + 1)
      }
    }
    pending += decoder.decode()
    if (pending.trim() || data.length || event) problem ??= 'incomplete_sse_record'
    return problem ? { state: fieldError ? 'field_rejected' : 'inconclusive', problem }
      : parsed && (finish || (done && deltas > 0)) ? { state: 'accepted', finish, doneMarker: done }
        : { state: 'inconclusive', problem: 'no_terminal_success' }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
