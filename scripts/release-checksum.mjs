import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { singleArchive } from './release-check.mjs'

export function checksum(directory, { verify = false } = {}) {
  const archive = singleArchive(directory)
  const name = basename(archive)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(name)) throw new Error('Unsafe archive asset filename')
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const manifest = `${digest}  ${name}\n`
  const target = resolve(directory, 'SHA256SUMS')
  if (verify) {
    if (readFileSync(target, 'utf8') !== manifest) throw new Error('SHA256SUMS mismatch or unexpected entries')
  } else writeFileSync(target, manifest, { flag: 'wx' })
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, mode, ...extra] = process.argv.slice(2)
    if (!directory || extra.length || (mode !== undefined && mode !== '--verify')) throw new Error('Usage: node scripts/release-checksum.mjs <asset-directory> [--verify]')
    console.log(checksum(resolve(directory), { verify: mode === '--verify' }).trim())
  } catch (error) {
    console.error(`Checksum failed: ${error.message}`)
    process.exitCode = 1
  }
}
