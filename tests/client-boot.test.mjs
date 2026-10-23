// Regression test for the DSH Desktop web-boot crash ("1 entry did not
// activate"). Loads client.js in a simulated browser module environment and
// exercises factory() + apply() against friendly AND hostile ctx shapes.
//
// The rule under test: apply() must NEVER throw, because the desktop treats a
// failed module activation as a fatal web-boot error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadFactory() {
  return loadFactoryWith(false)
}

function loadFactoryWith(nodes, selectedTab = 'logs') {
  let captured = null
  const errors = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          captured = spec
        },
      },
    },
    document: {
      createElement: () => ({ style: {}, textContent: '', select() {} }),
      head: { appendChild() {}, removeChild() {} },
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    navigator: {},
    console: {
      log: () => {},
      error: (...args) => errors.push(args.map(String).join(' ')),
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, '__ModuleLoader__.load must be called')
  assert.equal(captured.id, 'dsh-opencode-bridge')

  const fakeReact = {
    // `nodes: true` builds inspectable trees so a test can assert the markup
    // (tab roles/labels) instead of only that rendering does not throw.
    createElement: nodes
      ? (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
      : () => null,
    useState: (v) => [v === 'logs' ? selectedTab : typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
  }
  const mod = captured.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  return { mod, errors }
}

function assertNoThrow(mod, ctx, label) {
  assert.doesNotThrow(() => mod.apply(ctx), `apply() must never throw (${label})`)
}

test('factory exposes inject and a total apply', () => {
  const { mod } = loadFactory()
  assert.ok(Array.isArray(mod.inject))
  assert.equal(typeof mod.apply, 'function')
})

test('healthy ctx: locale registered before bind, settings section registered', () => {
  const { mod, errors } = loadFactory()
  const order = []
  const registrations = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    get: (name) => (name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined),
    locale: {
      register: (ns) => {
        order.push('register')
        return () => {}
      },
      bind: () => {
        order.push('bind')
        return (key) => key
      },
    },
    slots: {
      inject: (key, cb) => {
        order.push('inject:' + key)
        cb()
        return () => {}
      },
      register: (opts, component) => {
        registrations.push(opts)
        assert.equal(typeof component, 'function')
        return () => {}
      },
    },
  }
  assertNoThrow(mod, ctx, 'healthy')
  assert.deepEqual(order, ['register', 'bind', 'inject:settings.section'])
  assert.equal(registrations.length, 1, 'one settings page collects logs and proxies')
  assert.equal(registrations[0].id, 'opencode-bridge')
  assert.equal(typeof registrations[0].label, 'function')
  assert.ok(registrations[0].label().length > 0)
  assert.equal(errors.length, 0)
})

test('settings page renders browser-style tabs with one panel', () => {
  const { mod } = loadFactoryWith(true)
  const labels = {
    pageTitle: 'OpenCode Bridge',
    pageIntro: 'intro',
    tabLogs: '诊断日志',
    tabProxies: '出口代理轮换（可选）',
    tabContext: '上下文精简',
  }
  const t = (key) => labels[key] ?? key
  let component
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    get: () => undefined,
    locale: { register: () => () => {}, bind: () => t },
    slots: {
      inject: (key, cb) => { cb(); return () => {} },
      register: (_opts, next) => { component = next; return () => {} },
    },
  }
  mod.apply(ctx)
  assert.equal(typeof component, 'function')

  const tree = component({ t, rpc: null })
  const flat = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    flat.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)

  const tabs = flat.filter((n) => n.props && n.props.role === 'tab')
  assert.equal(tabs.length, 3, 'exactly three tabs')
  assert.deepEqual(tabs.map((n) => n.children.join('')), ['诊断日志', '出口代理轮换（可选）', '上下文精简'])
  assert.deepEqual(tabs.map((n) => n.props['aria-selected']), [true, false, false])
  assert.equal(tabs[0].props.className, 'ocf-tab is-active')
  assert.equal(tabs[1].props.className, 'ocf-tab')

  const strip = flat.find((n) => n.props && n.props.className === 'ocf-tabs')
  assert.ok(strip, 'tab strip uses the browser-tab container class')
  const panel = flat.find((n) => n.props && n.props.className === 'ocf-tabpanel')
  assert.ok(panel, 'one shared panel below the tabs')
  assert.equal(panel.props.role, 'tabpanel')
  assert.equal(panel.props['aria-labelledby'], 'ocf-tab-logs')
})

test('context tab exposes a default-off accessible switch with bounded safety explanations', () => {
  const { mod } = loadFactoryWith(true, 'context')
  let component
  mod.apply({ effect(fn) { fn(); return () => {} }, get() {}, locale: { register() {}, bind: () => key => key }, slots: { inject(_key, cb) { cb() }, register(_options, value) { component = value } } })
  const tree = component({ t: key => key, rpc: null })
  const nodes = []
  const walk = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children ?? []) walk(child) }
  walk(tree)
  assert.equal(nodes.find(node => node.props.role === 'tabpanel').props['aria-labelledby'], 'ocf-tab-context')
  const entry = nodes.find(node => typeof node.type === 'function' && node.type.name === 'ContextPanel')
  assert.ok(entry)
  nodes.length = 0
  walk(entry.type(entry.props))
  const toggle = nodes.find(node => node.props.role === 'switch')
  assert.equal(toggle.props['aria-checked'], false)
  assert.equal(toggle.props.disabled, true, 'cannot write before the service has loaded')
  assert.equal(toggle.props['aria-describedby'], 'ocf-context-help')
  const help = nodes.filter(node => node.type === 'li').map(node => node.children.join(''))
  assert.deepEqual(help, ['contextDefault', 'contextSafety', 'contextLocal', 'contextLimits'])
})

test('hostile ctx: every service missing — apply still succeeds', () => {
  const { mod, errors } = loadFactory()
  assertNoThrow(mod, {}, 'empty ctx')
  assertNoThrow(mod, { get: () => undefined }, 'get returns undefined')
  // label fallback must not throw even without locale
  const { mod: mod2 } = loadFactory()
  let label
  const ctx = {
    slots: {
      inject: (_k, cb) => {
        cb()
        return () => {}
      },
      register: (opts) => {
        label = opts.label
        return () => {}
      },
    },
  }
  assertNoThrow(mod2, ctx, 'slots without locale')
  // Without a locale service the fallback translator serves zh/en text.
  assert.equal(typeof label, 'function')
  assert.ok(label().length > 0)
})

test('hostile ctx: locale.bind throws — apply still succeeds and registers the page', () => {
  const { mod, errors } = loadFactory()
  let registered = false
  const ctx = {
    effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}),
    locale: {
      register: () => () => {},
      bind: () => {
        throw new Error('unknown namespace')
      },
    },
    slots: {
      inject: (_k, cb) => {
        cb()
        return () => {}
      },
      register: () => {
        registered = true
        return () => {}
      },
    },
  }
  assertNoThrow(mod, ctx, 'bind throws')
  assert.equal(registered, true, 'settings page must still register')
})

test('hostile ctx: locale.register throws — apply still succeeds', () => {
  const { mod } = loadFactory()
  let registered = false
  const ctx = {
    effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}),
    locale: {
      register: () => {
        throw new Error('duplicate namespace')
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_k, cb) => {
        cb()
        return () => {}
      },
      register: () => {
        registered = true
        return () => {}
      },
    },
  }
  assertNoThrow(mod, ctx, 'register throws')
  assert.equal(registered, true)
})

test('hostile ctx: slots.inject throws (slot not declared yet) — apply survives', () => {
  const { mod } = loadFactory()
  const ctx = {
    effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: () => {
        throw new Error('unknown slot settings.section')
      },
      register: () => () => {},
    },
  }
  assertNoThrow(mod, ctx, 'slots.inject throws')
})

test('hostile ctx: ctx.get throws — apply survives', () => {
  const { mod } = loadFactory()
  const ctx = {
    effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}),
    get: () => {
      throw new Error('service lookup failed')
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_k, cb) => {
        cb()
        return () => {}
      },
      register: () => () => {},
    },
  }
  assertNoThrow(mod, ctx, 'get throws')
})

test('hostile ctx: register props are forwarded and statics remain as fallback', () => {
  const { mod } = loadFactory()
  let opts
  const ctx = {
    effect: (fn) => (typeof fn() === 'function' ? fn() : () => {}),
    get: (name) => (name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: { lines: [] } }) } } : undefined),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_k, cb) => {
        cb()
        return () => {}
      },
      register: (o) => {
        opts = o
        return () => {}
      },
    },
  }
  assertNoThrow(mod, ctx, 'props forward')
  assert.equal(typeof opts.inject, 'function')
  const props = opts.inject()
  assert.equal(typeof props.t, 'function')
  assert.ok(props.rpc && typeof props.rpc.call === 'function')
})
