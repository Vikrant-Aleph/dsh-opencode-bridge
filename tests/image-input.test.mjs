import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { IMAGE_OFFLOAD_REQUIRED_CODE, offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import { DEFAULT_IMAGE_INPUT_POLICY, prepareImageProjection, requestImageTarget, resolveImageInputPolicy } from '../lib/image-input.js'

// Deliberately synthetic bytes: native attachment validation belongs to the SDK service.
const ref = (id = 'a', extra = {}) => ({ attachmentId: `sha256:${id.repeat(64)}`, width: 3200, height: 2400, bytes: 100, mediaType: 'image/png', ...extra })
const image = (attachment = ref(), extra = {}) => ({ type: 'image', attachment, ...extra })
const message = (role, ...content) => ({ role, content })
const user = (...content) => message('user', ...content)
const version = (attachment, extra = {}) => ({ attachment, variantId: 'fixture', data: new Uint8Array([1, 2, 3]), bytes: 3, width: 1600, height: 1200, mediaType: 'image/jpeg', depth: 'uchar', space: 'srgb', hasAlpha: false, ...extra })
function reader(make = attachment => version(attachment)) {
  const calls = []
  return { calls, readImageRequest(attachment, target, signal) { calls.push({ attachment, target, signal }); return Promise.resolve(make(attachment, target, signal)) } }
}
const prepare = (messages, attachments = reader(), options = {}) => prepareImageProjection(messages, { supportsImages: true, attachments, ...options })
const code = expected => error => { assert.equal(error.code, expected); return true }
const turn = () => new Promise(resolve => setImmediate(resolve))

test('default policy is exact and immutable; overrides do not mutate defaults', () => {
  assert.deepEqual(DEFAULT_IMAGE_INPUT_POLICY, { maxPixels: 4194304, maxImageBytes: 1048576, maxRequestImageBytes: 20971520, maxImages: 20 })
  const policy = resolveImageInputPolicy({ maxImages: 3 })
  assert.equal(policy.maxImages, 3)
  assert.ok(Object.isFrozen(policy))
  assert.ok(Object.isFrozen(DEFAULT_IMAGE_INPUT_POLICY))
  assert.equal(DEFAULT_IMAGE_INPUT_POLICY.maxImages, 20)
})

test('each policy field rejects non-positive, fractional, unsafe and non-number values', () => {
  for (const key of Object.keys(DEFAULT_IMAGE_INPUT_POLICY)) {
    for (const value of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined]) {
      assert.throws(() => resolveImageInputPolicy({ [key]: value }), TypeError)
    }
  }
})

test('targets use official geometry, without upscaling, and the configured byte target', () => {
  const policy = resolveImageInputPolicy({ maxPixels: 1000000, maxImageBytes: 123 })
  for (const [width, height] of [[3200, 2400], [1, 99999], [20, 30], [99999, 1]]) {
    assert.deepEqual(requestImageTarget(ref('a', { width, height }), policy), { ...requestImageDimensions(width, height, policy.maxPixels), maxBytes: 123 })
  }
})

test('data URL uses returned MIME and data, with official occurrence-specific handle first', async () => {
  const block = image(ref('a', { name: 'sample.png' }))
  const attachments = reader()
  const projection = await prepare([user(block)], attachments)
  assert.deepEqual(projection.imageParts(block, 'user'), [
    { type: 'text', text: requestImageHandleText(block.attachment, { width: 1600, height: 1200 }, undefined) },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
  ])
  assert.deepEqual(attachments.calls[0].target, requestImageTarget(block.attachment, DEFAULT_IMAGE_INPUT_POLICY))
})

test('caller block order is retained by synchronous image projection', async () => {
  const first = image(ref('b'))
  const second = image(ref('a'))
  const blocks = [{ type: 'text', text: 'before' }, first, { type: 'text', text: 'between' }, second]
  const attachments = reader(attachment => version(attachment, { data: new Uint8Array([attachment.attachmentId.includes('bbb') ? 4 : 5]), bytes: 1 }))
  const projection = await prepare([user(...blocks)], attachments)
  const parts = blocks.flatMap(block => block.type === 'image' ? projection.imageParts(block, 'user') : [block])
  assert.deepEqual(parts.map(part => part.type), ['text', 'text', 'image_url', 'text', 'text', 'image_url'])
  assert.equal(parts[2].image_url.url, 'data:image/jpeg;base64,BA==')
  assert.equal(parts[5].image_url.url, 'data:image/jpeg;base64,BQ==')
  assert.deepEqual(attachments.calls.map(call => call.attachment.attachmentId), [first.attachment.attachmentId, second.attachment.attachmentId])
})

test('duplicate ids are read once, including occurrences across user and enabled tools', async () => {
  const block = image()
  const attachments = reader()
  const projection = await prepare([user(block), message('tool', block)], attachments, { toolImages: true })
  assert.equal(attachments.calls.length, 1)
  assert.equal(projection.imageParts(block, 'tool')[1].type, 'image_url')
})

test('count preflight charges occurrences, not unique ids, before any read', async () => {
  const attachments = reader()
  await assert.rejects(prepare([user(image(), image(), image())], attachments, { policy: { maxImages: 1 } }), error => {
    assert.equal(error.code, IMAGE_OFFLOAD_REQUIRED_CODE)
    assert.equal(error.failure.offloadImages, 2)
    return true
  })
  assert.equal(attachments.calls.length, 0)
})

test('request bytes charge each duplicate with base64 padding and report offloadImages', async () => {
  const attachments = reader(attachment => version(attachment, { data: new Uint8Array([1]), bytes: 1 }))
  await assert.rejects(prepare([user(image(), image(), image())], attachments, { policy: { maxRequestImageBytes: 4 } }), error => {
    assert.equal(error.code, IMAGE_OFFLOAD_REQUIRED_CODE)
    assert.equal(error.failure.offloadImages, 2)
    return true
  })
  assert.equal(attachments.calls.length, 1)
})

test('actual encoded size, not maxBytes target, controls total budget', async () => {
  const attachments = reader(attachment => version(attachment, { data: new Uint8Array(10), bytes: 10 }))
  await assert.rejects(prepare([user(image())], attachments, { policy: { maxImageBytes: 1, maxRequestImageBytes: 12 } }), code(IMAGE_OFFLOAD_REQUIRED_CODE))
  assert.equal(attachments.calls[0].target.maxBytes, 1)
  const projection = await prepare([user(image())], reader(attachment => version(attachment, { data: new Uint8Array(10), bytes: 10 })), { policy: { maxImageBytes: 1, maxRequestImageBytes: 16 } })
  assert.equal(projection.imageParts(image(), 'user')[1].type, 'image_url')
})

test('offloaded images never read and use official offload text even on text-only models', async () => {
  const block = image(ref(), { offloaded: true })
  for (const supportsImages of [true, false]) {
    const attachments = reader()
    const projection = await prepare([user(block)], attachments, { supportsImages })
    assert.deepEqual(projection.imageParts(block, 'user'), [{ type: 'text', text: offloadedImageText(block.attachment, undefined) }])
    assert.equal(attachments.calls.length, 0)
  }
})

test('text-only models never read or apply retained-image budgets', async () => {
  const attachments = reader()
  const block = image()
  const projection = await prepare([user(block, block)], attachments, { supportsImages: false, toolImages: true, policy: { maxImages: 1, maxRequestImageBytes: 1 } })
  assert.equal(projection.toolImages, false)
  assert.deepEqual(projection.imageParts(block, 'user'), [{ type: 'text', text: textOnlyImageText(block.attachment) }])
  assert.deepEqual(projection.imageParts(block, 'tool'), [{ type: 'text', text: textOnlyImageText(block.attachment) }])
  assert.equal(attachments.calls.length, 0)
})

test('disabled tool images have route-specific placeholder, no reads and no budget charge', async () => {
  const attachments = reader()
  const block = image()
  const projection = await prepare([message('tool', block, block), user(image(ref('b')))], attachments, { policy: { maxImages: 1, maxRequestImageBytes: 4 } })
  const parts = projection.imageParts(block, 'tool')
  assert.equal(projection.toolImages, false)
  assert.equal(parts.length, 1)
  assert.match(parts[0].text, /tool results/)
  assert.doesNotMatch(parts[0].text, /model accepts text only|data:/)
  assert.equal(attachments.calls.length, 1)
})

test('enabled tool images are read, projected, and count toward budgets', async () => {
  const block = image()
  const projection = await prepare([message('tool', block)], reader(), { toolImages: true })
  assert.equal(projection.toolImages, true)
  assert.equal(projection.imageParts(block, 'tool')[1].image_url.url, 'data:image/jpeg;base64,AQID')
  await assert.rejects(prepare([message('tool', block, block)], reader(), { toolImages: true, policy: { maxImages: 1 } }), code(IMAGE_OFFLOAD_REQUIRED_CODE))
})

test('assistant, system and developer images are rejected even when offloaded or text-only', async () => {
  for (const role of ['assistant', 'system', 'developer']) {
    for (const supportsImages of [true, false]) {
      const attachments = reader()
      await assert.rejects(prepare([message(role, image(ref(), { offloaded: true }))], attachments, { supportsImages }), code('UNSUPPORTED_CONTENT'))
      assert.equal(attachments.calls.length, 0)
    }
  }
})

test('projection refuses unknown retained ids and forged metadata without further reads', async () => {
  const attachments = reader()
  const projection = await prepare([user(image())], attachments)
  assert.throws(() => projection.imageParts(image(ref('b')), 'user'), code('IMAGE_ATTACHMENT_READ_FAILED'))
  assert.throws(() => projection.imageParts(image(ref('a', { width: 1 })), 'user'), code('IMAGE_ATTACHMENT_READ_FAILED'))
  assert.throws(() => projection.imageParts(image(), 'assistant'), code('UNSUPPORTED_CONTENT'))
  assert.equal(attachments.calls.length, 1)
})

test('missing attachment service or missing request-projection API is unavailable', async () => {
  for (const attachments of [undefined, {}]) {
    await assert.rejects(prepareImageProjection([user(image())], { supportsImages: true, attachments }), code('IMAGE_ATTACHMENT_UNAVAILABLE'))
  }
  const projection = await prepareImageProjection([user(image(ref(), { offloaded: true }))], { supportsImages: true })
  assert.equal(projection.imageParts(image(ref(), { offloaded: true }), 'user')[0].type, 'text')
})

test('reader sync throws and async rejects are sanitized without secret paths or causes', async () => {
  const secret = 'SECRET C:\\private\\fixture.png data:image/png;base64,sensitive'
  for (const readImageRequest of [() => { throw new Error(secret) }, async () => { throw new Error(secret) }]) {
    await assert.rejects(prepare([user(image())], { readImageRequest }), error => {
      assert.equal(error.code, 'IMAGE_ATTACHMENT_READ_FAILED')
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /SECRET|private|sensitive/)
      return true
    })
  }
})

test('invalid or corrupted request-version metadata is rejected', async () => {
  const variants = [undefined, null, {}, { data: 'secret' }, { data: new Uint8Array() }, { bytes: 2 }, { mediaType: 'image/svg+xml' }, { width: 0 }, { height: 1.5 }, { width: Infinity }, { attachment: ref('b') }]
  for (const extra of variants) {
    const attachments = reader(attachment => extra == null ? extra : version(attachment, extra))
    // An empty object alone is a valid override, so explicitly represent a broken version.
    if (extra && Object.keys(extra).length === 0) attachments.readImageRequest = async () => ({})
    await assert.rejects(prepare([user(image())], attachments), code('IMAGE_ATTACHMENT_READ_FAILED'))
  }
})

test('invalid retained reference metadata is rejected before reading', async () => {
  for (const extra of [{ width: 0 }, { height: 0.1 }, { bytes: -1 }, { bytes: Infinity }, { mediaType: 'image/svg+xml' }, { attachmentId: '' }]) {
    const attachments = reader()
    await assert.rejects(prepare([user(image(ref('a', extra)))], attachments), code('IMAGE_ATTACHMENT_READ_FAILED'))
    assert.equal(attachments.calls.length, 0)
  }
})

test('same id with contradictory source metadata is rejected before all reads', async () => {
  for (const extra of [{ width: 1 }, { height: 1 }, { bytes: 1 }, { mediaType: 'image/jpeg' }]) {
    const attachments = reader()
    await assert.rejects(prepare([user(image(), image(ref('a', extra)))], attachments), code('IMAGE_ATTACHMENT_READ_FAILED'))
    assert.equal(attachments.calls.length, 0)
  }
})

test('same id may have distinct names and original dimensions; handles remain occurrence-specific', async () => {
  const a = image(ref('a', { name: 'one.png' }))
  const b = image(ref('a', { name: 'two.png', originalDimensions: { width: 4000, height: 3000 } }))
  const attachments = reader()
  const projection = await prepare([user(a, b)], attachments)
  assert.equal(attachments.calls.length, 1)
  assert.match(projection.imageParts(a, 'user')[0].text, /one.png/)
  assert.match(projection.imageParts(b, 'user')[0].text, /two.png/)
})

test('already aborted signals preserve exact reason and perform zero reads', async () => {
  const reason = { custom: 'abort reason' }
  const attachments = reader()
  await assert.rejects(prepare([user(image())], attachments, { signal: AbortSignal.abort(reason) }), error => error === reason)
  assert.equal(attachments.calls.length, 0)
})

test('abort during uncooperative read settles promptly with exact reason', async () => {
  const controller = new AbortController()
  const reason = new Error('caller abort')
  const attachments = reader(() => new Promise(() => {}))
  const pending = prepare([user(image())], attachments, { signal: controller.signal })
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(attachments.calls[0].signal, controller.signal)
})

test('late reader rejection after abort is consumed rather than unhandled', async () => {
  const controller = new AbortController()
  let rejectRead
  const attachments = reader(() => new Promise((_, reject) => { rejectRead = reject }))
  const pending = prepare([user(image())], attachments, { signal: controller.signal })
  controller.abort('stop')
  await assert.rejects(pending, error => error === 'stop')
  rejectRead(new Error('SECRET late read error'))
  await turn()
})

test('late reader completion after abort cannot project data or start another read', async () => {
  const controller = new AbortController()
  let resolveRead
  const attachments = reader(() => new Promise(resolve => { resolveRead = resolve }))
  const pending = prepare([user(image(), image(ref('b')))], attachments, { signal: controller.signal })
  controller.abort('stop')
  await assert.rejects(pending, error => error === 'stop')
  resolveRead(version(ref()))
  await turn()
  assert.equal(attachments.calls.length, 1)
})

test('reads are serial and a successful reader that aborts before returning is not accepted', async () => {
  let release
  const attachments = reader(attachment => attachment.attachmentId === ref().attachmentId
    ? new Promise(resolve => { release = () => resolve(version(attachment)) }) : version(attachment))
  const pending = prepare([user(image(), image(ref('b')))], attachments)
  assert.equal(attachments.calls.length, 1)
  release()
  await pending
  assert.equal(attachments.calls.length, 2)
  const controller = new AbortController()
  await assert.rejects(prepare([user(image())], reader(attachment => { controller.abort('returned too late'); return version(attachment) }), { signal: controller.signal }), error => error === 'returned too late')
})

test('base64 is lazy after budgets, cached per id, and detached from provider buffers', async t => {
  const originalToString = Buffer.prototype.toString
  let encodings = 0
  t.mock.method(Buffer.prototype, 'toString', function (encoding, ...args) {
    if (encoding === 'base64') encodings++
    return originalToString.call(this, encoding, ...args)
  })
  await assert.rejects(prepare([user(image())], reader(), { policy: { maxRequestImageBytes: 1 } }), code(IMAGE_OFFLOAD_REQUIRED_CODE))
  assert.equal(encodings, 0)
  const data = new Uint8Array([1, 2, 3])
  const block = image()
  const projection = await prepare([user(block, block)], reader(attachment => version(attachment, { data })))
  assert.equal(encodings, 0)
  data.fill(9)
  assert.equal(projection.imageParts(block, 'user')[1].image_url.url, 'data:image/jpeg;base64,AQID')
  assert.equal(projection.imageParts(block, 'user')[1].image_url.url, 'data:image/jpeg;base64,AQID')
  assert.equal(encodings, 1)
})

test('projection honors later cancellation and snapshots source metadata and capability', async () => {
  const controller = new AbortController()
  const block = image()
  const projection = await prepare([user(block)], reader(), { signal: controller.signal })
  block.attachment.width = 1
  assert.throws(() => projection.imageParts(block, 'user'), code('IMAGE_ATTACHMENT_READ_FAILED'))
  controller.abort('do not send')
  assert.throws(() => projection.imageParts(image(), 'user'), error => error === 'do not send')
})
