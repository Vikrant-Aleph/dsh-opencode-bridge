import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The docs cite evidence files by path. Publishing a doc that points at a file the
 * repository does not contain is worse than not citing it at all, so every reference
 * must resolve inside the repository.
 */
const DOCS = ['README.md', 'README.zh.md', 'TECHNICAL.md', 'TECHNICAL.zh.md', 'CAMOUFLAGE.md', 'CAMOUFLAGE.zh.md']

function evidenceRefs(text) {
  return [...text.matchAll(/docs\/evidence\/[A-Za-z0-9._-]+/g)].map((m) => m[0])
}

test('every cited evidence file exists in the repository', () => {
  const missing = []
  for (const doc of DOCS) {
    for (const ref of evidenceRefs(fs.readFileSync(doc, 'utf8'))) {
      if (!fs.existsSync(ref)) missing.push(`${doc} -> ${ref}`)
    }
  }
  assert.deepEqual(missing, [], `cited evidence must exist: ${missing.join(', ')}`)
})

test('the docs do not cite the unpublished working directory', () => {
  const offenders = []
  for (const doc of DOCS) {
    const text = fs.readFileSync(doc, 'utf8')
    // `research/` is git-ignored scratch; a public reader would find nothing there.
    for (const m of text.matchAll(/(?<![A-Za-z0-9_/-])research\/[A-Za-z0-9._-]+/g)) {
      offenders.push(`${doc} -> ${m[0]}`)
    }
  }
  assert.deepEqual(offenders, [], `docs must not cite the ignored scratch directory: ${offenders.join(', ')}`)
})

test('the evidence directory explains itself', () => {
  assert.ok(fs.existsSync('docs/evidence/README.md'), 'docs/evidence must have a README')
  const text = fs.readFileSync('docs/evidence/README.md', 'utf8')
  assert.match(text, /dated observations/i,
    'the evidence README must say the captures are dated observations')
})

test('no upstream source copies are published', () => {
  // Redistributing upstream source is not this project's right.
  const banned = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (full.includes('evidence') && /\.(ts|tsx)$/.test(entry.name)) banned.push(full)
    }
  }
  if (fs.existsSync('docs')) walk('docs')
  assert.deepEqual(banned, [], `upstream source must not be published: ${banned.join(', ')}`)
})

test('every published evidence file is small and JSON', () => {
  const files = fs.readdirSync('docs/evidence').filter((n) => n !== 'README.md')
  assert.ok(files.length > 0, 'evidence directory should not be empty')
  for (const name of files) {
    assert.match(name, /\.json$/, `unexpected file in evidence: ${name}`)
    const size = fs.statSync(path.join('docs/evidence', name)).size
    assert.ok(size < 100_000, `${name} is larger than expected for a capture (${size} bytes)`)
  }
})
