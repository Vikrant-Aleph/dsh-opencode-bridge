import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'

const root = new URL('../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')
function yaml(file) {
  const document = parseDocument(read(file), { uniqueKeys: true })
  assert.deepEqual(document.errors, [], `${file} must be valid YAML with unique keys`)
  return document.toJS()
}

test('bug form requires redacted logs and explains how to obtain them', () => {
  const form = yaml('.github/ISSUE_TEMPLATE/bug_report.yml')
  assert.equal(typeof form.name, 'string')
  assert.equal(typeof form.description, 'string')
  const fields = new Map(form.body.filter(field => field.id).map(field => [field.id, field]))
  assert.equal(fields.size, form.body.filter(field => field.id).length, 'field IDs must be unique')
  for (const id of ['dsh-version', 'plugin-version', 'system', 'reproduction', 'expected', 'actual']) {
    assert.equal(fields.get(id)?.validations?.required, true, `${id} must be required`)
  }
  const logs = fields.get('logs')
  assert.equal(logs.validations?.required, true)
  assert.doesNotMatch(logs.attributes.label, /optional|可选/i)
  assert.match(logs.attributes.description, /Settings → OpenCode Bridge → Diagnostic log/)
  assert.match(logs.attributes.description, /设置 → OpenCode Bridge → 诊断日志/)
  assert.match(logs.attributes.description, /Copy all/)
  assert.match(logs.attributes.description, /复制全部/)
  assert.match(logs.attributes.description, /\bwarn\b/)
  assert.match(logs.attributes.description, /\berror\b/)
  assert.equal(logs.attributes.render, 'text')
  assert.equal(fields.get('privacy').attributes.options[0].required, true)
  assert.match(fields.get('privacy').attributes.options[0].label, /API Key|API keys/)
  assert.equal(form.labels, undefined, 'do not depend on labels that may not exist in the repository')
})
test('feature form and issue chooser provide required structure and a privacy checklist', () => {
  const form = yaml('.github/ISSUE_TEMPLATE/feature_request.yml')
  for (const id of ['problem', 'solution']) assert.equal(form.body.find(field => field.id === id).validations.required, true)
  assert.equal(form.body.find(field => field.id === 'privacy').attributes.options[0].required, true)
  const config = yaml('.github/ISSUE_TEMPLATE/config.yml')
  assert.equal(config.blank_issues_enabled, false)
  assert.ok(config.contact_links.length)
  for (const link of config.contact_links) {
    const url = new URL(link.url)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.username + url.password, '')
  }
})
test('release workflow triggers only on pushed version tags and uses immutable Action refs', () => {
  const workflow = yaml('.github/workflows/release.yml')
  assert.deepEqual(Object.keys(workflow.on), ['push'])
  assert.deepEqual(workflow.on.push.tags, ['v*'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const allowed = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact', 'pnpm/action-setup'])
  let actions = 0
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0)
    for (const step of job.steps) {
      if (!step.uses) continue
      const [action, sha] = step.uses.split('@')
      assert.ok(allowed.has(action), `unexpected action ${action}`)
      assert.match(sha, /^[a-f0-9]{40}$/, 'pin Action refs to a full commit SHA')
      if (action === 'actions/checkout') assert.equal(step.with['persist-credentials'], false)
      actions++
    }
  }
  assert.ok(actions >= 5)
})
test('release build freezes dependencies, tests, validates the actual archive and checksums', () => {
  const workflow = yaml('.github/workflows/release.yml')
  const build = workflow.jobs.build
  const runs = build.steps.map(step => step.run ?? '').join('\n')
  assert.match(runs, /release-check\.mjs --tag/)
  assert.match(runs, /pnpm install --frozen-lockfile/)
  assert.match(runs, /pnpm build/)
  assert.match(runs, /pnpm test/)
  assert.match(runs, /pnpm pack --pack-destination/)
  assert.match(runs, /release-check\.mjs.*--archive-dir/)
  assert.match(runs, /release-checksum\.mjs.*--verify/)
  assert.doesNotMatch(runs, /tests\/(?:smoke|proxy-live)\.mjs|\b(?:npm|pnpm)\s+publish\b/)
  assert.notEqual(build.permissions?.contents, 'write')
})
test('publish job alone can write and refuses tag drift or overwriting an existing release', () => {
  const workflow = yaml('.github/workflows/release.yml')
  const publish = workflow.jobs.publish
  assert.equal(publish.needs, 'build')
  assert.deepEqual(publish.permissions, { contents: 'write' })
  const runs = publish.steps.map(step => step.run ?? '').join('\n')
  assert.match(runs, /commits\/refs\/tags\/\$RELEASE_TAG/)
  assert.match(runs, /Remote tag moved/)
  assert.match(runs, /Release already exists/)
  assert.match(runs, /gh release create/)
  assert.match(runs, /--verify-tag --generate-notes/)
  assert.match(runs, /--prerelease --latest=false/)
  assert.doesNotMatch(runs, /\b(?:npm|pnpm)\s+publish\b/)
  assert.equal(publish.steps.find(step => step.env?.GH_TOKEN)?.env.GH_TOKEN, '${{ github.token }}')
})
test('modern pnpm workspace settings and lockfile match the legacy project setting', () => {
  const workspace = yaml('pnpm-workspace.yaml')
  const lock = yaml('pnpm-lock.yaml')
  assert.deepEqual(workspace.packages, ['.'])
  assert.equal(workspace.autoInstallPeers, false)
  assert.equal(lock.settings.autoInstallPeers, workspace.autoInstallPeers)
  assert.match(read('.npmrc'), /^auto-install-peers=false\s*$/)
})
