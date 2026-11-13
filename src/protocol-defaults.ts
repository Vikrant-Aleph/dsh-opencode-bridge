/**
 * Protocol compatibility target. The UA is sent byte-identical to the captured
 * official client because the free-tier gate compares it; DSH attribution is
 * opt-in through `userAgentAttribution`.
 */
export const DEFAULT_PROTOCOL_USER_AGENT = 'opencode/latest/2.2.0/cli'
