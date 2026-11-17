import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { splitRanges, accumulateDownloads, collectDownloads, renderChart, updateDownloads, ARTIFACTS } from '../scripts/update-downloads.mjs'

const packageName = 'dsh-opencode-bridge'
const rows = [
  { day: '2026-10-18', downloads: 3 },
  { day: '2026-10-19', downloads: 0 },
  { day: '2026-10-20', downloads: 7 },
]
function source() {
  const state = {
    metadata: { name: packageName, time: { created: '2026-10-18T11:38:47Z' } },
    latest: { package: packageName, start: '2026-10-20', end: '2026-10-20', downloads: 7 },
    range: { package: packageName, start: '2026-10-18', end: '2026-10-20', downloads: rows },
    calls: [],
  }
  state.fetch = async (url, init) => {
    state.calls.push(url)
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.headers.accept, 'application/json')
    if (state.error) throw state.error
    if (state.status) return new Response('{}', { status: state.status })
    const parsed = new URL(url)
    const body = parsed.hostname === 'registry.npmjs.org' ? state.metadata
      : parsed.pathname.includes('/point/last-day/') ? state.latest : state.range
    return new Response(JSON.stringify(body))
  }
  return state
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'download-chart-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: packageName }))
  return root
}

test('historical requests use disjoint inclusive ranges no longer than 365 days', () => {
  assert.deepEqual(splitRanges('2024-01-01', '2025-01-01'), [
    { start: '2024-01-01', end: '2024-12-30' },
    { start: '2024-12-31', end: '2025-01-01' },
  ])
  assert.deepEqual(splitRanges('2026-10-18', '2026-10-18'), [{ start: '2026-10-18', end: '2026-10-18' }])
  assert.throws(() => splitRanges('2026-02-30', '2026-03-01'), /Invalid UTC day/)
  assert.throws(() => splitRanges('2026-03-02', '2026-03-01'), /end before/)
})

test('daily counts become a cumulative series, including zero-download days', () => {
  const days = accumulateDownloads('2026-10-18', '2026-10-20', [...rows].reverse())
  assert.deepEqual(days.map(day => day.cumulative), [3, 3, 10])
  assert.deepEqual(rows.map(day => day.downloads), [3, 0, 7], 'do not mutate the API response')
})

for (const [label, invalid] of [
  ['missing day', rows.slice(1)],
  ['duplicate day', [rows[0], rows[0], rows[2]]],
  ['negative count', [rows[0], { day: '2026-10-19', downloads: -1 }, rows[2]]],
  ['fractional count', [rows[0], { day: '2026-10-19', downloads: 0.5 }, rows[2]]],
  ['unsafe total', rows.map(day => ({ ...day, downloads: Number.MAX_SAFE_INTEGER }))],
]) {
  test(`rejects ${label} rather than publishing an understated total`, () => {
    assert.throws(() => accumulateDownloads('2026-10-18', '2026-10-20', invalid))
  })
}

test('history starts at package creation and ends at the last available npm day', async () => {
  const api = source()
  const history = await collectDownloads(packageName, api.fetch)
  assert.equal(history.start, '2026-10-18')
  assert.equal(history.end, '2026-10-20')
  assert.equal(history.totalDownloads, 10)
  assert.equal(api.calls.length, 3)
  assert.ok(api.calls.includes('https://api.npmjs.org/downloads/range/2026-10-18:2026-10-20/dsh-opencode-bridge'))
})

test('collects and sums a multi-year history across API range boundaries', async () => {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    if (url.startsWith('https://registry.npmjs.org/')) {
      return Response.json({ name: packageName, time: { created: '2024-01-01T00:00:00Z' } })
    }
    if (url.includes('/point/')) {
      return Response.json({ package: packageName, start: '2025-01-01', end: '2025-01-01', downloads: 1 })
    }
    const [, start, end] = /\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\//.exec(url)
    const downloads = []
    for (let time = Date.parse(start); time <= Date.parse(end); time += 86_400_000) {
      downloads.push({ day: new Date(time).toISOString().slice(0, 10), downloads: 1 })
    }
    return Response.json({ package: packageName, start, end, downloads })
  }
  const history = await collectDownloads(packageName, fetchImpl)
  assert.equal(history.days.length, 367)
  assert.equal(history.totalDownloads, 367)
  assert.equal(requested.filter(url => url.includes('/range/')).length, 2)
})

test('rejects truncated API ranges', async () => {
  const api = source()
  api.range.start = '2026-10-19'
  await assert.rejects(collectDownloads(packageName, api.fetch), /truncated/)
})

test('rejects mixed package responses and inconsistent statistics', async () => {
  const api = source()
  api.latest.package = 'another-package'
  await assert.rejects(collectDownloads(packageName, api.fetch), /Unexpected package/)
  api.latest.package = packageName
  api.latest.downloads = 8
  await assert.rejects(collectDownloads(packageName, api.fetch), /disagree/)
})

test('generates both languages and writes nothing on an identical second run', async t => {
  const root = fixture(t), api = source()
  const first = await updateDownloads({ root, fetchImpl: api.fetch })
  assert.deepEqual(first.changed, ARTIFACTS)
  const json = JSON.parse(readFileSync(join(root, ARTIFACTS[0]), 'utf8'))
  assert.equal(json.totalDownloads, 10)
  assert.ok(!('fetchedAt' in json), 'a wall-clock timestamp must not create empty daily commits')
  assert.match(readFileSync(join(root, ARTIFACTS[1]), 'utf8'), /npm 累计下载量/)
  assert.match(readFileSync(join(root, ARTIFACTS[2]), 'utf8'), /Cumulative npm downloads/)
  assert.deepEqual((await updateDownloads({ root, fetchImpl: api.fetch })).changed, [])
})

test('network failure, HTTP errors and incomplete data preserve all existing artifacts', async t => {
  const root = fixture(t), api = source()
  await updateDownloads({ root, fetchImpl: api.fetch })
  const saved = ARTIFACTS.map(file => readFileSync(join(root, file)))
  for (const failure of ['network', 'http', 'incomplete']) {
    api.error = failure === 'network' ? new Error('offline') : undefined
    api.status = failure === 'http' ? 503 : undefined
    api.range.downloads = failure === 'incomplete' ? rows.slice(1) : rows
    await assert.rejects(updateDownloads({ root, fetchImpl: api.fetch }))
    for (const [index, file] of ARTIFACTS.entries()) assert.ok(readFileSync(join(root, file)).equals(saved[index]))
  }
})

test('charts handle one-day and all-zero histories without invalid SVG coordinates', () => {
  for (const value of [0, 1, 10000]) {
    const history = { package: packageName, start: '2026-10-18', end: '2026-10-18', totalDownloads: value, days: [{ day: '2026-10-18', downloads: value, cumulative: value }] }
    assert.doesNotMatch(renderChart(history), /NaN|Infinity/)
  }
})

test('SVG text is escaped and contains no scripts or remote image dependencies', () => {
  const history = { package: '<script>&"', start: '2026-10-18', end: '2026-10-20', totalDownloads: 10, days: accumulateDownloads('2026-10-18', '2026-10-20', rows) }
  const svg = renderChart(history)
  assert.match(svg, /&lt;script&gt;&amp;&quot;/)
  assert.doesNotMatch(svg, /<script|<image|foreignObject|onload=/i)
})

test('checked-in history and both generated charts agree', () => {
  const root = new URL('../', import.meta.url)
  const history = JSON.parse(readFileSync(new URL(ARTIFACTS[0], root), 'utf8'))
  assert.equal(history.package, packageName)
  assert.deepEqual(history.days, accumulateDownloads(history.start, history.end, history.days))
  assert.equal(history.totalDownloads, history.days.at(-1).cumulative)
  // Git may check out these fixtures with CRLF on Windows; the generator emits LF.
  assert.equal(readFileSync(new URL(ARTIFACTS[1], root), 'utf8').replaceAll('\r\n', '\n'), renderChart(history))
  assert.equal(readFileSync(new URL(ARTIFACTS[2], root), 'utf8').replaceAll('\r\n', '\n'), renderChart(history, 'en'))
  for (const [file, asset] of [['README.md', 'downloads.svg'], ['README.us.md', 'downloads.us.svg']]) {
    const readme = readFileSync(new URL(file, root), 'utf8')
    assert.ok(readme.includes(`https://raw.githubusercontent.com/Vikrant-Aleph/dsh-opencode-bridge/generated-data/npm-downloads/${asset}`))
  }
})

test('daily workflow uses pinned actions, no dependency installation and a narrow commit', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/downloads.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.schedule[0].cron, '27 2 * * *')
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'))
  assert.equal(workflow.on.push, undefined)
  assert.equal(workflow.on.pull_request, undefined)
  assert.equal(workflow.permissions.contents, 'read')
  assert.equal(workflow.concurrency.group, 'generated-data')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  const job = workflow.jobs.update
  assert.equal(job.permissions.contents, 'write')
  assert.equal(job.steps[0].with.ref, 'main', 'always generate with the maintained source scripts')
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /^actions\/[\w-]+@[a-f0-9]{40}$/)
  const commands = job.steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /node scripts\/update-downloads\.mjs/)
  assert.ok(commands.includes('remote_ref=refs/heads/generated-data'))
  assert.ok(commands.includes('add -- npm-downloads/history.json npm-downloads/downloads.svg npm-downloads/downloads.us.svg'))
  assert.ok(commands.includes('push origin "HEAD:$remote_ref"'))
  assert.doesNotMatch(commands, /npm install|pnpm install|--force|git add -A|git add \.|git pull|HEAD:main/)
})
