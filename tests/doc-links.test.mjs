import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Rule: every file a document cites must be published in this repository.
 * This checks every relative Markdown link, not just evidence citations, so a
 * reorganisation cannot leave a reader with a dead pointer.
 */
const DOCS = [
  'README.us.md',
  'README.md',
  'TECHNICAL.us.md',
  'TECHNICAL.md',
  'CAMOUFLAGE.us.md',
  'CAMOUFLAGE.md',
  'docs/evidence/README.md',
]

function localLinks(text) {
  const links = []
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^[a-z]+:/i.test(target)) continue // absolute URL or mailto
    if (target.startsWith('#')) continue // in-page anchor
    links.push(target.split('#')[0])
  }
  return links
}

test('every relative link in the published docs resolves', () => {
  const broken = []
  for (const doc of DOCS) {
    if (!fs.existsSync(doc)) continue
    const dir = path.dirname(doc)
    for (const target of localLinks(fs.readFileSync(doc, 'utf8'))) {
      if (!target) continue
      const resolved = path.resolve(dir, target)
      if (!fs.existsSync(resolved)) broken.push(`${doc} -> ${target}`)
    }
  }
  assert.deepEqual(broken, [], `published docs must not link to missing files: ${broken.join(', ')}`)
})

test('the docs never point at the ignored scratch directory', () => {
  const offenders = []
  for (const doc of DOCS) {
    if (!fs.existsSync(doc)) continue
    const text = fs.readFileSync(doc, 'utf8')
    for (const m of text.matchAll(/(?<![A-Za-z0-9_/-])research\/[A-Za-z0-9._-]+/g)) {
      offenders.push(`${doc} -> ${m[0]}`)
    }
  }
  assert.deepEqual(offenders, [], `docs must not cite the ignored scratch directory: ${offenders.join(', ')}`)
})

test('the docs do not describe withheld material', () => {
  // Rule: never mention an artefact that is not published, including where it lives.
  const phrasing = [
    /deliberately not published/i,
    /not published in this repo/i,
    /stays out of the repo/i,
    /withheld from/i,
    /刻意不发布/,
    /不随仓库发布/,
  ]
  const offenders = []
  for (const doc of DOCS) {
    if (!fs.existsSync(doc)) continue
    const text = fs.readFileSync(doc, 'utf8')
    for (const pattern of phrasing) {
      if (pattern.test(text)) offenders.push(`${doc} matches ${pattern}`)
    }
  }
  assert.deepEqual(offenders, [], `docs must not describe withheld material: ${offenders.join(', ')}`)
})
