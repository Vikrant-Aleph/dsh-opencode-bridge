import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateTag, checkMetadata, checkArchive, readTarGzip, singleArchive } from '../scripts/release-check.mjs'
import { checksum } from '../scripts/release-checksum.mjs'

function fixture(t, version = '1.2.3') {
  const root = mkdtempSync(resolve(tmpdir(), 'release-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = {
    name: 'dsh-opencode-bridge', version, main: 'lib/index.js', types: 'lib/index.d.ts',
    scripts: { prepack: 'echo fixture-prepack', build: 'echo fixture-build' },
    exports: { '.': { default: './lib/index.js', types: './lib/index.d.ts' }, './client': './client.js', './locale/*.json': './locale/*.json' },
    files: ['lib', 'client.js', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const files = new Map(Object.entries({
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'lib/index.js': 'export const plugin = true\n', 'lib/index.d.ts': 'export declare const plugin: boolean\n',
    'client.js': 'export {}\n', 'locale/en.json': '{}\n', 'locale/zh.json': '{}\n',
    'icon.svg': '<svg/>', 'cordis.patch.yml': 'plugins: []\n', LICENSE: 'MIT\n',
    'README.md': `add dsh-opencode-bridge@${version}\nadd ./dsh-opencode-bridge-${version}.tgz\n`,
    'README.zh.md': `add dsh-opencode-bridge@${version}\nadd ./dsh-opencode-bridge-${version}.tgz\n`,
  }))
  for (const [name, content] of files) {
    mkdirSync(dirname(resolve(root, name)), { recursive: true })
    writeFileSync(resolve(root, name), content)
  }
  writeFileSync(resolve(root, '.npmrc'), 'auto-install-peers=false\n')
  writeFileSync(resolve(root, 'pnpm-lock.yaml'), 'settings:\n  autoInstallPeers: false\n')
  const assets = resolve(root, 'assets')
  mkdirSync(assets)
  const archive = resolve(assets, `dsh-opencode-bridge-${version}.tgz`)
  return { root, pkg, files, archive, assets, tag: `v${version}` }
}

// Small independent ustar fixture writer; no package managers, network or plugin code.
function tar(files, overrides = {}) {
  const blocks = []
  for (const [path, content] of files) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    const name = overrides.name ?? `package/${path}`
    header.write(name, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.fill(32, 148, 156)
    header.write(overrides.type ?? '0', 156)
    header.write('ustar\0', 257)
    const sum = header.reduce((a, b) => a + b, 0)
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

for (const version of ['0.4.1', '1.2.3-rc.1', '1.2.3-alpha.0+build.4', '1.2.3+sha.abc']) {
  test(`accepts exact SemVer tag ${version}`, () => {
    const result = validateTag({ version }, `v${version}`)
    assert.equal(result.prerelease, version.includes('-'))
  })
}
for (const version of ['01.2.3', '1.2', '1.2.3-01', '1.2.3-rc..1', '1.2.3+', '1.2.3\n']) {
  test(`rejects invalid SemVer ${JSON.stringify(version)}`, () => assert.throws(() => validateTag({ version }, `v${version}`), /Invalid/))
}
test('rejects mismatched, missing and unprefixed tags', () => {
  for (const tag of ['v1.2.4', '1.2.3', undefined, 'v1.2.3-rc.1']) assert.throws(() => validateTag({ version: '1.2.3' }, tag), /exactly/)
})
test('metadata validates fixture and catches README drift', (t) => {
  const f = fixture(t)
  assert.equal(checkMetadata(f.root, f.tag).version, f.pkg.version)
  writeFileSync(resolve(f.root, 'README.zh.md'), 'dsh-opencode-bridge@0.0.1\ndsh-opencode-bridge-0.0.1.tgz')
  assert.throws(() => checkMetadata(f.root, f.tag), /README.zh.md/)
})
test('frozen lock settings mismatch is an explicit blocker', (t) => {
  const f = fixture(t)
  writeFileSync(resolve(f.root, 'pnpm-lock.yaml'), 'settings:\n  autoInstallPeers: true\n')
  assert.throws(() => checkMetadata(f.root, f.tag), /Frozen-lockfile blocker/)
})
test('correct archive contains all dynamic entries and resources', (t) => {
  const f = fixture(t, '2.3.4-rc.2')
  writeFileSync(f.archive, tar(f.files))
  assert.equal(checkArchive(f.root, f.tag, f.archive).files, f.files.size)
  assert.equal(checkArchive(f.root, f.tag, f.archive).prerelease, true)
})
test('rejects missing locale, plugin entry, declaration and bundle patch', (t) => {
  const f = fixture(t)
  for (const name of ['locale/zh.json', 'lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml']) {
    const files = new Map(f.files)
    files.delete(name)
    writeFileSync(f.archive, tar(files))
    assert.throws(() => checkArchive(f.root, f.tag, f.archive), /Missing archive resource/)
  }
})
for (const path of ['node_modules/a.js', 'research/log.txt', '.env', '.env.local', 'tests/foo.test.mjs', '.github/workflows/test.yml', 'src/index.ts', 'profile/config.yml', 'secrets/key.txt', 'proxy-credentials.json']) {
  test(`rejects accidental/secret archive path ${path}`, (t) => {
    const f = fixture(t)
    writeFileSync(f.archive, tar(new Map([...f.files, [path, 'not public']])))
    assert.throws(() => checkArchive(f.root, f.tag, f.archive), /Forbidden/)
  })
}
test('rejects unexpected files and content substitutions', (t) => {
  const f = fixture(t)
  writeFileSync(f.archive, tar(new Map([...f.files, ['extra.txt', 'surprise']])))
  assert.throws(() => checkArchive(f.root, f.tag, f.archive), /Unexpected archive/)
  writeFileSync(f.archive, tar(new Map([...f.files, ['client.js', 'changed']])))
  assert.throws(() => checkArchive(f.root, f.tag, f.archive), /differs/)
})
test('rejects credential-bearing content even inside an allowed resource', (t) => {
  const f = fixture(t)
  for (const secret of ['http://user:password@private.proxy.test:8080', 'socks5h://user:password@private.proxy.test:1080', 'http://real-user:real-pass@proxy.example:8080', 'http://user:password@[::1]:8080', `ghp_${'a'.repeat(36)}`, `sk-${'x'.repeat(32)}`]) {
    f.files.set('client.js', secret)
    writeFileSync(resolve(f.root, 'client.js'), secret)
    writeFileSync(f.archive, tar(f.files))
    assert.throws(() => checkArchive(f.root, f.tag, f.archive), /credentials/)
  }
})
test('allows only exact public documentation credential placeholders', (t) => {
  const f = fixture(t)
  const example = 'http://user:password@host:port socks5://user:password@proxy.example:1080'
  f.files.set('README.md', example)
  writeFileSync(resolve(f.root, 'README.md'), example)
  writeFileSync(f.archive, tar(f.files))
  assert.equal(checkArchive(f.root, f.tag, f.archive).files, f.files.size)
})

test('archive parser rejects traversal, links, malformed checksums and duplicates', () => {
  for (const name of ['../outside', 'package/../secret', '/absolute', 'package/./x', 'package/dir\\x']) assert.throws(() => readTarGzip(tar([['x', '']], { name })), /Unsafe/)
  for (const type of ['1', '2', 'x']) assert.throws(() => readTarGzip(tar([['x', '']], { type })), /Unsupported/)
  assert.throws(() => readTarGzip(tar([['x', ''], ['x', '']])), /Duplicate/)
  const invalid = Buffer.alloc(1024, 1)
  assert.throws(() => readTarGzip(gzipSync(invalid)), /checksum/)
})
test('exactly one archive and no accidental extra assets', (t) => {
  const f = fixture(t)
  assert.throws(() => singleArchive(f.assets), /exactly one/)
  writeFileSync(f.archive, tar(f.files))
  assert.equal(singleArchive(f.assets), f.archive)
  writeFileSync(resolve(f.assets, 'extra.tgz'), '')
  assert.throws(() => singleArchive(f.assets), /exactly one/)
})
test('checksum creation, non-overwrite and tampering detection', (t) => {
  const f = fixture(t)
  writeFileSync(f.archive, tar(f.files))
  const manifest = checksum(f.assets)
  assert.match(manifest, /^[a-f0-9]{64}  dsh-opencode-bridge-1\.2\.3\.tgz\n$/)
  assert.equal(checksum(f.assets, { verify: true }), manifest)
  assert.throws(() => checksum(f.assets), /EEXIST/)
  writeFileSync(f.archive, Buffer.concat([readFileSync(f.archive), Buffer.from('tampered')]))
  assert.throws(() => checksum(f.assets, { verify: true }), /mismatch/)
})
test('real pnpm pack fixture is compatible with archive validator', { skip: !process.env.RELEASE_TEST_PNPM }, (t) => {
  const f = fixture(t)
  const packed = spawnSync(process.execPath, [process.env.RELEASE_TEST_PNPM, 'pack', '--pack-destination', f.assets], {
    cwd: f.root, stdio: 'inherit',
  })
  assert.equal(packed.status, 0)
  assert.equal(checkArchive(f.root, f.tag, singleArchive(f.assets)).files, f.files.size)
})

test('CLI takes explicit tag or GITHUB_REF_NAME and rejects unknown arguments', (t) => {
  const f = fixture(t)
  const script = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url))
  const run = (args, tag) => spawnSync(process.execPath, [script, '--root', f.root, ...args], {
    env: { ...process.env, GITHUB_REF_NAME: tag ?? '', GITHUB_OUTPUT: '' }, stdio: 'ignore',
  })
  assert.equal(run(['--tag', f.tag]).status, 0)
  assert.equal(run([], f.tag).status, 0)
  assert.equal(run(['--tag', 'v9.9.9']).status, 1)
  assert.equal(run(['--unknown', 'x']).status, 1)
})
