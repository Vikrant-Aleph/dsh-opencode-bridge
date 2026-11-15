import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * The consulted-projects list lives in two places: the README section and the §13 table
 * of the technical document. Both languages. Four copies of one list drift apart unless
 * something checks them, and a missing credit is the kind of error nobody notices.
 */
const SOURCES = {
  'README.md': /## 参考与致谢([\s\S]*?)\n## /,
  'README.us.md': /## References and credits([\s\S]*?)\n## /,
  'TECHNICAL.md': /## 13\. 参考的社区项目([\s\S]*?)$/,
  'TECHNICAL.us.md': /## 13\. Community projects consulted([\s\S]*?)$/,
}

/** GitHub repositories mentioned in a fragment, lowercased and sorted. */
function reposIn(text) {
  const found = new Set()
  for (const m of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    found.add(m[1].replace(/\.git$/, '').toLowerCase())
  }
  // The GPL note repeats one project name; a set removes the duplicate.
  return [...found].sort()
}

function listOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  const match = SOURCES[file].exec(text)
  assert.ok(match, `${file} must contain its consulted-projects section`)
  return reposIn(match[1])
}

test('every document lists the consulted projects', () => {
  for (const file of Object.keys(SOURCES)) {
    const repos = listOf(file)
    assert.ok(repos.length > 0, `${file} lists no project`)
  }
})

test('the four copies of the list agree', () => {
  const [zhReadme, enReadme, zhTech, enTech] = Object.keys(SOURCES).map(listOf)
  assert.deepEqual(zhReadme, zhTech, 'README.md and TECHNICAL.md disagree')
  assert.deepEqual(enReadme, enTech, 'README.us.md and TECHNICAL.us.md disagree')
  assert.deepEqual(zhReadme, enReadme, 'the two languages disagree')
})

test('the GPL project is marked as read-only reference', () => {
  // opencode2api is GPL-3.0; the note is what keeps this project's MIT licensing honest.
  for (const file of ['README.md', 'README.us.md', 'TECHNICAL.md', 'TECHNICAL.us.md']) {
    const text = fs.readFileSync(file, 'utf8')
    const at = text.indexOf('opencode2api')
    assert.ok(at >= 0, `${file} must mention opencode2api`)
    const nearby = text.slice(at, at + 900)
    assert.match(nearby, /GPL-3\.0/, `${file} must state the licence of opencode2api`)
    assert.match(
      nearby,
      /没有(使用|复制)|未使用其代码|no code was used|uses none of its/,
      `${file} must state that no code was taken from opencode2api`,
    )
  }
})
