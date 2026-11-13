import fs from 'node:fs'
import path from 'node:path'

/**
 * Remove build output that no longer has a source file.
 *
 * `tsc` only writes files, never deletes them, so removing or renaming a module
 * leaves its compiled copy in `lib/` — which would then ship in the package. This
 * deletes exactly those orphans and nothing else.
 */
const SRC = 'src'
const OUT = 'lib'
const SUFFIXES = ['.js', '.d.ts', '.js.map', '.d.ts.map']

if (!fs.existsSync(OUT)) process.exit(0)

const sources = new Set(
  fs.readdirSync(SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => name.replace(/\.ts$/, '')),
)

const removed = []
for (const name of fs.readdirSync(OUT)) {
  const match = SUFFIXES.find((suffix) => name.endsWith(suffix))
  if (!match) continue
  const base = name.slice(0, -match.length)
  if (sources.has(base)) continue
  fs.rmSync(path.join(OUT, name), { force: true })
  removed.push(name)
}

if (removed.length > 0) {
  console.log(`clean: removed ${removed.length} orphaned build artifact(s)`)
  for (const name of removed) console.log(`  lib/${name}`)
} else {
  console.log('clean: no orphaned build artifacts')
}
