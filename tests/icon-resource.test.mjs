import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const iconPath = pkg.exports['./icon']

test('the shared plugin icon is a packaged WebP within the DSH size limit', () => {
  assert.equal(iconPath, './icon.webp')
  assert.ok(pkg.icon === undefined || pkg.icon === iconPath, 'the manifest must not override the shared icon')
  assert.ok(pkg.files.includes(iconPath.slice(2)), 'the icon must ship in the package')
  const bytes = readFileSync(new URL(iconPath, root))
  assert.ok(bytes.length > 12 && bytes.length <= 256 * 1024)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'the RIFF size must match the file')
  assert.equal(existsSync(new URL('icon.svg', root)), false, 'remove the superseded icon')
})

test('both READMEs centre the original-size icon above the title', () => {
  const image = `https://raw.githubusercontent.com/Vikrant-Aleph/dsh-opencode-bridge/main/${iconPath.slice(2)}`
  for (const file of ['README.md', 'README.us.md']) {
    const text = readFileSync(new URL(file, root), 'utf8')
    const header = text.slice(0, text.indexOf('</h1>') + '</h1>'.length)
    assert.ok(header.startsWith('<p align="center">'), `${file}: give the icon its own centred block`)
    assert.ok(header.includes(`<img src="${image}" width="256" height="256"`), `${file}: show the icon at its original size`)
    assert.ok(header.endsWith('<h1 align="center">OpenCode Bridge</h1>'), `${file}: keep the centred title below the icon`)
    assert.ok(header.indexOf('</p>') < header.indexOf('<h1'), `${file}: the image must precede the title`)
    assert.equal(header.includes('<sub>'), false, `${file}: remove the former inline alignment`)
    assert.equal(text.includes('/main/icon.svg'), false, `${file}: remove the old image URL`)
  }
})
