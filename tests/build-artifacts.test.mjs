import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `tsc` never deletes output, so a removed module leaves a compiled copy behind
 * that would ship in the package. This guards against that drift.
 */
const SUFFIXES = ['.js', '.d.ts', '.js.map', '.d.ts.map']

function sources(dir) {
  return new Set(
    fs.readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => name.replace(/\.ts$/, '')),
  )
}

test('every compiled module has a source file', () => {
  const src = sources('src')
  const orphans = []
  for (const name of fs.readdirSync('lib')) {
    const suffix = SUFFIXES.find((s) => name.endsWith(s))
    if (!suffix) continue
    const base = name.slice(0, -suffix.length)
    if (!src.has(base)) orphans.push(`lib/${name}`)
  }
  assert.deepEqual(orphans, [], `orphaned build artifacts must be removed: ${orphans.join(', ')}`)
})

test('every source module is compiled', () => {
  const compiled = new Set(fs.readdirSync('lib').filter((n) => n.endsWith('.js')).map((n) => n.slice(0, -3)))
  const missing = [...sources('src')].filter((base) => !compiled.has(base))
  assert.deepEqual(missing, [], `these sources have no compiled output: ${missing.join(', ')}`)
})

test('the published file list exists', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  for (const entry of pkg.files) {
    if (entry.includes('*')) continue
    assert.ok(fs.existsSync(entry), `package.json "files" lists a missing path: ${entry}`)
  }
})

test('removed modules are not referenced anywhere in the published build', () => {
  const removed = ['official-harness', 'official-tools', 'tool-bridge', 'bridge-audit', 'harness-bridge']
  for (const name of fs.readdirSync('lib').filter((n) => n.endsWith('.js'))) {
    const text = fs.readFileSync(path.join('lib', name), 'utf8')
    for (const gone of removed) {
      assert.equal(text.includes(`./${gone}.js`), false, `lib/${name} still imports ./${gone}.js`)
    }
  }
})
