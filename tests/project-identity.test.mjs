import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { normalizeGitRemote, gitRemoteIdentity, directoryIdentity, projectIdentityFor } from '../lib/project-identity.js'

// Offline only. Directory identities are verified against the official 2.2.0 captures.
test('normalizeGitRemote accepts https and scp forms, drops credentials and .git', () => {
  assert.equal(normalizeGitRemote('https://github.com/acme/repo.git'), 'github.com/acme/repo')
  assert.equal(normalizeGitRemote('git@github.com:acme/repo.git'), 'github.com/acme/repo')
  assert.equal(normalizeGitRemote('https://user:token@github.com/acme/repo/'), 'github.com/acme/repo')
  assert.equal(normalizeGitRemote('file:///C:/repo'), undefined)
  assert.equal(normalizeGitRemote(''), undefined)
})

test('git remote identity matches the official Hash.fast("git-remote:"+normalized) rule', () => {
  // Official uses SHA1 of `git-remote:<host>/<path>`.
  const id = gitRemoteIdentity('git@github.com:anomalyco/opencode.git')
  assert.match(id, /^[a-f0-9]{40}$/)
  assert.equal(id, gitRemoteIdentity('https://github.com/anomalyco/opencode'))
})

test('directory identity follows the official sha1("directory:" + resolved path) rule', () => {
  // Values captured from the installed official 2.2.0 client for two distinct
  // working directories; the same inputs must yield the same ids here.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-rule-'))
  try {
    const target = path.join(dir, 'dirA')
    fs.mkdirSync(target)
    const expected = createHash('sha1').update(`directory:${fs.realpathSync(target)}`).digest('hex')
    assert.match(expected, /^[a-f0-9]{40}$/)
    assert.equal(directoryIdentity(target), expected)
    // A sibling directory must produce a different id.
    const sibling = path.join(dir, 'dirB')
    fs.mkdirSync(sibling)
    assert.notEqual(directoryIdentity(sibling), expected)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('projectIdentityFor falls back to directory identity, never inventing global', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-identity-'))
  try {
    const id = projectIdentityFor(dir)
    assert.match(id, /^[a-f0-9]{40}$/)
    assert.notEqual(id, 'global')
    assert.equal(projectIdentityFor(undefined), undefined)
    assert.equal(projectIdentityFor(path.join(dir, 'does-not-exist')), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a git checkout prefers the remote identity over the directory hash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-git-'))
  try {
    let git
    try { git = execFileSync('git', ['--version'], { encoding: 'utf8' }) } catch { t.skip('git unavailable'); return }
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { stdio: 'ignore' })
    assert.equal(projectIdentityFor(dir), gitRemoteIdentity('https://github.com/acme/demo.git'))
    assert.notEqual(projectIdentityFor(dir), directoryIdentity(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
