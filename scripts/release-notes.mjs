import fs from 'node:fs'

/**
 * Extract the release notes for one version from CHANGELOG.md.
 *
 * The release workflow writes the result to a file and passes it to
 * `gh release create --notes-file`, so the published notes are exactly the
 * changelog section rather than GitHub's commit-derived summary.
 *
 * Usage: node scripts/release-notes.mjs <version> [--out <file>]
 */
const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('-') && !a.startsWith('--'))
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : null

function fail(message) {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}

if (!version) fail('usage: node scripts/release-notes.mjs <version> [--out <file>]')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`invalid version: ${version}`)

const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
const lines = changelog.split('\n')

// A heading looks like `## [1.0.0] - 2026-11-13` or `## [1.0.0]`.
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:\\s+-\\s+\\S+)?\\s*$`)
const start = lines.findIndex((line) => heading.test(line))
if (start < 0) fail(`CHANGELOG.md has no section for ${version}`)

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^## /.test(lines[i])) { end = i; break }
}

// Drop the trailing link-reference block, which belongs to the file, not a release.
let body = lines.slice(start + 1, end).join('\n').trimEnd()
body = body.replace(/\n*\[[^\]]+\]:\s+\S+\s*$/, '').trimEnd()

if (!body.trim()) fail(`the section for ${version} is empty`)

if (outFile) {
  fs.writeFileSync(outFile, `${body}\n`)
  console.log(`release-notes: wrote ${body.split('\n').length} lines for ${version} to ${outFile}`)
} else {
  process.stdout.write(`${body}\n`)
}
