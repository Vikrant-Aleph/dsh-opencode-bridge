/**
 * Leveled file logger for dsh-opencode-bridge.
 *
 * Design constraints (see TECHNICAL.us.md "Logging & diagnostics"):
 *
 * - **No sensitive information ever reaches the log.** Call sites log
 *   metadata only (counts, sizes, ids, status codes, timings) — never message
 *   content, tool arguments, or credentials. On top of that, every string that
 *   passes through the logger is scrubbed: configured secrets (the API key),
 *   `Bearer <token>` values and token-shaped literals are replaced, and long
 *   strings are truncated.
 * - **Bounded disk usage.** One active file plus `maxFiles - 1` rotated
 *   siblings, each at most `maxBytes`. When the active file would overflow, the
 *   oldest rotated file is deleted first — logs are cleaned oldest-first and
 *   total log size is bounded by `maxBytes * maxFiles`. Age retention applies
 *   per record, including when old and new records share the same file.
 * - **Never throws.** Logging must not break model traffic; every fs operation
 *   is wrapped and failures fall back to an in-memory ring that the read API
 *   still serves.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 }

export type ActiveLevel = Exclude<LogLevel, 'off'>

/** Structural logger contract consumed by the catalog and the adapter. */
export interface LoggerLike {
  debug(scope: string, msg: string, data?: Record<string, unknown>): void
  info(scope: string, msg: string, data?: Record<string, unknown>): void
  warn(scope: string, msg: string, data?: Record<string, unknown>): void
  error(scope: string, msg: string, data?: Record<string, unknown>): void
  /** Optional level introspection avoids preparing successful-request diagnostics when disabled. */
  getLevel?(): LogLevel
}

/** A logger that discards everything; the default for standalone use. */
export const noopLogger: LoggerLike = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  getLevel: () => 'off',
}

export interface LogRecord {
  ts: string
  level: ActiveLevel
  scope: string
  msg: string
  data?: Record<string, unknown>
}

export interface LoggerOptions {
  /** Minimum level written to disk. `off` disables file output entirely. */
  level: LogLevel
  /** Directory holding `dsh-opencode-bridge.log` and its rotated siblings. */
  dir: string
  /** Size ceiling per file in bytes. */
  maxBytes: number
  /** Total files kept (active + rotated); the oldest is deleted on overflow. */
  maxFiles: number
  /** Maximum age in days; 0 disables age-based cleanup only. */
  maxAgeDays?: number
  /** Literal secret strings scrubbed from every logged string. */
  secrets?: string[]
  /**
   * Optional console mirror (e.g. `console.log`) receiving the same formatted
   * line. Useful because the DSH Host terminal shows console output; the file
   * remains the durable, viewable record.
   */
  mirror?: (line: string) => void
}

export interface LogStat {
  dir: string
  file: string
  level: LogLevel
  maxBytes: number
  maxFiles: number
  files: Array<{ name: string; bytes: number }>
  totalBytes: number
  recordCount: number
}

const MAX_STRING = 2000
const MEMORY_FALLBACK_LIMIT = 200
const DAY_MS = 86_400_000
export const DEFAULT_LOG_MAX_AGE_DAYS = 7
export const LOG_CLEANUP_INTERVAL_MS = 3_600_000

function isExpired(line: string, cutoff: number): boolean {
  if (cutoff === -Infinity || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.test(line)) return false
  return Date.parse(line.slice(0, 24)) < cutoff
}

/** Default log directory: profile logs dir when known, else `~/.dsh/logs`. */
export function defaultLogDir(): string {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh')
  return path.join(base, 'logs', 'dsh-opencode-bridge')
}

export class PluginLogger {
  private level: LogLevel
  private readonly dir: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly maxAgeMs: number
  private readonly secrets: string[]
  private readonly base: string
  private readonly mirror: ((line: string) => void) | undefined
  private memory: string[] = []

  constructor(options: LoggerOptions) {
    this.level = options.level
    this.dir = options.dir
    this.maxBytes = Number.isSafeInteger(options.maxBytes) ? Math.max(256, options.maxBytes) : 512 * 1024
    this.maxFiles = Number.isSafeInteger(options.maxFiles) ? Math.max(1, Math.min(50, options.maxFiles)) : 5
    const days = options.maxAgeDays ?? DEFAULT_LOG_MAX_AGE_DAYS
    this.maxAgeMs = (Number.isFinite(days) && days >= 0 ? days : DEFAULT_LOG_MAX_AGE_DAYS) * DAY_MS
    this.base = path.join(this.dir, 'dsh-opencode-bridge.log')
    this.secrets = (options.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 4 && s !== 'public')
    this.mirror = options.mirror
    this.prune()
  }

  /** Runtime level change (UI-driven); persisted only through config. */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  debug(scope: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('debug', scope, msg, data)
  }

  info(scope: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('info', scope, msg, data)
  }

  warn(scope: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', scope, msg, data)
  }

  error(scope: string, msg: string, data?: Record<string, unknown>): void {
    this.emit('error', scope, msg, data)
  }

  /** Formatted single line, used for both the file and the memory fallback. */
  format(record: LogRecord): string {
    const data = record.data && Object.keys(record.data).length ? ` ${this.redact(JSON.stringify(record.data))}` : ''
    const line = `${record.ts} [${record.level.toUpperCase().padEnd(5)}] [${this.redact(record.scope)}] ${this.redact(record.msg)}${data}`
    return line.replace(/[\r\n]/g, char => char === '\r' ? '\\r' : '\\n')
  }

  /**
   * Scrub sensitive material from any string: configured secrets, bearer
   * tokens, token-shaped literals; then cap the length.
   */
  redact(input: string): string {
    let out = input
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]')
    out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    out = out.replace(/\b(sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out
  }

  /** Newest-last records, filtered by minimum level, capped to `limit`. */
  read(options: { level?: LogLevel; limit?: number } = {}): { lines: string[]; truncated: boolean } {
    const min = RANK[options.level ?? 'debug']
    const cutoff = this.cutoff()
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500))
    const lines: string[] = []
    // Chronological order: oldest rotated file first, active file last.
    for (let i = this.maxFiles - 1; i >= 0; i--) {
      const file = i === 0 ? this.base : `${this.base}.${i}`
      for (const raw of this.readLines(file)) {
        if (!isExpired(raw, cutoff) && this.rankOf(raw) >= min) lines.push(raw)
      }
    }
    if (!lines.length && this.memory.length) {
      for (const raw of this.memory) if (!isExpired(raw, cutoff) && this.rankOf(raw) >= min) lines.push(raw)
    }
    const truncated = lines.length > limit
    return { lines: truncated ? lines.slice(-limit) : lines, truncated }
  }

  /** Files on disk with sizes, plus current level and record count. */
  stat(): LogStat {
    const files: Array<{ name: string; bytes: number }> = []
    for (let i = 0; i < this.maxFiles; i++) {
      const name = i === 0 ? path.basename(this.base) : `${path.basename(this.base)}.${i}`
      const full = i === 0 ? this.base : `${this.base}.${i}`
      const bytes = this.sizeOf(full)
      if (bytes > 0) files.push({ name, bytes })
    }
    return {
      dir: this.dir,
      file: this.base,
      level: this.level,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      recordCount: this.read({ limit: 5000 }).lines.length,
    }
  }

  /** Delete every log file; returns how many were removed. */
  clear(): number {
    let removed = 0
    for (let i = 0; i < this.maxFiles; i++) {
      const full = i === 0 ? this.base : `${this.base}.${i}`
      try {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {
        // Best effort; the next append recreates what it needs.
      }
    }
    this.memory = []
    return removed
  }

  // -- internals ------------------------------------------------------------

  private emit(level: ActiveLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
    if (RANK[level] < RANK[this.level]) return
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(data && Object.keys(data).length ? { data: this.scrubData(data) } : {}),
    }
    const formatted = this.format(record)
    const suffix = '…[truncated]'
    const line = Buffer.byteLength(formatted) < this.maxBytes ? formatted
      : new TextDecoder().decode(Buffer.from(formatted).subarray(0, this.maxBytes - Buffer.byteLength(suffix) - 1), { stream: true }) + suffix
    if (!this.appendLine(line)) {
      this.memory.push(line)
      if (this.memory.length > MEMORY_FALLBACK_LIMIT) this.memory.shift()
    }
    try {
      this.mirror?.(line)
    } catch {
      // Mirroring must never break logging.
    }
  }

  /** Redact every string inside a data record and cap nesting by serialization. */
  private scrubData(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue
      if (typeof value === 'string') out[key] = this.redact(value)
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
      else if (Array.isArray(value)) out[key] = this.redact(JSON.stringify(value))
      else out[key] = this.redact(JSON.stringify(value))
    }
    return out
  }

  private appendLine(line: string): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const bytes = Buffer.byteLength(line) + 1
      if ((this.fileSize(this.base) ?? 0) + bytes > this.maxBytes) this.rotate()
      fs.appendFileSync(this.base, `${line}\n`, 'utf8')
      return true
    } catch {
      // Do not append to an oversized file if rotation failed.
      return false
    }
  }

  private rotate(): void {
    if (this.maxFiles === 1) {
      fs.unlinkSync(this.base)
      return
    }
    const oldest = `${this.base}.${this.maxFiles - 1}`
    if (this.fileSize(oldest) !== undefined) fs.unlinkSync(oldest)
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      const from = `${this.base}.${i}`
      if (this.fileSize(from) !== undefined) fs.renameSync(from, `${this.base}.${i + 1}`)
    }
    fs.renameSync(this.base, `${this.base}.1`)
  }

  /** Clean up files from a previous run, or sweep again while the plugin is idle. */
  prune(): void {
    const cutoff = this.cutoff()
    this.memory = this.memory.filter(line => !isExpired(line, cutoff))
    for (let i = 0; i <= 50; i++) {
      const file = i === 0 ? this.base : `${this.base}.${i}`
      try {
        const stat = this.fileStat(file)
        if (!stat) continue
        const { size } = stat
        if (i >= this.maxFiles) {
          fs.unlinkSync(file)
        } else if (size > this.maxBytes || (size > 0 && cutoff !== -Infinity)) {
          const lines = this.readTail(file, size)
          const kept = lines.filter(line => !isExpired(line, cutoff))
          if (kept.length === 0) {
            if (this.unchanged(file, stat)) fs.unlinkSync(file)
          } else if (size > this.maxBytes || kept.length !== lines.length) {
            this.replace(file, stat, kept.join('\n') + '\n')
          }
        }
      } catch {
        // One unavailable file should not stop cleanup of the others.
      }
    }
  }

  private cutoff(): number {
    return this.maxAgeMs === 0 ? -Infinity : Date.now() - this.maxAgeMs
  }

  private readTail(file: string, size: number): string[] {
    const start = Math.max(0, size - this.maxBytes)
    // Keep one extra byte to tell whether the retained tail starts on a line boundary.
    const offset = Math.max(0, start - 1)
    const buffer = Buffer.alloc(size - offset)
    const fd = fs.openSync(file, 'r')
    try {
      let read = 0
      while (read < buffer.length) {
        const count = fs.readSync(fd, buffer, read, buffer.length - read, offset + read)
        if (count === 0) break
        read += count
      }
      if (read !== buffer.length) throw new Error('Log size changed during read')
    } finally {
      fs.closeSync(fd)
    }
    const first = start === 0 ? 0 : buffer.indexOf(10) + 1
    if (start > 0 && first === 0) return []
    const end = buffer.lastIndexOf(10) + 1
    return buffer.toString('utf8', first, end).split('\n').filter(Boolean)
  }

  private readLines(file: string): string[] {
    try {
      const size = this.fileSize(file)
      return size ? this.readTail(file, size) : []
    } catch {
      return []
    }
  }

  private fileStat(file: string): fs.Stats | undefined {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error('Not a regular log file')
    return stat
  }

  private fileSize(file: string): number | undefined {
    return this.fileStat(file)?.size
  }

  private unchanged(file: string, before: fs.Stats): boolean {
    const after = this.fileStat(file)
    return !!after && after.ino === before.ino && after.dev === before.dev
      && after.size === before.size && after.mtimeMs === before.mtimeMs
  }

  private replace(file: string, before: fs.Stats, text: string): void {
    const temp = `${file}.${randomUUID()}.tmp`
    // Avoid truncating the live file if the replacement write or rename fails.
    const fd = fs.openSync(temp, 'wx', before.mode & 0o777)
    try {
      try { fs.writeFileSync(fd, text, 'utf8') } finally { fs.closeSync(fd) }
      if (this.unchanged(file, before)) fs.renameSync(temp, file)
    } finally {
      try { fs.unlinkSync(temp) } catch { /* already renamed or unavailable */ }
    }
  }

  private sizeOf(file: string): number {
    try {
      return this.fileSize(file) ?? 0
    } catch {
      return 0
    }
  }

  /** Extract the level from a formatted line so filtering works on disk lines. */
  private rankOf(line: string): number {
    const match = /\[(DEBUG|INFO |WARN |ERROR)\]/.exec(line)
    if (!match) return RANK.debug
    const key = match[1].trim().toLowerCase() as ActiveLevel
    return RANK[key] ?? RANK.debug
  }
}

/** Console-backed logger for tests and standalone use. */
export function consoleLogger(level: LogLevel = 'debug'): PluginLogger {
  return new PluginLogger({
    level,
    dir: path.join(os.tmpdir(), 'dsh-opencode-bridge-console'),
    maxBytes: 64 * 1024,
    maxFiles: 1,
  })
}
