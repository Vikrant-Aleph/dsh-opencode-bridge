// Client half of dsh-opencode-bridge: a Settings page that views and copies the
// plugin diagnostic log. Registers into the `settings.section` slot and talks
// to the Host half over the package's `/api/opencode-bridge-logs/*` RPC routes.
//
// Robustness rules — the desktop treats a failed module activation as a fatal
// web-boot error ("web boot: 1 entry did not activate"), so:
//   1. `apply()` must NEVER throw: every step has its own try/catch.
//   2. Every service access is optional-chained with a working fallback —
//      activation order is not guaranteed (e.g. the settings slot may not be
//      declared yet) and `locale.bind()` on an unregistered namespace can throw.
//   3. A locale namespace is registered before it is bound.
window.__ModuleLoader__.load({
  // Must equal the package name (the browser artifact's registered id).
  id: 'dsh-opencode-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'settings.opencodeFree';
    const LEVELS = ['debug', 'info', 'warn', 'error'];
    const RPC_CHANNEL = '/api';
    const RPC_NAMESPACE = 'opencode-bridge-logs';
    const PROXY_RPC_NAMESPACE = 'opencode-bridge-proxies';

    const en = {
      nav: 'OpenCode Bridge',
      pageTitle: 'OpenCode Bridge',
      pageIntro: 'Settings for the OpenCode free-model bridge: diagnostics and egress rotation.',
      tabLogs: 'Diagnostic log',
      tabProxies: 'Egress rotation (optional)',
      title: 'OpenCode Bridge — Diagnostic Log',
      intro: 'Adapter log for the OpenCode free-model bridge. Lines are scrubbed of credentials and message content before they are written.',
      level: 'Minimum level',
      refresh: 'Refresh',
      copy: 'Copy all',
      copied: 'Copied!',
      copyFailed: 'Copy failed — select the text and copy manually.',
      clear: 'Clear logs',
      loading: 'Loading…',
      empty: 'No log entries yet. Use the model once and refresh.',
      unavailable: 'Log service unreachable.',
      truncatedNote: 'Showing the newest lines only.',
      dir: 'Directory',
      total: 'Total size',
      clearConfirm: 'Delete all log files?',
      copyAccessible: 'Copy the whole log to the clipboard',
      proxyNav: 'OpenCode Bridge — Proxies',
      proxyTitle: 'Egress rotation',
      proxyIntro: 'The free tier throttles each egress IP. When one is rate-limited it cools down and the next entry is used. Keep “direct” to use this machine\u2019s IP.',
      proxyAddLabel: 'Add a proxy',
      proxyPlaceholder: 'http://host:port / socks5h://host:port / direct',
      proxyAdd: 'Add',
      proxyRemove: 'Remove',
      proxyTest: 'Test all',
      proxyTesting: 'Testing…',
      proxyRefresh: 'Refresh',
      proxyReady: 'ready',
      proxyCooling: 'cooling',
      proxyFailures: 'failures',
      proxyEmpty: 'The pool is empty.',
      proxyHint: 'Supports HTTP(S), SOCKS4/4a and SOCKS5/5h. For example: socks5h://127.0.0.1:1080. Bare host:port uses HTTP.',
      proxyDirect: 'direct (this machine)',
      proxySaved: 'Saved and applied to the live pool.',
      proxySaveFailed: 'Saved locally, but the pool could not be written to disk.',
      proxyReachable: 'reachable',
      proxyTestingDone: 'Probe finished.',
      proxyRemoveFailed: 'Could not remove that entry.',
      proxyAddFailed: 'Could not add that proxy.',
      proxyTestFailed: 'Test failed.',
      proxyOffline: 'Proxy service unreachable.',
    };
    const zh = {
      nav: 'OpenCode Bridge',
      pageTitle: 'OpenCode Bridge',
      pageIntro: 'OpenCode 免费模型桥接插件的设置：诊断日志与出口代理。',
      tabLogs: '诊断日志',
      tabProxies: '出口代理轮换（可选）',
      title: 'OpenCode Bridge — 诊断日志',
      intro: 'OpenCode 免费模型桥接适配器的日志。每行在写入前已脱敏：不含凭据与消息内容。',
      level: '最低级别',
      refresh: '刷新',
      copy: '复制全部',
      copied: '已复制！',
      copyFailed: '复制失败——请手动选中文本复制。',
      clear: '清空日志',
      loading: '加载中…',
      empty: '暂无日志。使用一次模型后刷新即可。',
      unavailable: '日志服务不可用。',
      truncatedNote: '仅显示最新的若干行。',
      dir: '目录',
      total: '总大小',
      clearConfirm: '删除全部日志文件？',
      copyAccessible: '把完整日志复制到剪贴板',
      proxyNav: 'OpenCode Bridge — 代理',
      proxyTitle: '出口轮换',
      proxyIntro: '免费层按出口 IP 限流。某个出口被限流后进入冷却，自动改用下一个。保留“本机直连”即可继续使用本机 IP。',
      proxyAddLabel: '添加代理',
      proxyPlaceholder: 'http://host:port / socks5h://host:port / direct',
      proxyAdd: '添加',
      proxyRemove: '删除',
      proxyTest: '测试全部',
      proxyTesting: '测试中…',
      proxyRefresh: '刷新',
      proxyReady: '就绪',
      proxyCooling: '冷却中',
      proxyFailures: '失败次数',
      proxyEmpty: '代理池为空。',
      proxyHint: '支持 HTTP(S)、SOCKS4/4a、SOCKS5/5h；例如 socks5h://127.0.0.1:1080。裸 host:port 默认按 HTTP 代理处理。',
      proxyDirect: '本机直连',
      proxySaved: '已保存并应用到运行中的代理池。',
      proxySaveFailed: '已在内存中生效，但写入磁盘失败。',
      proxyReachable: '可达',
      proxyTestingDone: '测试完成。',
      proxyRemoveFailed: '删除该条目失败。',
      proxyAddFailed: '添加代理失败。',
      proxyTestFailed: '测试失败。',
      proxyOffline: '代理服务不可用。',
    };

    const fallbackT = (key) => zh[key] || en[key] || key;

    const CSS = `
      .ocf-log-wrap { display: flex; flex-direction: column; gap: 12px; }
      .ocf-log-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .ocf-log-toolbar label { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); }
      .ocf-log-toolbar button {
        font-size: 12px;
        padding: 5px 12px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
        background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-primary, #18181b);
        cursor: pointer;
      }
      .ocf-log-toolbar button:hover { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .ocf-log-toolbar button:disabled { opacity: 0.5; cursor: default; }
      /* Wrapper owns the visible frame: host CSS resets bare selects, so their
         resting border would otherwise appear only on focus. */
      .ocf-select {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.15));
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2, transparent);
      }
      .ocf-select select {
        margin: 0;
        padding: 5px 10px;
        font: inherit;
        font-size: 12px;
        line-height: 1.25;
        color: var(--dsw-alias-label-primary, #18181b);
        background: transparent;
        border: 0;
        border-radius: 8px;
        outline: none;
        cursor: pointer;
      }
      .ocf-select:focus-within { border-color: var(--dsw-alias-brand-primary, #247bbf); }
      .ocf-log-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); margin: 0; }
      .ocf-log-body {
        margin: 0;
        padding: 10px 12px;
        max-height: 460px;
        overflow: auto;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02));
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ocf-log-line { display: block; }
      .ocf-log-line.ocf-debug { color: var(--dsw-alias-label-secondary, #71717a); }
      .ocf-log-line.ocf-info { color: var(--dsw-alias-label-primary, #18181b); }
      .ocf-log-line.ocf-warn { color: var(--dsw-alias-state-warn-primary, #d97706); }
      .ocf-log-line.ocf-error { color: var(--dsw-alias-state-error-primary, #dc2626); }
      .ocf-log-meta { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); margin: 0; overflow-wrap: anywhere; }
      .ocf-proxy-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .ocf-proxy-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); border-radius: 10px; }
      .ocf-proxy-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-primary, #18181b); overflow-wrap: anywhere; }
      .ocf-proxy-state { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
      .ocf-proxy-state.is-ready { color: var(--dsw-alias-state-success-primary, #16a34a); background: var(--dsw-alias-bg-layer-2, rgba(22,163,74,0.10)); }
      .ocf-proxy-state.is-cooling { color: var(--dsw-alias-state-warn-primary, #d97706); background: var(--dsw-alias-bg-layer-2, rgba(217,119,6,0.12)); }
      .ocf-proxy-code { font-size: 11px; color: var(--dsw-alias-label-secondary, #71717a); }
      .ocf-proxy-row button { margin-left: auto; }
      /* Browser-style tabs inside one rounded card.
         - The card carries the visible 1px border in border-l2, the same weight
           the host's own settings cards use; border-l1 was nearly invisible.
         - The tab strip sits under the card's top edge, so the card's top-left
           and top-right corners stay rounded while the tabs still read as tabs:
           the active tab paints its own basline away and joins the panel. */
      .ocf-tabbed {
        display: flex;
        flex-direction: column;
        gap: 0;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        overflow: hidden;
      }
      .ocf-tabs {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        padding: 8px 10px 0;
        border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03));
      }
      .ocf-tab {
        position: relative;
        bottom: -1px;
        max-width: 260px;
        padding: 6px 14px;
        font: inherit;
        font-size: 12px;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--dsw-alias-label-secondary, #71717a);
        background: transparent;
        border: 1px solid transparent;
        border-bottom: 1px solid transparent;
        border-radius: 8px 8px 0 0;
        cursor: pointer;
      }
      .ocf-tab:hover:not(.is-active) {
        color: var(--dsw-alias-label-primary, #18181b);
        background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.6));
      }
      .ocf-tab.is-active {
        color: var(--dsw-alias-label-primary, #18181b);
        font-weight: 600;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border-color: var(--dsw-alias-border-l2, rgba(0,0,0,0.16));
        border-bottom-color: var(--dsw-alias-bg-layer-1, #ffffff);
      }
      .ocf-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: -3px; }
      .ocf-tabpanel {
        padding: 12px;
        background: var(--dsw-alias-bg-layer-1, #ffffff);
        border: none;
        border-radius: 0;
      }
    `;

    function levelClass(line) {
      if (line.indexOf('[ERROR]') >= 0) return 'ocf-error';
      if (line.indexOf('[WARN ') >= 0) return 'ocf-warn';
      if (line.indexOf('[DEBUG]') >= 0) return 'ocf-debug';
      return 'ocf-info';
    }

    function LogPanel(props) {
      // Props come from the slot registration's `inject`; statics are a
      // fallback for hosts that do not forward registration props.
      const t = (props && props.t) || LogPanel.t || fallbackT;
      const rpc = (props && props.rpc) || LogPanel.rpc || null;
      const [level, setLevel] = useState('warn');
      const [lines, setLines] = useState([]);
      const [meta, setMeta] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState('');
      const styleRef = useRef(null);

      useEffect(() => {
        // Component-local stylesheet: removed with the component.
        if (typeof document === 'undefined') return undefined;
        try {
          const el = document.createElement('style');
          el.textContent = CSS;
          document.head.appendChild(el);
          styleRef.current = el;
          return () => {
            if (el.parentNode) el.parentNode.removeChild(el);
          };
        } catch (e) {
          return undefined;
        }
      }, []);

      const load = useCallback(
        async (silent) => {
          if (!silent) setBusy(true);
          setError('');
          try {
            if (!rpc) {
              setError(t('unavailable'));
              return;
            }
            const result = await rpc.call(RPC_CHANNEL, `${RPC_NAMESPACE}/read`, { level, limit: 800 });
            if (!result || !result.ok) {
              setError((result && result.error && result.error.message) || t('unavailable'));
              return;
            }
            const value = result.value || {};
            setLines(Array.isArray(value.lines) ? value.lines : []);
            setMeta(value);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        },
        [level, rpc, t],
      );

      useEffect(() => {
        load(false);
      }, [load]);

      const copyAll = useCallback(async () => {
        const text = lines.join('\n');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          setCopied('ok');
        } catch (e) {
          setCopied('fail');
        }
        setTimeout(() => setCopied(''), 2000);
      }, [lines]);

      const clearAll = useCallback(async () => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('clearConfirm'))) return;
        setBusy(true);
        try {
          if (rpc) await rpc.call(RPC_CHANNEL, `${RPC_NAMESPACE}/clear`, {});
          await load(true);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      }, [load, rpc, t]);

      return h(
        'div',
        { className: 'ocf-log-wrap' },
        h('p', { className: 'ocf-log-note' }, t('intro')),
        h(
          'div',
          { className: 'ocf-log-toolbar' },
          h('label', { htmlFor: 'ocf-log-level' }, t('level')),
          // The host styles bare `select` elements and drops the resting border,
          // so the frame lives on a wrapper span instead.
          h(
            'span',
            { className: 'ocf-select' },
            h(
              'select',
              {
                id: 'ocf-log-level',
                value: level,
                onChange: (e) => setLevel(e.target.value),
                'aria-label': t('level'),
              },
              LEVELS.map((l) => h('option', { key: l, value: l }, l)),
            ),
          ),
          h('button', { type: 'button', onClick: () => load(false), disabled: busy }, busy ? t('loading') : t('refresh')),
          h(
            'button',
            { type: 'button', onClick: copyAll, disabled: !lines.length, title: t('copyAccessible'), 'aria-label': t('copyAccessible') },
            copied === 'ok' ? t('copied') : t('copy'),
          ),
          h('button', { type: 'button', onClick: clearAll, disabled: busy }, t('clear')),
          copied === 'fail' ? h('span', { className: 'ocf-log-note' }, t('copyFailed')) : null,
        ),
        error ? h('p', { className: 'ocf-log-note', role: 'alert' }, error) : null,
        meta && meta.truncated ? h('p', { className: 'ocf-log-note' }, t('truncatedNote')) : null,
        lines.length
          ? h(
              'pre',
              { className: 'ocf-log-body', tabIndex: 0 },
              lines.map((line, i) => h('span', { key: i, className: `ocf-log-line ${levelClass(line)}` }, line, '\n')),
            )
          : h('p', { className: 'ocf-log-note' }, busy ? t('loading') : t('empty')),
        meta
          ? h('p', { className: 'ocf-log-meta' }, `${t('dir')}: ${meta.dir} · ${t('total')}: ${meta.totalBytes} B · ${t('records')}: ${lines.length}`)
          : null,
      );
    }

    function ProxyPanel(props) {
      const t = (props && props.t) || ProxyPanel.t || fallbackT;
      const rpc = (props && props.rpc) || ProxyPanel.rpc || null;
      const [entries, setEntries] = useState([]);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');
      const styleRef = useRef(null);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        try {
          const el = document.createElement('style');
          el.textContent = CSS;
          document.head.appendChild(el);
          styleRef.current = el;
          return () => {
            if (el.parentNode) el.parentNode.removeChild(el);
          };
        } catch (e) {
          return undefined;
        }
      }, []);

      const call = useCallback(
        async (method, payload) => {
          if (!rpc) throw new Error(t('proxyOffline'));
          const result = await rpc.call(RPC_CHANNEL, `${PROXY_RPC_NAMESPACE}/${method}`, payload || {});
          if (!result || !result.ok) {
            throw new Error((result && result.error && result.error.message) || t('proxyOffline'));
          }
          return result.value || {};
        },
        [rpc, t],
      );

      const load = useCallback(async () => {
        setError('');
        try {
          const value = await call('read', {});
          setEntries(Array.isArray(value.entries) ? value.entries : []);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        }
      }, [call]);

      useEffect(() => {
        load();
      }, [load]);

      const submit = useCallback(
        async (payload, failureKey) => {
          setBusy(true);
          setError('');
          setMessage('');
          try {
            const value = await call('write', payload);
            setEntries(Array.isArray(value.entries) ? value.entries : []);
            const rejected = Array.isArray(value.rejected) ? value.rejected : [];
            if (rejected.length) {
              setError(`${rejected[0].raw}: ${rejected[0].reason}`);
            } else {
              setMessage(value.saved === false ? t('proxySaveFailed') : t('proxySaved'));
            }
          } catch (e) {
            setError(`${t(failureKey)} ${String(e && e.message ? e.message : e)}`);
          } finally {
            setBusy(false);
          }
        },
        [call, t],
      );

      const add = useCallback(async () => {
        const value = draft.trim();
        if (!value) return;
        await submit({ add: value }, 'proxyAddFailed');
        setDraft('');
      }, [draft, submit]);

      const testAll = useCallback(async () => {
        setBusy(true);
        setError('');
        setMessage(t('proxyTesting'));
        try {
          const value = await call('test', {});
          setEntries(Array.isArray(value.entries) ? value.entries : entries);
          const results = Array.isArray(value.results) ? value.results : [];
          const reachable = results.filter((r) => r && r.ok).length;
          const failed = results.filter((r) => r && !r.ok);
          if (failed.length) {
            const first = failed[0];
            setError(`${first.display}: ${first.code || 'unreachable'}`);
          }
          setMessage(`${t('proxyTestingDone')} ${reachable}/${results.length} ${t('proxyReachable')}.`);
          // A probe retires throttled egresses, so refresh the state chips.
          const after = await call('read', {});
          if (Array.isArray(after.entries)) setEntries(after.entries);
        } catch (e) {
          setError(`${t('proxyTestFailed')} ${String(e && e.message ? e.message : e)}`);
          setMessage('');
        } finally {
          setBusy(false);
        }
      }, [call, entries, t]);

      const remove = useCallback(
        async (id) => {
          await submit({ remove: id }, 'proxyRemoveFailed');
        },
        [submit],
      );

      const stateLabel = (entry) =>
        entry && entry.state === 'cooling'
          ? `${t('proxyCooling')}${entry.coolingUntil ? ` · ${Math.max(0, Math.round((entry.coolingUntil - Date.now()) / 1000))}s` : ''}`
          : t('proxyReady');

      return h(
        'div',
        { className: 'ocf-log-wrap' },
        h('p', { className: 'ocf-log-note' }, t('proxyIntro')),
        h(
          'div',
          { className: 'ocf-log-toolbar' },
          h('label', { htmlFor: 'ocf-proxy-add' }, t('proxyAddLabel')),
          h('input', {
            id: 'ocf-proxy-add',
            type: 'text',
            value: draft,
            spellCheck: false,
            placeholder: t('proxyPlaceholder'),
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') add();
            },
            style: {
              minWidth: '260px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '12px',
              padding: '5px 10px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15))',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
              color: 'var(--dsw-alias-label-primary, #18181b)',
            },
          }),
          h('button', { type: 'button', onClick: add, disabled: busy || !draft.trim() }, t('proxyAdd')),
          h('button', { type: 'button', onClick: testAll, disabled: busy }, busy ? t('proxyTesting') : t('proxyTest')),
          h('button', { type: 'button', onClick: load, disabled: busy }, t('proxyRefresh')),
        ),
        h('p', { className: 'ocf-log-note' }, t('proxyHint')),
        error ? h('p', { className: 'ocf-log-note', role: 'alert' }, error) : null,
        message ? h('p', { className: 'ocf-log-note' }, message) : null,
        entries.length
          ? h(
              'ul',
              { className: 'ocf-proxy-list' },
              entries.map((entry) =>
                h(
                  'li',
                  { key: entry.id, className: 'ocf-proxy-row' },
                  h('span', { className: 'ocf-proxy-name' }, entry.display || t('proxyDirect')),
                  h(
                    'span',
                    { className: `ocf-proxy-state ${entry.state === 'cooling' ? 'is-cooling' : 'is-ready'}` },
                    stateLabel(entry),
                  ),
                  entry.lastCode ? h('span', { className: 'ocf-proxy-code' }, entry.lastCode) : null,
                  h(
                    'button',
                    { type: 'button', onClick: () => remove(entry.id), disabled: busy },
                    t('proxyRemove'),
                  ),
                ),
              ),
            )
          : h('p', { className: 'ocf-log-note' }, t('proxyEmpty')),
      );
    }

    // One settings page with two tabs: the log viewer and the egress pool used
    // to live in separate sections, which read as two unrelated plugins.
    function BridgePanel(props) {
      const t = (props && props.t) || BridgePanel.t || fallbackT;
      const rpc = (props && props.rpc) || BridgePanel.rpc || null;
      const [tab, setTab] = useState('logs');
      const styleRef = useRef(null);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        try {
          const el = document.createElement('style');
          el.textContent = CSS;
          document.head.appendChild(el);
          styleRef.current = el;
          return () => {
            if (el.parentNode) el.parentNode.removeChild(el);
          };
        } catch (e) {
          return undefined;
        }
      }, []);

      return h(
        'div',
        { className: 'ocf-log-wrap' },
        h('h1', { style: { margin: '0 0 4px', fontSize: '18px', color: 'var(--dsw-alias-label-primary, #18181b)' } }, t('pageTitle')),
        h('p', { className: 'ocf-log-note' }, t('pageIntro')),
        // Tabs and panel share one zero-gap column: the outer wrap's 12px gap
        // would separate the strip's baseline from the panel and leave the
        // top corners visually open.
        h(
          'div',
          { className: 'ocf-tabbed' },
          h(
            'div',
            { className: 'ocf-tabs', role: 'tablist', 'aria-label': t('pageTitle') },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                id: 'ocf-tab-logs',
                'aria-selected': tab === 'logs',
                'aria-controls': 'ocf-tabpanel',
                'data-active': tab === 'logs',
                className: `ocf-tab${tab === 'logs' ? ' is-active' : ''}`,
                onClick: () => setTab('logs'),
              },
              t('tabLogs'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                id: 'ocf-tab-proxies',
                'aria-selected': tab === 'proxies',
                'aria-controls': 'ocf-tabpanel',
                'data-active': tab === 'proxies',
                className: `ocf-tab${tab === 'proxies' ? ' is-active' : ''}`,
                onClick: () => setTab('proxies'),
              },
              t('tabProxies'),
            ),
          ),
          h(
            'div',
            { className: 'ocf-tabpanel', id: 'ocf-tabpanel', role: 'tabpanel', 'aria-labelledby': tab === 'logs' ? 'ocf-tab-logs' : 'ocf-tab-proxies' },
            tab === 'logs' ? h(LogPanel, { rpc, t }) : h(ProxyPanel, { rpc, t }),
          ),
        ),
      );
    }

    return {
      // Only slots is a hard dependency; locale/connection degrade gracefully.
      inject: ['slots'],
      apply(ctx) {
        // 1. Locale — register the namespace BEFORE binding it; bind() on an
        // unregistered namespace can throw. Each step is independently guarded
        // so a locale failure cannot prevent the settings page from mounting.
        let t = fallbackT;
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            let dispose = null;
            try {
              dispose = ctx.locale.register(NS, { en, zh });
            } catch (e) {
              // Some hosts only accept the per-locale form for custom namespaces.
              try {
                const d1 = ctx.locale.register(NS, 'en', en);
                const d2 = ctx.locale.register(NS, 'zh', zh);
                dispose = () => {
                  if (typeof d1 === 'function') d1();
                  if (typeof d2 === 'function') d2();
                };
              } catch (e2) {
                console.error('[dsh-opencode-bridge] locale register failed:', e2);
              }
            }
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') ctx.effect(() => dispose);
          }
          if (ctx.locale && typeof ctx.locale.bind === 'function') {
            t = ctx.locale.bind(NS) || fallbackT;
          }
        } catch (e) {
          console.error('[dsh-opencode-bridge] locale setup failed:', e);
        }

        // 2. RPC client — soft access; the panel reports "unreachable" if absent.
        let rpc = null;
        try {
          const connection = ctx.get ? ctx.get('connection') : ctx.connection;
          rpc = (connection && connection.rpc) || null;
        } catch (e) {
          console.error('[dsh-opencode-bridge] connection lookup failed:', e);
        }

        // Statics as a fallback for hosts that do not forward registration props.
        LogPanel.t = t;
        LogPanel.rpc = rpc;
        ProxyPanel.t = t;
        ProxyPanel.rpc = rpc;
        BridgePanel.t = t;
        BridgePanel.rpc = rpc;

        // 3. Slot registration — guarded and optional-chained: the settings
        // slot may not be declared yet at activation time. One section only:
        // the log viewer and the proxy pool are tabs inside it.
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'opencode-bridge',
                  order: 30,
                  label: () => t('nav'),
                  inject: () => ({ rpc, t }),
                },
                BridgePanel,
              ),
            );
          } else {
            console.error('[dsh-opencode-bridge] slots service unavailable; settings page not registered');
          }
        } catch (e) {
          // Never rethrow: a failed activation is a fatal web-boot error.
          console.error('[dsh-opencode-bridge] settings registration failed:', e);
        }
      },
    };
  },
});
