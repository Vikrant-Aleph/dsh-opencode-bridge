import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const root = new URL('../', import.meta.url)
const json = file => JSON.parse(fs.readFileSync(new URL(file, root), 'utf8'))

test('all package display summaries include optional completed-turn context trimming', () => {
  const pkg = json('package.json'), en = json('locale/en.json').meta, zh = json('locale/zh.json').meta
  assert.equal(pkg.description, en.description)
  assert.match(en.description, /optional context trimming of completed-turn reasoning/)
  assert.match(zh.description, /可选的上下文精简（精简已完成轮次思考）/)
  assert.match(en.description, /tool bridge.*auditing\.$/)
  assert.match(zh.description, /工具桥.*兼容性审计。$/)
  assert.doesNotMatch(en.description, /image|vision/i)
  assert.doesNotMatch(zh.description, /图片|图像|视觉/)
})
test('real client dictionaries name the tab and pane Context trimming in both locales', () => {
  let spec, dictionaries
  const source = fs.readFileSync(new URL('client.js', root), 'utf8')
  const sandbox = { window: { __ModuleLoader__: { load(value) { spec = value } } }, console: { error() {} } }
  vm.runInNewContext(source, sandbox)
  const mod = spec.factory(name => { assert.equal(name, 'react'); return { createElement() {} } })
  mod.apply({ get() {}, locale: { register(_ns, value) { dictionaries = value }, bind() { return key => key } }, slots: { inject() {}, register() {} } })
  assert.equal(dictionaries.zh.tabContext, '上下文精简')
  assert.equal(dictionaries.zh.contextTitle, '上下文精简')
  assert.equal(dictionaries.en.tabContext, 'Context trimming')
  assert.equal(dictionaries.en.contextTitle, 'Context trimming')
  assert.match(dictionaries.zh.pageIntro, /可选的上下文精简/)
  assert.match(dictionaries.en.pageIntro, /optional context trimming/)
  assert.doesNotMatch(dictionaries.en.pageIntro, /image|vision/i)
  assert.doesNotMatch(dictionaries.zh.pageIntro, /图片|图像|视觉/)
})
test('visitor summaries mention context trimming and documented navigation uses the new name', () => {
  for (const file of ['README.md', 'TECHNICAL.md']) {
    const text = fs.readFileSync(new URL(file, root), 'utf8')
    assert.match(text.slice(0, text.indexOf('\n## ')), /optional context trimming/i)
    assert.doesNotMatch(text.slice(0, text.indexOf('\n## ')), /image|vision/i)
    if (file === 'README.md') assert.doesNotMatch(text.split('## Install and get started')[0], /Declared image input/i)
    assert.doesNotMatch(text, /OpenCode Bridge\s*→\s*Context(?! trimming)/)
  }
  for (const file of ['README.zh.md', 'TECHNICAL.zh.md']) {
    const text = fs.readFileSync(new URL(file, root), 'utf8')
    assert.match(text.slice(0, text.indexOf('\n## ')), /上下文精简/)
    assert.doesNotMatch(text.slice(0, text.indexOf('\n## ')), /图片|图像|视觉/)
    if (file === 'README.zh.md') assert.doesNotMatch(text.split('## 安装与开始使用')[0], /按模型能力输入图片/)
    assert.doesNotMatch(text, /OpenCode Bridge\s*→\s*上下文(?!精简)/)
  }
})
