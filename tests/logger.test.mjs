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
