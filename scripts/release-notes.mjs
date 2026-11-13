import fs from 'node:fs'

/**
 * Extract the release notes for one version, in both languages.
 *
 * The release workflow writes the result to a file and passes it to
 * `gh release create --notes-file`, so the published page is exactly the
 * changelog section instead of GitHub's commit-derived summary.
 *
 * Chinese comes from `CHANGELOG.md`, English from `CHANGELOG.us.md`.
 *
 * Usage: node scripts/release-notes.mjs <version> [--out <file>]
 */
const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('-'))
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? args[outIndex + 1] : null

function fail(message) {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}

if (!version) fail('usage: node scripts/release-notes.mjs <version> [--out <file>]')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`invalid version: ${version}`)

/** The section for one version, without the file-level link references. */
function section(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:\\s+-\\s+\\S+)?\\s*$`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) fail(`${file} has no section for ${version}`)

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break }
  }

  let body = lines.slice(start + 1, end).join('\n').trimEnd()
  body = body.replace(/\n*\[[^\]]+\]:\s+\S+\s*$/, '').trimEnd()
  if (!body.trim()) fail(`the ${version} section in ${file} is empty`)
  return body
}

const zh = section('CHANGELOG.md')
const en = section('CHANGELOG.us.md')

// Chinese first, then the English version in a collapsed block so the page stays
// scannable for readers of either language.
const notes = [
  zh,
  '',
  '---',
  '',
  '<details>',
  '<summary>English</summary>',
  '',
  en,
  '',
  '</details>',
  '',
].join('\n')

if (outFile) {
  fs.writeFileSync(outFile, notes)
  console.log(`release-notes: wrote ${notes.split('\n').length} lines for ${version} to ${outFile}`)
} else {
  process.stdout.write(notes)
}
