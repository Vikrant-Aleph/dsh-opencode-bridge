// Unit tests for the logging module: levels, redaction, rotation, read/stat/clear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginLogger } from '../lib/logger.js'
import { LogService } from '../lib/log-service.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-log-test-'))
}

function makeLogger(dir, extra = {}) {
  return new PluginLogger({
    level: 'debug',
    dir,
    maxBytes: 4096,
    maxFiles: 3,
    secrets: ['super-secret-key-123'],
    ...extra,
  })
}

test('level filtering: info suppresses debug', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir, { level: 'info' })
  logger.debug('t', 'hidden')
  logger.info('t', 'shown')
  const { lines } = logger.read()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /shown/)
})

test('redaction: secrets, bearer tokens and token-shaped literals', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir)
  logger.info('t', 'key is super-secret-key-123')
  logger.info('t', 'auth Bearer abcdefghijklmnop')
  logger.info('t', 'sk-abcdefghijklmnop1234')
  logger.info('t', 'data', { note: 'uses super-secret-key-123' })
  const { lines } = logger.read()
  for (const line of lines) {
    assert.ok(!line.includes('super-secret-key-123'), `leaked secret: ${line}`)
    assert.ok(!line.includes('abcdefghijklmnop'), `leaked token: ${line}`)
  }
  assert.ok(lines.some((l) => l.includes('[redacted]')))
})

test('redaction: long strings are truncated', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir)
  logger.info('t', 'x'.repeat(5000))
  const { lines } = logger.read()
  assert.match(lines[0], /\[truncated\]$/)
})

test('rotation: oldest file is deleted first when oversized', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir, { maxBytes: 2048, maxFiles: 3 })
  for (let i = 0; i < 200; i++) logger.info('t', `line ${i} ${'y'.repeat(80)}`)
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('dsh-opencode-bridge.log'))
  assert.ok(files.length <= 3, `expected <=3 files, got ${files.length}`)
  const stat = logger.stat()
  assert.ok(stat.totalBytes <= 3 * 2048, `total ${stat.totalBytes} exceeded bound`)
  // Newest lines survive, oldest are gone.
  const { lines } = logger.read({ limit: 5000 })
  assert.ok(lines.some((l) => l.includes('line 199 ')), 'newest line missing')
  assert.ok(!lines.some((l) => l.includes('line 0 ')), 'oldest line should be rotated away')
})

const LOG = 'dsh-opencode-bridge.log'
const DAY = 86_400_000
const fixtureLine = (ts, msg) => `${new Date(ts).toISOString()} [INFO ] [test] ${msg}\n`

function isolatedDir(t) {
  const dir = fs.realpathSync(tmpDir())
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('startup uses record age, not file mtime, and does not touch other files', t => {
  const dir = isolatedDir(t)
  const now = Date.UTC(2026, 10, 22)
  t.mock.method(Date, 'now', () => now)
  const old = fixtureLine(now - 7 * DAY - 1, 'expired')
  const boundary = fixtureLine(now - 7 * DAY, 'exactly seven days')
  const recent = fixtureLine(now - DAY, 'recent')
  fs.writeFileSync(path.join(dir, LOG), old + boundary + recent)
  fs.writeFileSync(path.join(dir, LOG + '.1'), old)
  fs.writeFileSync(path.join(dir, LOG + '.3'), recent)
  fs.writeFileSync(path.join(dir, LOG + '.notes'), old)
  const logger = makeLogger(dir, { level: 'off' })
  assert.equal(fs.readFileSync(path.join(dir, LOG), 'utf8'), boundary + recent)
  assert.deepEqual(fs.readdirSync(dir).sort(), [LOG, LOG + '.notes'])
  assert.deepEqual(logger.read().lines, [boundary.trimEnd(), recent.trimEnd()])
})

test('retention sweeps idle logs and read hides expired lines before the next sweep', t => {
  const dir = isolatedDir(t)
  let now = Date.UTC(2026, 10, 22)
  t.mock.method(Date, 'now', () => now)
  const file = path.join(dir, LOG)
  fs.writeFileSync(file, fixtureLine(now, 'will expire'))
  const logger = makeLogger(dir, { maxAgeDays: 1 })
  assert.equal(logger.read().lines.length, 1)
  now += DAY + 1
  assert.equal(logger.read().lines.length, 0)
  assert.ok(fs.existsSync(file))
  logger.prune()
  assert.ok(!fs.existsSync(file))
  assert.equal(logger.stat().totalBytes, 0)
})

test('age opt-out still shrinks oversized existing files to recent complete lines', t => {
  const dir = isolatedDir(t)
  const date = Date.UTC(2020, 0, 1)
  const older = fixtureLine(date, '早'.repeat(150))
  const last = fixtureLine(date + 1, '最新记录')
  for (const name of [LOG, LOG + '.1']) {
    fs.writeFileSync(path.join(dir, name), older + last)
  }
  const logger = makeLogger(dir, { maxBytes: 256, maxFiles: 2, maxAgeDays: 0 })
  assert.equal(fs.readFileSync(path.join(dir, LOG), 'utf8'), last)
  assert.equal(fs.readFileSync(path.join(dir, LOG + '.1'), 'utf8'), last)
  assert.deepEqual(logger.read().lines, [last.trimEnd(), last.trimEnd()])
})

test('one-file rotation never creates an archive or splits a UTF-8 record', t => {
  const dir = isolatedDir(t)
  const logger = makeLogger(dir, { maxBytes: 256, maxFiles: 1 })
  logger.info('test', 'older line')
  logger.info('test', `new line\n${'中文'.repeat(1200)}`)
  assert.deepEqual(fs.readdirSync(dir), [LOG])
  assert.ok(logger.stat().totalBytes <= 256)
  const { lines } = logger.read()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /new line\\n中文/)
  assert.match(lines[0], /\[truncated\]$/)
  assert.doesNotMatch(lines[0], /\uFFFD/)
})

test('rotation failure keeps the disk ceiling and falls back to memory', t => {
  const dir = isolatedDir(t)
  const logger = makeLogger(dir, { maxBytes: 256, maxFiles: 1 })
  logger.info('test', 'a'.repeat(200))
  const before = fs.readFileSync(path.join(dir, LOG), 'utf8')
  t.mock.method(fs, 'unlinkSync', () => { throw new Error('locked') })
  logger.error('test', `in memory ${'b'.repeat(200)}`)
  assert.equal(fs.readFileSync(path.join(dir, LOG), 'utf8'), before)
  assert.match(logger.read({ level: 'error' }).lines[0], /in memory/)
})

test('read: level filter and limit', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir)
  logger.debug('t', 'd1')
  logger.info('t', 'i1')
  logger.warn('t', 'w1')
  logger.error('t', 'e1')
  assert.equal(logger.read({ level: 'warn' }).lines.length, 2)
  assert.equal(logger.read({ limit: 2 }).lines.length, 2)
})

test('clear removes files and memory', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir)
  logger.info('t', 'hello')
  assert.ok(logger.read().lines.length > 0)
  const removed = logger.clear()
  assert.ok(removed >= 1)
  assert.equal(logger.read().lines.length, 0)
})

test('setLevel switches verbosity at runtime', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir, { level: 'error' })
  logger.info('t', 'suppressed')
  logger.setLevel('debug')
  logger.info('t', 'after')
  const { lines } = logger.read()
  assert.equal(lines.length, 1)
  assert.match(lines[0], /after/)
})

test('LogService read/stat/clear/level round-trip', () => {
  const dir = tmpDir()
  const logger = makeLogger(dir)
  const service = new LogService(logger)
  logger.info('t', 'hello world')
  const read = service.read('debug', 10)
  assert.ok(read.lines.some((l) => l.includes('hello world')))
  assert.equal(read.dir, dir)
  assert.ok(service.setLevel('warn').level === 'warn')
  const cleared = service.clear()
  assert.ok(cleared.removed >= 1)
})
