import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { ARTIFACTS } from '../scripts/update-downloads.mjs'

const workflow = parse(readFileSync(new URL('../.github/workflows/downloads.yml', import.meta.url), 'utf8'))
const publishStep = workflow.jobs.update.steps.find(step => step.name === 'Publish changed statistics to generated-data')
const publishedFiles = ['npm-downloads/history.json', 'npm-downloads/downloads.svg', 'npm-downloads/downloads.us.svg']
const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
// Use Git for Windows' Bash rather than the unrelated Windows/WSL bash.exe.
const bash = process.platform === 'win32' && gitAvailable
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash'
const bashAvailable = spawnSync(bash, ['--noprofile', '--norc', '-c', 'exit 0'], { stdio: 'ignore' }).status === 0
const options = { skip: !gitAvailable || !bashAvailable ? 'Git and Bash are required for local publication tests' : false }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'download-publish-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = join(root, 'remote.git'), source = join(root, 'source')
  const config = join(root, 'empty.gitconfig')
  writeFileSync(config, '')
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Test committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
  }
  const git = (args, cwd = source) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git(['init', '--bare', '--initial-branch=main', remote], root)
  git(['init', '--initial-branch=main', source], root)
  git(['config', 'core.autocrlf', 'false'])
  writeFileSync(join(source, 'package.json'), '{"name":"source-only"}\n')
  mkdirSync(join(source, 'assets'))
  for (const file of ARTIFACTS) writeFileSync(join(source, file), readFileSync(new URL(`../${file}`, import.meta.url)))
  git(['add', '--', 'package.json', ...ARTIFACTS])
  git(['commit', '-m', 'fixture: source code'])
  git(['remote', 'add', 'origin', remote])
  git(['push', 'origin', 'HEAD:main'])
  const remoteGit = args => git(['--git-dir', remote, ...args], root)
  const main = remoteGit(['rev-parse', 'main'])
  const publish = () => {
    const runnerTemp = mkdtempSync(join(root, 'runner temp '))
    return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', publishStep.run], {
      cwd: source, env: { ...env, RUNNER_TEMP: runnerTemp.replaceAll('\\', '/') },
      encoding: 'utf8', timeout: 30_000,
    })
  }
  const publishOK = () => {
    const result = publish()
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    return result
  }
  const assertMainUntouched = () => {
    assert.equal(git(['branch', '--show-current']), 'main')
    assert.equal(git(['rev-parse', 'HEAD']), main)
    assert.equal(remoteGit(['rev-parse', 'main']), main)
  }
  const writer = () => {
    const directory = join(root, 'other-writer')
    git(['clone', '--branch', 'generated-data', remote, directory], root)
    return { directory, git: args => git(args, directory) }
  }
  return { root, source, git, remoteGit, main, publish, publishOK, assertMainUntouched, writer }
}

test('first publication creates an orphan data branch with only the three generated files', options, t => {
  const f = fixture(t)
  f.publishOK()
  assert.deepEqual(f.remoteGit(['ls-tree', '-r', '--name-only', 'generated-data']).split('\n').sort(), [...publishedFiles].sort())
  assert.equal(f.remoteGit(['rev-list', '--count', 'generated-data']), '1')
  assert.equal(f.remoteGit(['show', '-s', '--format=%P', 'generated-data']), '', 'do not inherit source history')
  for (const [index, file] of publishedFiles.entries()) {
    assert.equal(f.remoteGit(['show', `generated-data:${file}`]), readFileSync(join(f.source, ARTIFACTS[index]), 'utf8').trim())
  }
  f.assertMainUntouched()
  assert.equal(f.git(['status', '--porcelain']), '')
})

test('identical statistics do not create another commit', options, t => {
  const f = fixture(t)
  f.publishOK()
  const before = f.remoteGit(['rev-parse', 'generated-data'])
  assert.match(f.publishOK().stdout, /Statistics unchanged/)
  assert.equal(f.remoteGit(['rev-parse', 'generated-data']), before)
  f.assertMainUntouched()
})

test('updates use the latest data branch and preserve other tasks and source changes', options, t => {
  const f = fixture(t)
  f.publishOK()
  const other = f.writer()
  mkdirSync(join(other.directory, 'other-metrics'))
  writeFileSync(join(other.directory, 'other-metrics/snapshot.json'), '{"keep":true}\n')
  writeFileSync(join(other.directory, 'npm-downloads/notes.txt'), 'Keep this too.\n')
  other.git(['add', '--', 'other-metrics/snapshot.json', 'npm-downloads/notes.txt'])
  other.git(['commit', '-m', 'data: other task'])
  other.git(['push', 'origin', 'HEAD:generated-data'])
  const previous = f.remoteGit(['rev-parse', 'generated-data'])
  writeFileSync(join(f.source, ARTIFACTS[1]), '<svg>Updated chart</svg>\n')
  writeFileSync(join(f.source, 'package.json'), '{"name":"uncommitted-source-change"}\n')
  writeFileSync(join(f.source, 'untracked.txt'), 'Do not publish this.\n')
  const sourceStatus = f.git(['status', '--porcelain'])
  f.publishOK()
  assert.equal(f.remoteGit(['show', '-s', '--format=%P', 'generated-data']), previous)
  assert.equal(f.remoteGit(['diff', '--name-only', previous, 'generated-data']), publishedFiles[1])
  assert.equal(f.remoteGit(['show', 'generated-data:other-metrics/snapshot.json']), '{"keep":true}')
  assert.equal(f.remoteGit(['show', 'generated-data:npm-downloads/notes.txt']), 'Keep this too.')
  assert.equal(f.git(['status', '--porcelain']), sourceStatus)
  f.assertMainUntouched()
})

test('remote errors fail rather than treating an inaccessible branch as a missing branch', options, t => {
  const f = fixture(t)
  f.git(['remote', 'set-url', 'origin', join(f.root, 'missing.git')])
  const result = f.publish()
  assert.notEqual(result.status, 0)
  assert.equal(f.git(['branch', '--list', 'generated-data']), '')
  assert.equal(f.remoteGit(['for-each-ref', '--format=%(refname)', 'refs/heads/generated-data']), '')
  f.assertMainUntouched()
})

test('an unexpected competing push is rejected without overwriting the other writer', options, t => {
  const f = fixture(t)
  f.publishOK()
  const other = f.writer()
  writeFileSync(join(other.directory, 'other-task.json'), '{"keep":"concurrent update"}\n')
  other.git(['add', '--', 'other-task.json'])
  other.git(['commit', '-m', 'data: concurrent task'])
  const competingCommit = other.git(['rev-parse', 'HEAD'])
  const hooks = join(f.root, 'hooks')
  mkdirSync(hooks)
  const quotedWriter = other.directory.replaceAll('\\', '/').replaceAll("'", "'\\''")
  // Hooks inherit worktree-specific Git variables; clear them before using another clone.
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\nunset $(git rev-parse --local-env-vars)\nexec git -C '${quotedWriter}' push origin HEAD:refs/heads/generated-data\n`)
  chmodSync(join(hooks, 'pre-push'), 0o755)
  f.git(['config', 'core.hooksPath', hooks])
  writeFileSync(join(f.source, ARTIFACTS[1]), '<svg>Concurrent chart update</svg>\n')
  const result = f.publish()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /rejected|failed to push/)
  assert.equal(f.remoteGit(['rev-parse', 'generated-data']), competingCommit)
  assert.equal(f.remoteGit(['show', 'generated-data:other-task.json']), '{"keep":"concurrent update"}')
  f.assertMainUntouched()
})
