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
const validEgress = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200

/** One observed server wait, with the egress it was observed on. */
export interface RequestWaitSnapshot {
  model: string
  until: number
  /** Redacted egress label the rejection came from; absent on recovered legacy rows. */
  egress?: string
}

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

/**
 * Persisted per-model server waits.
 *
 * A wait is recorded with the egress that produced it. When the caller passes the
 * currently configured egresses, a wait recorded on an egress that is no longer
 * configured stops applying — changing the proxy list must not strand a model for
 * the rest of the day.
 *
 * The file is re-read whenever it changes on disk, so clearing it externally (or
 * through {@link clear}) takes effect immediately instead of after a restart.
 */
export class RequestWaitStore {
  private waits = new Map<string, RequestWaitSnapshot>()
  private overflowUntil = 0
  private readonly file: string
  private signature = ''
  /** True only when the state file is absent, so a clear is never undone by recovery. */
  private recoverFromLogs = false

  constructor(
    file: string,
    private readonly logger: LoggerLike = noopLogger,
    legacyLines: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.resolve(file)
    const loaded = this.load()
    // Reconcile valid legacy observations even when a state file already exists:
    // an earlier standalone check may have created it before the live instance
    // records a newer rejection. Only maximum deadlines are adopted.
    const recovered = this.recoverFromLogs ? legacyRequestWaits(legacyLines, this.now()) : []
    for (const [model, until] of recovered) this.adopt(model, until)
    if (!loaded && recovered.length) this.persist()
    if (recovered.length) this.logger.info('retry', 'preserved observed model waits across upgrade', { models: recovered.length })
  }

  /**
   * Remaining wait for a model.
   *
   * `activeEgresses` is the set of egress labels currently configured. A wait whose
   * egress is no longer in that set is ignored, and rows recovered from logs (which
   * carry no egress) always apply. An overflow wait applies to every model, because
   * it exists precisely for the models that did not fit in the table.
   */
  remaining(model: string, activeEgresses?: readonly string[]): number {
    this.reloadIfChanged()
    const now = this.now()
    for (const [key, wait] of this.waits) if (wait.until <= now) this.waits.delete(key)
    const wait = this.waits.get(model)
    const applicable = wait && (!wait.egress || !activeEgresses || activeEgresses.includes(wait.egress))
    const until = Math.max(applicable ? wait!.until : 0, this.overflowUntil)
    return Math.max(0, Math.ceil(until - now))
  }

  /** The per-model wait that currently applies, for diagnostics and messages. */
  describe(model: string, activeEgresses?: readonly string[]): RequestWaitSnapshot | undefined {
    this.reloadIfChanged()
    const now = this.now()
    for (const [key, wait] of this.waits) if (wait.until <= now) this.waits.delete(key)
    const wait = this.waits.get(model)
    if (!wait) return undefined
    if (wait.egress && activeEgresses && !activeEgresses.includes(wait.egress)) return undefined
    return wait
  }

  remember(model: string, delay: number, egress?: string): void {
    if (!validModel(model) || !validDeadline(Math.ceil(delay))) return
    const until = Math.min(Number.MAX_SAFE_INTEGER, this.now() + Math.ceil(delay))
    this.adopt(model, until, validEgress(egress) ? egress : undefined)
    this.persist()
  }

  /** Drop every stored wait; returns how many were removed. */
  clear(): number {
    this.reloadIfChanged()
    const removed = this.waits.size + (this.overflowUntil > 0 ? 1 : 0)
    this.waits.clear()
    this.overflowUntil = 0
    this.persist()
    return removed
  }

  /** Current waits, oldest deadline first. */
  snapshot(): RequestWaitSnapshot[] {
    this.reloadIfChanged()
    const now = this.now()
    return [...this.waits.values()].filter((wait) => wait.until > now).sort((a, b) => a.until - b.until)
  }

  private adopt(model: string, until: number, egress?: string): void {
    const now = this.now()
    for (const [key, wait] of this.waits) if (wait.until <= now) this.waits.delete(key)
    if (until <= now) return
    if (this.waits.has(model) || this.waits.size < 256) {
      const previous = this.waits.get(model)
      this.waits.set(model, {
        model,
        until: Math.max(previous?.until ?? 0, until),
        // Keep the egress that produced the longest deadline.
        ...((until >= (previous?.until ?? 0) ? egress : previous?.egress) ? { egress: (until >= (previous?.until ?? 0) ? egress : previous?.egress)! } : {}),
      })
    } else this.overflowUntil = Math.max(this.overflowUntil, until)
  }

  /** Load the state file, replacing the in-memory copy. Returns false when absent. */
  private load(): boolean {
    this.signature = this.fileSignature()
    let exists = true
    try {
      if (fs.statSync(this.file).size > 100_000) throw new Error('Oversized state')
      // A byte-order mark is tolerated: Windows editors add one, and treating it as
      // corruption would resurrect cleared waits from the log.
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')
      const data = JSON.parse(raw)
      const rows = data?.waits
      if (data?.version !== 1 && data?.version !== 2) throw new Error('Invalid state')
      if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid state')
      if (!Number.isSafeInteger(data.overflowUntil) || data.overflowUntil < 0) throw new Error('Invalid state')
      const parsed: RequestWaitSnapshot[] = []
      for (const row of rows) {
        if (!Array.isArray(row) || (row.length !== 2 && row.length !== 3)) throw new Error('Invalid state')
        if (!validModel(row[0]) || !validDeadline(row[1])) throw new Error('Invalid state')
        if (row.length === 3 && !validEgress(row[2])) throw new Error('Invalid state')
        parsed.push({ model: row[0], until: row[1], ...(row.length === 3 ? { egress: row[2] } : {}) })
      }
      this.waits = new Map()
      this.overflowUntil = data.overflowUntil
      for (const wait of parsed) this.adopt(wait.model, wait.until, wait.egress)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
      else this.logger.warn('retry', 'request-wait state unreadable; ignoring it instead of recovering from logs')
      this.waits = new Map()
      this.overflowUntil = 0
      // Only a missing file justifies recovery: an existing but unreadable file is
      // evidence the user (or a corruption) changed it deliberately, and rebuilding
      // waits from the log would undo a clear.
      this.recoverFromLogs = !exists
      return false
    }
  }

  private fileSignature(): string {
    try {
      const stat = fs.statSync(this.file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'absent'
    }
  }

  /** Pick up an external edit (a manual clear, another instance) without a restart. */
  private reloadIfChanged(): void {
    if (this.fileSignature() === this.signature) return
    this.load()
  }

  private persist(): void {
    const dir = path.dirname(this.file)
    const temporary = path.join(dir, `.request-waits-${randomUUID()}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const waits = [...this.waits.values()].map((wait) => (wait.egress ? [wait.model, wait.until, wait.egress] : [wait.model, wait.until]))
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, waits, overflowUntil: this.overflowUntil }) + '\n', { flag: 'wx' })
      // Both paths are resolved in the single plugin-owned state directory.
      if (path.dirname(path.resolve(temporary)) !== dir || path.dirname(this.file) !== dir) throw new Error('Unexpected state target')
      fs.renameSync(temporary, this.file)
      this.signature = this.fileSignature()
    } catch {
      this.logger.warn('retry', 'could not persist request waits; active in-memory waits remain enforced')
      // Do not delete any computed path after a failed state write.
    }
  }
}
