import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * OpenCode project identity, as observed in official 2.2.0 traffic.
 *
 * Verified against two captures: a non-git working directory produces
 * `sha1("directory:" + resolvedDirectory)`. Git checkouts hash the normalized
 * origin remote, then fall back to the `.git/opencode` cache, then the root
 * commit, then `global`. We deliberately implement only the two derivations we
 * could verify end to end; anything else returns undefined so the caller keeps
 * its configured value instead of inventing an identity.
 */
const GLOBAL = 'global'

export function normalizeGitRemote(remote: string): string | undefined {
  const value = remote.trim()
  if (!value) return undefined
  const strip = (host: string | undefined, name: string | undefined) => {
    if (!host || !name) return undefined
    const cleaned = name.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '')
    return cleaned ? `${host.toLowerCase()}/${cleaned}` : undefined
  }
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return undefined
    return strip(url.hostname, url.pathname)
  } catch {
    // scp-like: [user@]host:path
    const match = /^[^@/:]+@?([^/:]+):(.+)$/.exec(value)
    return match ? strip(match[1], match[2]) : undefined
  }
}

export function gitRemoteIdentity(remote: string): string | undefined {
  const normalized = normalizeGitRemote(remote)
  return normalized ? createHash('sha1').update(`git-remote:${normalized}`).digest('hex') : undefined
}

export function directoryIdentity(directory: string): string | undefined {
  try {
    const resolved = fs.realpathSync(directory)
    return createHash('sha1').update(`directory:${resolved}`).digest('hex')
  } catch {
    return undefined
  }
}

function originRemote(directory: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
    })
    const value = out.trim()
    return value || undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort official project id for a working directory. Returns `undefined`
 * when nothing verifiable applies, so callers fall back to their configured id.
 */
export function projectIdentityFor(directory: string | undefined): string | undefined {
  if (!directory) return undefined
  const remote = originRemote(directory)
  const fromRemote = remote ? gitRemoteIdentity(remote) : undefined
  if (fromRemote) return fromRemote
  const fromDirectory = directoryIdentity(directory)
  return fromDirectory && fromDirectory !== GLOBAL ? fromDirectory : undefined
}

export const PROJECT_ID_GLOBAL = GLOBAL
