import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextPreferencesService, createContextPreferenceTool, registerContextAccess, validContextWrite } from '../lib/context-service.js'
import { Config } from '../lib/index.js'

function fixture() {
  let flag = false, revision = 1, fail = false
  const owner = {}, routes = [], tools = [], writes = [], disposed = []
  const settings = {
    describe(options) { assert.equal(options.redactSecrets, true); return [{ ns: 'custom-bridge-instance', revision, value: { trimCompletedReasoning: flag } }, { ns: 'other', revision: 99, value: { other: true } }] },
    async update(ns, patch, expected) {
      assert.equal(ns, 'custom-bridge-instance'); assert.equal(expected, revision)
      writes.push({ ns, patch, expected })
      if (fail) throw new Error('SECRET_PATH_AND_KEY')
      flag = patch.trimCompletedReasoning; revision++
    },
    configure(policy, fiber) { assert.deepEqual(policy, { auto: false }); assert.equal(fiber, owner); return () => disposed.push('presentation') },
  }
  const connection = { fetch: { register(route) { routes.push(route); return () => disposed.push(route.path) } } }
  const services = { settings, configEditor: { entries: () => [{ fiber: owner, options: { id: 'custom-bridge-instance' } }, { fiber: {}, options: { id: 'other' } }] }, connection, tools: { register(tool) { tools.push(tool); return () => disposed.push('tool') } } }
  const ctx = { fiber: owner, get: key => services[key], inject(names, cb) { const dispose = cb({ ...ctx, ...services }); return { dispose: () => dispose?.() } } }
  const service = new ContextPreferencesService(ctx, () => flag)
  return { ctx, service, settings, routes, tools, writes, disposed, setFail(value) { fail = value }, get flag() { return flag }, services }
}
const envelope = (endpoint, payload, rpcId = 'fixture-rpc') => new Request(`https://fixture.invalid/api/opencode-bridge-context/${endpoint}`, { method: 'POST', body: JSON.stringify({ type: 'server-request', rpcId, method: `opencode-bridge-context/${endpoint}`, payload }) })

test('default preference is a real volatile false reference', () => {
  const config = Config({})
  assert.equal(config.trimCompletedReasoning.get(), false)
  assert.equal(Config({ trimCompletedReasoning: true }).trimCompletedReasoning.get(), true)
  assert.equal(Config.dict.trimCompletedReasoning.meta.volatile, true)
})
test('read returns only this instance preference and safe revision', () => {
  assert.deepEqual(fixture().service.read(), { trimCompletedReasoning: false, writable: true, revision: 1 })
})
test('write uses official merge update with revision and never restates secrets/other fields', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.write({ trimCompletedReasoning: true }), { trimCompletedReasoning: true, writable: true, revision: 2 })
  assert.deepEqual(f.writes[0].patch, { trimCompletedReasoning: true })
  assert.equal((await f.service.write({ trimCompletedReasoning: false })).trimCompletedReasoning, false)
})
test('concurrent writes serialize with fresh revisions; last successful write wins', async () => {
  const f = fixture()
  await Promise.all([f.service.write({ trimCompletedReasoning: true }), f.service.write({ trimCompletedReasoning: false })])
  assert.deepEqual(f.writes.map(value => value.expected), [1, 2])
  assert.equal(f.flag, false)
})
test('persistence failure never changes the live value and does not poison later writes', async () => {
  const f = fixture(); f.setFail(true)
  await assert.rejects(f.service.write({ trimCompletedReasoning: true }))
  assert.equal(f.service.currentTrim(), false)
  f.setFail(false)
  assert.equal((await f.service.write({ trimCompletedReasoning: true })).trimCompletedReasoning, true)
})
test('invalid inputs and prototype tricks cannot write extra config', async () => {
  const f = fixture()
  for (const value of [null, [], {}, { trimCompletedReasoning: 'yes' }, { trimCompletedReasoning: true, apiKey: 'SECRET' }, Object.create({ trimCompletedReasoning: true })]) {
    assert.equal(validContextWrite(value), false)
    await assert.rejects(f.service.write(value))
  }
  assert.equal(f.writes.length, 0)
})
test('missing settings/owner entry and broken getters are conservative/read-only', async () => {
  const f = fixture(); delete f.services.settings
  assert.equal(f.service.read().writable, false)
  await assert.rejects(f.service.write({ trimCompletedReasoning: true }))
  const unavailable = new ContextPreferencesService({ get() { throw Error('private') } }, () => { throw Error('private') })
  assert.deepEqual(unavailable.read(), { trimCompletedReasoning: false, writable: false })
})
test('UI RPC and agent tool share the same setting operation and dispose registrations', async () => {
  const f = fixture(), dispose = registerContextAccess(f.ctx, f.service)
  assert.equal(f.routes.length, 2); assert.equal(f.tools.length, 1)
  const write = f.routes.find(route => route.path.endsWith('/write'))
  assert.deepEqual(write.methods, ['POST']); assert.equal(write.requestBody, 'buffered')
  const response = await (await write.fetch(envelope('write', { trimCompletedReasoning: true }))).json()
  assert.equal(response.type, 'server-response'); assert.equal(response.rpcId, 'fixture-rpc'); assert.equal(response.result.value.trimCompletedReasoning, true)
  assert.equal((await f.tools[0].execute({ action: 'read' })).trimCompletedReasoning, true)
  await f.tools[0].execute({ action: 'write', trimCompletedReasoning: false })
  const read = f.routes.find(route => route.path.endsWith('/read'))
  assert.equal((await (await read.fetch(envelope('read', {}))).json()).result.value.trimCompletedReasoning, false)
  dispose()
  assert.equal(f.disposed.length, 4)
})
test('RPC rejects mismatched methods and invalid payloads before writing', async () => {
  const f = fixture(); registerContextAccess(f.ctx, f.service)
  const route = f.routes.find(route => route.path.endsWith('/write'))
  for (const req of [envelope('read', { trimCompletedReasoning: true }), envelope('write', { trimCompletedReasoning: true, unknown: true }), envelope('write', { trimCompletedReasoning: true }, '')]) {
    const result = await (await route.fetch(req)).json()
    assert.equal(result.result.ok, false); assert.equal(result.result.error.code, 'bad-request')
  }
  assert.equal(f.writes.length, 0)
})
test('RPC failure contains no exception body, path or key', async () => {
  const f = fixture(); f.setFail(true); registerContextAccess(f.ctx, f.service)
  const route = f.routes.find(route => route.path.endsWith('/write'))
  const response = await (await route.fetch(envelope('write', { trimCompletedReasoning: true }))).text()
  assert.doesNotMatch(response, /SECRET_PATH_AND_KEY/)
  assert.equal(JSON.parse(response).result.ok, false)
})
test('context tool has bounded metadata output and exact action parameters', async () => {
  const f = fixture(), tool = createContextPreferenceTool(f.service)
  assert.equal(tool.name, 'opencode_bridge_context')
  assert.equal(tool.parameters.additionalProperties, false)
  await assert.rejects(tool.execute({ action: 'write' }))
  await assert.rejects(tool.execute({ action: 'read', trimCompletedReasoning: false }))
  await assert.rejects(tool.execute(Object.assign(Object.create({ action: 'write' }), { trimCompletedReasoning: true, extra: 1 })))
})
