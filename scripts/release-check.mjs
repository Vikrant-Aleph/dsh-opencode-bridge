import { readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// SemVer 2.0: numeric prerelease identifiers cannot have leading zeroes.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const fail = (message) => { throw new Error(message) }
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

export function validateTag(pkg, tag) {
  const parsed = semver.exec(pkg.version)
  if (!parsed || parsed[0] !== pkg.version) fail(`Invalid package SemVer: ${pkg.version}`)
  if (tag !== `v${pkg.version}`) fail(`Tag must be exactly v${pkg.version}; received ${tag ?? '(missing)'}`)
  return { version: pkg.version, prerelease: Boolean(parsed[4]) }
}

export function checkMetadata(root, tag, { checkLock = true } = {}) {
  const pkg = json(resolve(root, 'package.json'))
  const result = validateTag(pkg, tag)
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tarName = pkg.name.replace(/^@/, '').replaceAll('/', '-')
  for (const file of ['README.md', 'README.zh.md']) {
    const text = readFileSync(resolve(root, file), 'utf8')
    const pins = [...text.matchAll(new RegExp(`${escaped}@([^\\s\x60"']+)`, 'g'))].map((m) => m[1])
    const tarPins = [...text.matchAll(new RegExp(`${tarName}-([^\\s\x60"']+)\\.tgz`, 'g'))].map((m) => m[1])
    if (!pins.length || !tarPins.length || [...pins, ...tarPins].some((version) => version !== pkg.version)) {
      fail(`${file}: install commands and tarball examples must match package.version ${pkg.version}`)
    }
  }
  if (checkLock) {
    const npmrc = readFileSync(resolve(root, '.npmrc'), 'utf8')
    const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
    const configured = /^\s*auto-install-peers\s*=\s*(true|false)\s*$/m.exec(npmrc)?.[1] ?? 'true'
    const locked = /^\s+autoInstallPeers:\s*(true|false)\s*$/m.exec(lock)?.[1]
    if (configured !== locked) fail('Frozen-lockfile blocker: .npmrc auto-install-peers and pnpm-lock.yaml settings.autoInstallPeers differ. Regenerate the lockfile under the intended project settings; do not bypass --frozen-lockfile.')
  }
  return { ...result, pkg }
}

function forbidden(path) {
  return /(^|\/)(?:node_modules|research|tests?|src|scripts|\.github|\.git|profiles?|secrets?|credentials?)(\/|$)/i.test(path)
    || /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|.*\.(?:pem|key)|.*(?:proxy|credential|secret)[^/]*\.(?:json|ya?ml|txt|log))$/i.test(path)
    || /(?:\.test\.|\.spec\.)/i.test(path)
}

function allFiles(root, dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isSymbolicLink()) fail(`Symlink is not a release resource: ${path}`)
    return entry.isDirectory() ? allFiles(root, path) : [path]
  })
}

function expectedFiles(root, pkg) {
  const expected = new Set(['package.json'])
  for (const spec of pkg.files ?? []) {
    if (spec.includes('*')) {
      // This package's resource globs are deliberately limited to one directory.
      if (!/^[^*]+\/\*\.[A-Za-z0-9]+$/.test(spec)) fail(`Unsupported package.files glob: ${spec}`)
      const directory = spec.slice(0, spec.lastIndexOf('/'))
      const suffix = spec.slice(spec.indexOf('*') + 1)
      for (const path of allFiles(root, directory)) if (!path.slice(directory.length + 1).includes('/') && path.endsWith(suffix)) expected.add(path)
    } else if (statSync(resolve(root, spec)).isDirectory()) {
      for (const path of allFiles(root, spec)) expected.add(path)
    } else expected.add(spec)
  }
  for (const path of expected) {
    if (forbidden(path)) fail(`Forbidden release resource: ${path}`)
    if (path.startsWith('lib/') && !/\.(?:js|d\.ts)(?:\.map)?$/.test(path)) fail(`Unexpected build resource: ${path}`)
  }
  const targets = [pkg.main, pkg.types, pkg.dsh?.bundle?.patch]
  const visit = (value) => {
    if (typeof value === 'string') targets.push(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(pkg.exports)
  for (const target of targets.filter(Boolean)) {
    if (!target.includes('*') && !expected.has(target.replace(/^\.\//, ''))) fail(`Missing declared entry/resource in package.files: ${target}`)
  }
  return expected
}

// Parse rather than extract: no archive-controlled writes, paths, links or shell arguments.
// pnpm pack emits ordinary ustar headers. Unknown extensions fail closed.
export function readTarGzip(buffer) {
  const tar = gunzipSync(buffer, { maxOutputLength: 128 * 1024 * 1024 })
  const files = new Map()
  let offset = 0
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) fail('Unexpected data after tar terminator')
      return files
    }
    const stored = Number.parseInt(field(header, 148, 8).trim(), 8)
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (stored !== sum) fail('Invalid tar header checksum')
    const prefix = field(header, 345, 155)
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`
    const type = field(header, 156, 1)
    const sizeText = field(header, 124, 12).trim()
    if (!/^[0-7]+$/.test(sizeText)) fail(`Invalid tar size: ${name}`)
    const size = Number.parseInt(sizeText, 8)
    if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.')) fail(`Unsafe archive path: ${name}`)
    const path = name.slice(8).replace(/\/$/, '')
    if (forbidden(path)) fail(`Forbidden archive path: ${name}`)
    if (!['', '0', '5'].includes(type)) fail(`Unsupported tar entry (links/extensions forbidden): ${name}`)
    offset += 512
    if (offset + size > tar.length) fail(`Truncated tar entry: ${name}`)
    if (type !== '5') {
      if (!path || files.has(path)) fail(`Duplicate/empty archive entry: ${name}`)
      files.set(path, tar.subarray(offset, offset + size))
    } else if (size) fail(`Directory has payload: ${name}`)
    offset += Math.ceil(size / 512) * 512
  }
  fail('Missing tar terminator')
}

function packedManifest(pkg) {
  // pnpm 11's documented default manifest obfuscation (not arbitrary changes).
  const result = structuredClone(pkg)
  delete result.packageManager
  delete result.pnpm
  if (result.scripts) {
    for (const key of ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish']) delete result.scripts[key]
  }
  return result
}

export function checkArchive(root, tag, archive) {
  const pkg = json(resolve(root, 'package.json'))
  const result = validateTag(pkg, tag)
  const expected = expectedFiles(root, pkg)
  const files = readTarGzip(readFileSync(archive))
  for (const path of expected) if (!files.has(path)) fail(`Missing archive resource: ${path}`)
  for (const [path, data] of files) {
    if (!expected.has(path)) fail(`Unexpected archive resource: ${path}`)
    // pnpm reserializes package.json; compare its data, not whitespace/key order.
    const same = path === 'package.json'
      ? [pkg, packedManifest(pkg)].some((expected) => isDeepStrictEqual(JSON.parse(data.toString('utf8')), expected))
      : data.equals(readFileSync(resolve(root, path)))
    if (!same) fail(`Archive content differs from checked build: ${path}`)
    const text = data.toString('utf8')
    const urls = [...text.matchAll(/(?:https?|socks(?:4a?|5h?)?):\/\/([^\s/@:]+):([^\s/@]+)@([^\s/:\x60"'<>]+)/gi)]
    // Only these exact public placeholders are exempt, not entire docs/directories.
    const credentialUrl = urls.some(([, user, password, host]) => !(user === 'user' && password === 'password' && ['host', 'proxy.example'].includes(host)))
    if (credentialUrl || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,})\b/.test(text)) fail(`Possible embedded credentials: ${path}`)
  }
  const packed = JSON.parse(files.get('package.json').toString('utf8'))
  if (packed.name !== pkg.name || packed.version !== pkg.version) fail('Archive package identity mismatch')
  return { ...result, files: files.size }
}

export function singleArchive(directory) {
  const entries = readdirSync(directory)
  const archives = entries.filter((name) => name.endsWith('.tgz'))
  if (archives.length !== 1) fail(`Expected exactly one .tgz in ${directory}; found ${archives.length}`)
  if (entries.some((name) => name !== archives[0] && name !== 'SHA256SUMS')) fail(`Unexpected release asset in ${directory}`)
  return resolve(directory, archives[0])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const options = new Map()
    while (args.length) {
      const key = args.shift()
      const value = args.shift()
      if (!['--tag', '--root', '--archive-dir'].includes(key) || !value || options.has(key)) fail(`Invalid argument: ${key}`)
      options.set(key, value)
    }
    const root = resolve(options.get('--root') ?? '.')
    const tag = options.get('--tag') ?? process.env.GITHUB_REF_NAME
    const result = options.has('--archive-dir')
      ? checkArchive(root, tag, singleArchive(resolve(options.get('--archive-dir'))))
      : checkMetadata(root, tag)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${result.prerelease}\n`)
    console.log(`Release validated: ${tag}${result.files ? ` (${result.files} files)` : ''}`)
  } catch (error) {
    console.error(`Release check failed: ${error.message}`)
    process.exitCode = 1
  }
}
