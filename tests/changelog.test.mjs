import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * The release page is generated from CHANGELOG.md, so a version without a section
 * would publish an empty release. `scripts/release-notes.mjs` extracts the section;
 * these tests keep the file usable by it.
 */
const changelog = () => fs.readFileSync('CHANGELOG.md', 'utf8')
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version

test('CHANGELOG.md follows the Keep a Changelog shape', () => {
  const text = changelog()
  assert.match(text, /^# Changelog/m)
  assert.match(text, /## \[Unreleased\]/)
})

test('the current package version has a changelog section', () => {
  const text = changelog()
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm')
  assert.match(text, heading, `CHANGELOG.md must have a section for ${version}`)
})

test('every released version is listed newest first', () => {
  const versions = [...changelog().matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
  assert.ok(versions.length > 0, 'expected at least one released version')
  const sorted = [...versions].sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
  })
  assert.deepEqual(versions, sorted, 'released versions must be newest first')
})

test('the release-notes extractor produces a body for the current version', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['scripts/release-notes.mjs', version], { encoding: 'utf8' })
  assert.ok(out.trim().length > 0, 'release notes must not be empty')
  assert.match(out, /###|##/, 'release notes should contain section headings')
})

test('CHANGELOG.md is published with the package', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.ok(pkg.files.includes('CHANGELOG.md'), 'CHANGELOG.md must be in package.files')
})
