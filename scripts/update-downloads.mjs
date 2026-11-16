import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY = 86_400_000
export const ARTIFACTS = ['assets/npm-downloads.json', 'assets/npm-downloads.svg', 'assets/npm-downloads.us.svg']
const API = 'https://api.npmjs.org/downloads'

function dayTime(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid UTC day: ${day}`)
  const time = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== day) throw new Error(`Invalid UTC day: ${day}`)
  return time
}
const dayOf = time => new Date(time).toISOString().slice(0, 10)
const countOf = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Download counts must be non-negative safe integers')
  return value
}

// Stay below the npm API's 18-month limit per non-bulk request. Boundaries are inclusive.
export function splitRanges(start, end) {
  const last = dayTime(end)
  const ranges = []
  for (let first = dayTime(start); first <= last;) {
    const through = Math.min(first + 364 * DAY, last)
    ranges.push({ start: dayOf(first), end: dayOf(through) })
    first = through + DAY
  }
  if (!ranges.length) throw new Error('The statistics end before the package was created')
  return ranges
}

export function accumulateDownloads(start, end, rows) {
  const first = dayTime(start), last = dayTime(end)
  if (last < first || !Array.isArray(rows) || rows.length !== (last - first) / DAY + 1) throw new Error('Incomplete download history')
  const sorted = [...rows].sort((a, b) => String(a?.day).localeCompare(String(b?.day)))
  let cumulative = 0
  return sorted.map((row, index) => {
    if (row?.day !== dayOf(first + index * DAY)) throw new Error('Download history has a missing, duplicate or out-of-range day')
    cumulative = countOf(cumulative + countOf(row.downloads))
    return { day: row.day, downloads: row.downloads, cumulative }
  })
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

export async function collectDownloads(packageName, fetchImpl = globalThis.fetch) {
  const encoded = encodeURIComponent(packageName)
  const [metadata, latest] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encoded}`, fetchImpl),
    fetchJson(`${API}/point/last-day/${encoded}`, fetchImpl),
  ])
  if (metadata.name !== packageName || latest.package !== packageName) throw new Error('Unexpected package in npm response')
  const created = metadata.time?.created
  if (typeof created !== 'string' || !Number.isFinite(Date.parse(created))) throw new Error('Missing package creation date')
  const start = created.slice(0, 10), end = latest.end
  dayTime(start); dayTime(end)
  if (latest.start !== end) throw new Error('Expected one complete statistics day')
  countOf(latest.downloads)
  const rows = []
  for (const range of splitRanges(start, end)) {
    const result = await fetchJson(`${API}/range/${range.start}:${range.end}/${encoded}`, fetchImpl)
    if (result.package !== packageName || result.start !== range.start || result.end !== range.end || !Array.isArray(result.downloads)) {
      throw new Error('npm returned a truncated or invalid download range')
    }
    // Validate every range before combining it; missing rows are never guessed to be zero.
    accumulateDownloads(range.start, range.end, result.downloads)
    rows.push(...result.downloads)
  }
  const days = accumulateDownloads(start, end, rows)
  if (days.at(-1).downloads !== latest.downloads) throw new Error('npm daily and range statistics disagree; retry after they settle')
  return {
    schemaVersion: 1,
    package: packageName,
    source: API,
    start,
    end,
    totalDownloads: days.at(-1).cumulative,
    days,
  }
}

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
const number = value => new Intl.NumberFormat('en-US').format(value)
const coordinate = value => Number(value.toFixed(2))

export function renderChart(history, language = 'zh') {
  const days = history.days
  if (!days?.length || history.totalDownloads !== days.at(-1).cumulative) throw new Error('Cannot draw an empty or inconsistent history')
  const en = language === 'en'
  const title = en ? 'Cumulative npm downloads' : 'npm 累计下载量'
  const totalLabel = en ? 'TOTAL DOWNLOADS' : '总下载量'
  const note = en ? 'Official npm statistics · updated daily · UTC' : 'npm 官方统计 · 每日更新 · UTC'
  const left = 80, right = 928, top = 116, bottom = 296
  const rawStep = Math.max(1, history.totalDownloads / 4)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = Math.max(1, [1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) * magnitude)
  const maximum = Math.max(step, Math.ceil(history.totalDownloads / step) * step)
  const x = index => days.length === 1 ? (left + right) / 2 : left + index / (days.length - 1) * (right - left)
  const y = value => bottom - value / maximum * (bottom - top)
  const points = days.map((day, index) => `${coordinate(x(index))} ${coordinate(y(day.cumulative))}`)
  const line = `M${points.join(' L')}`
  const area = `${line} L${coordinate(x(days.length - 1))} ${bottom} L${coordinate(x(0))} ${bottom} Z`
  const grid = []
  for (let value = 0; value <= maximum; value += step) {
    grid.push(`<line x1="${left}" y1="${coordinate(y(value))}" x2="${right}" y2="${coordinate(y(value))}" stroke="#e7edf5"/>`)
    grid.push(`<text x="${left - 14}" y="${coordinate(y(value) + 4)}" text-anchor="end" fill="#64748b" font-size="12">${number(value)}</text>`)
  }
  const tickCount = Math.min(6, days.length)
  const ticks = Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (days.length - 1) / (tickCount - 1)))
  const labels = ticks.map((index, position) => `<text x="${coordinate(x(index))}" y="322" text-anchor="${position === 0 ? 'start' : position === ticks.length - 1 ? 'end' : 'middle'}" fill="#64748b" font-size="12">${days[index].day}</text>`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="380" viewBox="0 0 960 380" role="img" aria-labelledby="chart-title chart-description">
  <title id="chart-title">${xml(title)} — ${xml(history.package)}</title>
  <desc id="chart-description">${xml(history.start)} → ${xml(history.end)}: ${number(history.totalDownloads)} ${xml(en ? 'total downloads' : '次累计下载')}.</desc>
  <defs><linearGradient id="download-area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#3b82f6" stop-opacity="0.22"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0.02"/></linearGradient></defs>
  <rect x="0.5" y="0.5" width="959" height="379" rx="16" fill="#ffffff" stroke="#dce5f0"/>
  <g font-family="system-ui, -apple-system, 'Segoe UI', 'Noto Sans CJK SC', sans-serif">
    <text x="32" y="43" fill="#0f172a" font-size="23" font-weight="650">${xml(title)}</text>
    <text x="32" y="70" fill="#64748b" font-size="14">${xml(history.package)}</text>
    <text x="928" y="48" text-anchor="end" fill="#2563eb" font-size="32" font-weight="700">${number(history.totalDownloads)}</text>
    <text x="928" y="72" text-anchor="end" fill="#64748b" font-size="12">${xml(totalLabel)}</text>
    ${grid.join('\n    ')}
    <path d="${area}" fill="url(#download-area)"/>
    <path d="${line}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${coordinate(x(days.length - 1))}" cy="${coordinate(y(history.totalDownloads))}" r="4.5" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>
    ${labels.join('\n    ')}
    <text x="32" y="356" fill="#64748b" font-size="12">${xml(note)}</text>
    <text x="928" y="356" text-anchor="end" fill="#64748b" font-size="12">${xml(history.start)} → ${xml(history.end)}</text>
  </g>
</svg>
`
}

export async function updateDownloads({ root = fileURLToPath(new URL('../', import.meta.url)), fetchImpl = globalThis.fetch } = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const history = await collectDownloads(pkg.name, fetchImpl)
  // Fetch and validate everything before replacing any published artifact.
  const contents = [JSON.stringify(history, null, 2) + '\n', renderChart(history), renderChart(history, 'en')]
  const changed = []
  for (const [index, relative] of ARTIFACTS.entries()) {
    const file = resolve(root, relative)
    const previous = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (previous === contents[index]) continue
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents[index], 'utf8')
    changed.push(relative)
  }
  return { history, changed }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { history, changed } = await updateDownloads()
    console.log(`${history.package}: ${number(history.totalDownloads)} downloads, ${history.start} through ${history.end} (UTC)`)
    console.log(changed.length ? `Updated: ${changed.join(', ')}` : 'Statistics unchanged; no files written.')
  } catch (error) {
    console.error(`Download chart update failed: ${error.message}`)
    process.exitCode = 1
  }
}
