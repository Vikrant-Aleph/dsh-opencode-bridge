import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * The release page is generated from the changelog pair, so a version without a
 * section would publish an empty release. `scripts/release-notes.mjs` extracts
 * both languages; these tests keep the files usable by it.
 */
const FILES = { zh: 'CHANGELOG.md', en: 'CHANGELOG.us.md' }
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
const read = (file) => fs.readFileSync(file, 'utf8')

test('both changelog files follow the Keep a Changelog shape', () => {
  for (const file of Object.values(FILES)) {
    const text = read(file)
    assert.match(text, /^# /m, `${file} needs a title`)
    assert.match(text, /## \[[^\]]+\]/, `${file} needs at least one version section`)
  }
  assert.match(read(FILES.zh), /## \[未发布\]/, 'the Chinese changelog needs an Unreleased section')
  assert.match(read(FILES.en), /## \[Unreleased\]/, 'the English changelog needs an Unreleased section')
})

test('the current package version has a section in both languages', () => {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm')
  for (const file of Object.values(FILES)) {
    assert.match(read(file), heading, `${file} must have a section for ${version}`)
  }
})

test('released versions are listed newest first in both files', () => {
  for (const file of Object.values(FILES)) {
    const versions = [...read(file).matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
    assert.ok(versions.length > 0, `${file} should list released versions`)
    const sorted = [...versions].sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
    })
    assert.deepEqual(versions, sorted, `${file} must list versions newest first`)
  }
})

test('the release-notes extractor produces a bilingual body', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['scripts/release-notes.mjs', version], { encoding: 'utf8' })
  assert.ok(out.trim().length > 0, 'release notes must not be empty')
  assert.match(out, /###|##/, 'release notes should contain section headings')
  assert.match(out, /<summary>English<\/summary>/, 'the English section must be present')
  assert.match(out, /[\u4e00-\u9fff]/, 'the Chinese section must be present')
})

test('both changelog files are published with the package', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  for (const file of Object.values(FILES)) {
    assert.ok(pkg.files.includes(file), `${file} must be in package.files`)
  }
})
