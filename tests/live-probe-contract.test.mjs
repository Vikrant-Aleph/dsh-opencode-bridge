import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const probes = ['smoke.mjs', 'tool-loop-live.mjs', 'proxy-live.mjs', 'vision-compat-live.mjs', 'reasoning-compat-live.mjs', 'reasoning-roundtrip-live.mjs', 'official-client-ab-live.mjs']

test('live probes require opt-in and use the current catalog constructor', () => {
  for (const name of probes) {
    const url = new URL(`tests/${name}`, root)
    const source = fs.readFileSync(url, 'utf8')
    assert.ok(source.includes("args.includes('--run')"), `${name}: require explicit quota-spending consent`)
    assert.ok(source.indexOf('process.exit(2)') < source.indexOf('new FreeModelCatalog'), `${name}: guard before network setup`)
    assert.doesNotMatch(source, /new FreeModelCatalog\(\s*(?:['"]https?:|base(?:Url)?\s*,)/, `${name}: no retired base URL argument`)
    assert.doesNotMatch(source, /userAgent:\s*'opencode\/1\.19\./, `${name}: use the protocol constant`)
    assert.equal(spawnSync(process.execPath, ['--check', fileURLToPath(url)], { stdio: 'inherit' }).status, 0, `${name}: syntax check`)
  }
})

test('the clear button reloads and displays the live egress state', () => {
  const client = fs.readFileSync(new URL('client.js', root), 'utf8')
  const start = client.indexOf('const clearCooldowns = useCallback')
  const end = client.indexOf('const testAll = useCallback', start)
  const clear = client.slice(start, end)
  const mutation = clear.indexOf("await call('clear-cooldowns', {})")
  const reload = clear.indexOf("await call('read', {})")
  const update = clear.indexOf('setEntries(Array.isArray(current.entries)')
  assert.ok(mutation >= 0 && reload > mutation && update > reload)
})

test('published A/B evidence records success and clearly scopes its synthetic requests', () => {
  const evidence = JSON.parse(fs.readFileSync(new URL('docs/evidence/official-client-comparison-2026-11-17.json', root), 'utf8'))
  assert.equal(evidence.official.version, '2.3.0')
  assert.equal(evidence.method.casesAreFullDshUiSessions, false)
  assert.equal(evidence.cases.length, 3)
  for (const entry of evidence.cases) {
    assert.equal(entry.officialAnswerMatches, true)
    assert.equal(entry.pluginAnswerMatches, true)
    assert.ok(entry.pluginBodyBytes > 0)
  }
  assert.equal(evidence.cases[2].pluginToolCount, 52)
  assert.equal(evidence.cases[2].systemPaddingBytes, 60000)
  assert.equal(evidence.cooldownRegression.storedWaitAfterClearMs, 0)
  assert.equal(evidence.cooldownRegression.nextFailureBeforeFix, 'REQUEST_COOLING')
})
