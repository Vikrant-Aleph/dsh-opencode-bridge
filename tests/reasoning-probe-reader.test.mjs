import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeProbeResponse } from './helpers/reasoning-probe-reader.mjs'

const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
const done = 'data: [DONE]\n\n'
const parse = text => consumeProbeResponse(new Response(text), AbortSignal.timeout(1000))

test('probe accepts complete normal/length/tool-call finishes without storing content', async () => {
  for (const reason of ['stop', 'length', 'tool_calls']) {
    const result = await parse(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'SYNTHETIC_DO_NOT_STORE' }, finish_reason: reason }] })}\n\n${done}`)
    assert.equal(result.state, 'accepted')
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_DO_NOT_STORE/)
  }
})
test('probe rejects error objects and typed error frames even after a normal finish', async () => {
  for (const frame of ['{"error":{"message":"fixture error"}}', '{"type":"error","message":"fixture error"}', '{"type":"response.failed","message":"fixture error"}']) {
    assert.equal((await parse(finish + `data: ${frame}\n\n` + done)).state, 'inconclusive')
  }
})
test('probe rejects explicit error events before or after a finish', async () => {
  const error = 'event: error\ndata: {"message":"fixture error"}\n\n'
  for (const body of [error + finish + done, finish + error + done]) assert.equal((await parse(body)).state, 'inconclusive')
})
test('probe assembles multiline JSON and detects multiline error records', async () => {
  assert.equal((await parse('data: {"error":\ndata: {"message":"fixture error"}}\n\n' + finish + done)).state, 'inconclusive')
  assert.equal((await parse('data: {"choices":\ndata: [{"delta":{},"finish_reason":"stop"}]}\n\n' + done)).state, 'accepted')
})
test('probe fails closed on malformed JSON, truncated records and missing successful termination', async () => {
  for (const body of ['data: not-json\n\n' + finish + done, finish + 'data: {"error":', 'data: [DONE]\n\n', 'data: {"choices":[{"delta":{"content":"fixture"}}]}\n\n', 'data: {"choices":[{"finish_reason":"error"}]}\n\n' + done]) {
    assert.equal((await parse(body)).state, 'inconclusive')
  }
})
test('probe handles CRLF/chunk boundaries and rejects cancellation', async () => {
  assert.equal((await parse((finish + done).replaceAll('\n', '\r\n'))).state, 'accepted')
  const stream = new ReadableStream({ start(controller) { for (const c of finish + done) controller.enqueue(new TextEncoder().encode(c)); controller.close() } })
  assert.equal((await consumeProbeResponse(new Response(stream))).state, 'accepted')
  await assert.rejects(consumeProbeResponse(new Response(finish), AbortSignal.abort()), { name: 'AbortError' })
})
