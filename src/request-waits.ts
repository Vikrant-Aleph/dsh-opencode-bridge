import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { noopLogger, type LoggerLike } from './logger.js'

/** Only public model ids and absolute retry deadlines, never credentials or history. */
export function requestWaitScope(baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(baseUrl).update('\0').update(apiKey).digest('hex').slice(0, 24)
}
const validModel = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
const validDeadline = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Recover only observed HTTP 429 waits, never local EGRESS_COOLING guesses. */
export function legacyRequestWaits(lines: readonly string[], now: number): Array<[string, number]> {
  const out = new Map<string, number>()
  for (const line of lines.slice(-5000)) {
    const match = /^(\S+) \[[A-Z ]+\] \[adapter\] [^{]+ (\{.*\})$/.exec(line)
    if (!match) continue
    const ts = Date.parse(match[1]!)
    if (!Number.isFinite(ts) || ts > now) continue
    try {
      const row = JSON.parse(match[2]!) as Record<string, unknown>
      if (row.status !== 429 || !['RATE_LIMIT', 'FREE_USAGE_LIMIT'].includes(String(row.code)) || !validModel(row.model)) continue
      const delay = row.serverRetryAfterMs ?? row.retryAfterMs
      if (!validDeadline(delay)) continue
      const until = Math.min(Number.MAX_SAFE_INTEGER, ts + delay)
      if (until > now) out.set(row.model, Math.max(out.get(row.model) ?? 0, until))
    } catch { /* Truncated/invalid diagnostics cannot authorize a retry. */ }
  }
  return [...out]
}

export class RequestWaitStore {
  private readonly waits = new Map<string, number>()
  private overflowUntil = 0
  private readonly file: string
  constructor(
    file: string,
    private readonly logger: LoggerLike = noopLogger,
    legacyLines: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.resolve(file)
    let loaded = false
    try {
      if (fs.statSync(this.file).size > 100_000) throw new Error('Oversized state')
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (data?.version !== 1 || !Array.isArray(data.waits) || data.waits.length > 1000
        || !Number.isSafeInteger(data.overflowUntil) || data.overflowUntil < 0
        || data.waits.some((row: unknown) => !Array.isArray(row) || row.length !== 2 || !validModel(row[0]) || !validDeadline(row[1]))) throw new Error('Invalid state')
      this.overflowUntil = data.overflowUntil
      for (const [model, until] of data.waits as Array<[string, number]>) this.adopt(model, until)
      loaded = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('retry', 'request-wait state unavailable; recovering conservative observed waits')
    }
    // Reconcile valid legacy observations even when a state file already exists:
    // an earlier standalone check may have created it before the live instance
    // records a newer rejection. Only maximum deadlines are adopted.
    const recovered = legacyRequestWaits(legacyLines, this.now())
    for (const [model, until] of recovered) this.adopt(model, until)
    if (!loaded || recovered.length) this.persist()
    if (recovered.length) this.logger.info('retry', 'preserved observed model waits across upgrade', { models: recovered.length })
  }
  remaining(model: string): number {
    return Math.max(0, Math.ceil(Math.max(this.waits.get(model) ?? 0, this.overflowUntil) - this.now()))
  }
  remember(model: string, delay: number): void {
    if (!validModel(model) || !validDeadline(Math.ceil(delay))) return
    this.adopt(model, Math.min(Number.MAX_SAFE_INTEGER, this.now() + Math.ceil(delay)))
    this.persist()
  }
  private adopt(model: string, until: number): void {
    const now = this.now()
    for (const [key, end] of this.waits) if (end <= now) this.waits.delete(key)
    if (until <= now) return
    if (this.waits.has(model) || this.waits.size < 256) this.waits.set(model, Math.max(this.waits.get(model) ?? 0, until))
    else this.overflowUntil = Math.max(this.overflowUntil, until)
  }
  private persist(): void {
    const dir = path.dirname(this.file)
    const temporary = path.join(dir, `.request-waits-${randomUUID()}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, waits: [...this.waits], overflowUntil: this.overflowUntil }) + '\n', { flag: 'wx' })
      // Both paths are resolved in the single plugin-owned state directory.
      if (path.dirname(path.resolve(temporary)) !== dir || path.dirname(this.file) !== dir) throw new Error('Unexpected state target')
      fs.renameSync(temporary, this.file)
    } catch {
      this.logger.warn('retry', 'could not persist request waits; active in-memory waits remain enforced')
      // Do not delete any computed path after a failed state write.
    }
  }
}
