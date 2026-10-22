import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText,
  requestImageHandleText, requiredImageOffload, textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { ChatContentPart, ImageMessageProjection } from './opencode-protocol.js'

export interface ImageInputPolicy {
  maxPixels: number
  maxImageBytes: number
  maxRequestImageBytes: number
  maxImages: number
}

export const DEFAULT_IMAGE_INPUT_POLICY: Readonly<ImageInputPolicy> = Object.freeze({
  maxPixels: 4194304,
  maxImageBytes: 1048576,
  maxRequestImageBytes: 20971520,
  maxImages: 20,
})

export function resolveImageInputPolicy(input?: Partial<ImageInputPolicy>): Readonly<ImageInputPolicy> {
  const policy = { ...DEFAULT_IMAGE_INPUT_POLICY, ...input }
  for (const key of Object.keys(DEFAULT_IMAGE_INPUT_POLICY) as (keyof ImageInputPolicy)[]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) {
      throw new TypeError(`Image input policy ${key} must be a positive safe integer.`)
    }
  }
  return Object.freeze(policy)
}

export function requestImageTarget(ref: ImageAttachmentRef, policy: ImageInputPolicy): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, policy.maxPixels), maxBytes: policy.maxImageBytes }
}

const TOOL_IMAGE_OMITTED = '[image omitted because this route does not accept images in tool results]'
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const readFailed = () => new LlmError('Image attachment request projection could not be read.', 'IMAGE_ATTACHMENT_READ_FAILED')
const unavailable = () => new LlmError('Image attachment request projection is unavailable.', 'IMAGE_ATTACHMENT_UNAVAILABLE')
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0

function validRef(ref: ImageAttachmentRef): boolean {
  return !!ref && typeof ref.attachmentId === 'string' && ref.attachmentId.length > 0
    && mediaTypes.has(ref.mediaType) && positiveInteger(ref.width)
    && positiveInteger(ref.height) && positiveInteger(ref.bytes)
}

function sameMetadata(a: ImageAttachmentRef, b: ImageAttachmentRef): boolean {
  return a.attachmentId === b.attachmentId && a.width === b.width && a.height === b.height
    && a.bytes === b.bytes && a.mediaType === b.mediaType
}

function validVersion(version: RequestImageAttachment, ref: ImageAttachmentRef): boolean {
  return !!version && version.attachment?.attachmentId === ref.attachmentId
    && version.data instanceof Uint8Array && version.data.length > 0
    && version.bytes === version.data.length && mediaTypes.has(version.mediaType)
    && positiveInteger(version.width) && positiveInteger(version.height)
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason
}

/** Also bounds an uncooperative reader; handlers consume any later rejection. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) onAbort()
  })
}

function enforceBudget(offloadImages: number): void {
  if (offloadImages > 0) {
    throw new LlmError('Request image limits require offloading retained image occurrences.',
      IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
  }
}

/** Prepare only request-scoped image data. No path access, global cache, or implicit image removal. */
export async function prepareImageProjection(
  messages: GenerateOptions['messages'],
  options: {
    supportsImages: boolean
    toolImages?: boolean
    attachments?: Pick<AttachmentStore, 'readImageRequest'>
    policy?: Partial<ImageInputPolicy>
    signal?: AbortSignal
  },
): Promise<ImageMessageProjection> {
  const { signal, supportsImages } = options
  checkAbort(signal)
  const policy = resolveImageInputPolicy(options.policy)
  const toolImages = supportsImages && options.toolImages === true
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool'
      && message.content.some(block => block.type === 'image')) {
      throw new LlmError('Images are supported only in user and tool messages.', 'UNSUPPORTED_CONTENT')
    }
  }
  // Keep occurrence order for the official budget helper, excluding disabled tool images.
  const eligible = messages.filter(message => supportsImages
    && (message.role === 'user' || (message.role === 'tool' && toolImages)))
  enforceBudget(requiredImageOffload(eligible, { representation: 'base64', maxImages: policy.maxImages }, () => 0))

  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of eligible) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      const ref = block.attachment
      if (!validRef(ref)) throw readFailed()
      const previous = refs.get(ref.attachmentId)
      if (previous && !sameMetadata(previous, ref)) throw readFailed()
      if (!previous) refs.set(ref.attachmentId, { ...ref })
    }
  }
  const prepared = new Map<string, {
    bytes: number; width: number; height: number; mediaType: string; data?: Uint8Array; url?: string
  }>()
  // Intentionally serial: attachment decoding can have a substantial memory footprint.
  for (const [id, ref] of refs) {
    checkAbort(signal)
    if (typeof options.attachments?.readImageRequest !== 'function') throw unavailable()
    let version: RequestImageAttachment
    try {
      version = await abortable(Promise.resolve(options.attachments.readImageRequest(ref, requestImageTarget(ref, policy), signal)), signal)
    } catch {
      checkAbort(signal)
      throw readFailed()
    }
    checkAbort(signal)
    if (!validVersion(version, ref)) throw readFailed()
    prepared.set(id, {
      bytes: version.bytes, width: version.width, height: version.height,
      mediaType: version.mediaType, data: new Uint8Array(version.data),
    })
  }
  checkAbort(signal)
  enforceBudget(requiredImageOffload(eligible, {
    representation: 'base64', maxBytes: policy.maxRequestImageBytes, maxImages: policy.maxImages,
  }, block => prepared.get(block.attachment.attachmentId)!.bytes))

  return Object.freeze({
    toolImages,
    imageParts(block: ImageBlock, role: 'user' | 'tool'): readonly ChatContentPart[] {
      checkAbort(signal)
      if (role !== 'user' && role !== 'tool') {
        throw new LlmError('Images are supported only in user and tool messages.', 'UNSUPPORTED_CONTENT')
      }
      const ref = block.attachment
      if (block.offloaded === true) return [{ type: 'text', text: offloadedImageText(ref, undefined) }]
      if (!supportsImages) return [{ type: 'text', text: textOnlyImageText(ref) }]
      if (role === 'tool' && !toolImages) return [{ type: 'text', text: TOOL_IMAGE_OMITTED }]
      const version = prepared.get(ref.attachmentId)
      const original = refs.get(ref.attachmentId)
      if (!version || !original || !sameMetadata(original, ref)) throw readFailed()
      // Encode only a budget-approved image that is actually projected; cache per request/id.
      if (version.url === undefined) {
        version.url = `data:${version.mediaType};base64,${Buffer.from(version.data!).toString('base64')}`
        version.data = undefined
      }
      return [
        { type: 'text', text: requestImageHandleText(ref, version, undefined) },
        { type: 'image_url', image_url: { url: version.url } },
      ]
    },
  })
}
