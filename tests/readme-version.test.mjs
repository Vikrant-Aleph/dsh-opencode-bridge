// Guards the chapter-0 rule: the install command and tarball example in both
// READMEs must carry exactly the current package.json version. A stale version
// is worse than a missing one, because users paste it verbatim.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (file) => readFileSync(new URL(file, root), 'utf8')
const version = JSON.parse(read('package.json')).version
const readmes = ['README.md', 'README.zh.md']

for (const file of readmes) {
  const text = read(file)

  test(`${file}: install command pins the current version`, () => {
    const found = [...text.matchAll(/dsh-opencode-bridge@([0-9]+\.[0-9]+\.[0-9]+[^\s`"']*)/g)].map((m) => m[1])
    assert.ok(found.length > 0, `${file} must show "dsh-opencode-bridge@${version}"`)
    for (const pinned of found) assert.equal(pinned, version, `${file} pins ${pinned}, package.json says ${version}`)
  })

  test(`${file}: local tarball example matches the current version`, () => {
    const found = [...text.matchAll(/dsh-opencode-bridge-([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s`"']*)?)\.tgz/g)].map((m) => m[1])
    assert.ok(found.length > 0, `${file} must show "dsh-opencode-bridge-${version}.tgz"`)
    for (const pinned of found) assert.equal(pinned, version, `${file} tarball says ${pinned}, package.json says ${version}`)
  })
}

test('the documentation policy states the rule', () => {
  for (const file of ['TECHNICAL.md', 'TECHNICAL.zh.md']) {
    const text = read(file)
    assert.match(text, /package\.json/, `${file} must tie the README versions to package.json`)
    assert.match(text, /readme-version\.test\.mjs/, `${file} must name the guard test`)
  }
})
