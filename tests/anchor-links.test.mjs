import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * In-page links break silently: the file still exists, so a link check passes, and the
 * reader lands nowhere. One such anchor (`#免费档如何判定客户端`) survived a heading rename
 * for weeks, which is why this exists.
 *
 * The anchor is computed the way GitHub renders a heading: drop the Markdown, lowercase,
 * keep letters, digits, hyphens and CJK, turn spaces into hyphens.
 */
const DOCS = [
  'README.md',
  'README.us.md',
  'TECHNICAL.md',
  'TECHNICAL.us.md',
  'CAMOUFLAGE.md',
  'CAMOUFLAGE.us.md',
  'docs/evidence/README.md',
]

function anchorOf(heading) {
  return heading
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/[*_]{1,3}/g, '') // emphasis
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // GitHub drops punctuation
    .trim()
    .replace(/\s+/g, '-')
}

function anchorsIn(file) {
  if (!fs.existsSync(file)) return null
  const found = new Set()
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    found.add(anchorOf(m[1].trim()))
  }
  return found
}

test('every in-page link points at a heading that exists', () => {
  const cache = new Map()
  const broken = []
  for (const doc of DOCS) {
    const text = fs.readFileSync(doc, 'utf8')
    for (const m of text.matchAll(/\]\(([^)\s]*#[^)\s]+)\)/g)) {
      const target = m[1]
      const [filePart, anchor] = target.split('#')
      const file = filePart === '' ? doc : path.join(path.dirname(doc), filePart)
      if (!cache.has(file)) cache.set(file, anchorsIn(file))
      const anchors = cache.get(file)
      if (anchors === null) continue // a missing file is another test's problem
      if (!anchors.has(decodeURIComponent(anchor))) {
        broken.push(`${doc} -> ${target}`)
      }
    }
  }
  assert.deepEqual(broken, [], `anchors must resolve to a heading: ${broken.join(', ')}`)
})
