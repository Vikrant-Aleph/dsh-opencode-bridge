// Client half of dsh-opencode-free: a Settings page that views and copies the
// plugin diagnostic log. Registers into the `settings.section` slot and talks
// to the Host half over the package's `/api/opencode-free-logs/*` RPC routes.
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
    const RPC_NAMESPACE = 'opencode-free-logs';

    const en = {
      nav: 'OpenCode Free',
      title: 'OpenCode Free — Diagnostic Log',
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
    };
    const zh = {
      nav: 'OpenCode Free',
      title: 'OpenCode Free — 诊断日志',
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
    };

    const fallbackT = (key) => zh[key] || en[key] || key;

    const CSS = `
      .ocf-log-wrap { display: flex; flex-direction: column; gap: 12px; }
      .ocf-log-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .ocf-log-toolbar label { font-size: 12px; color: var(--dsw-alias-label-secondary, #71717a); }
      .ocf-log-toolbar select,
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
      const [level, setLevel] = useState('debug');
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
        h('h1', { style: { margin: '0 0 4px', fontSize: '18px', color: 'var(--dsw-alias-label-primary, #18181b)' } }, t('title')),
        h('p', { className: 'ocf-log-note' }, t('intro')),
        h(
          'div',
          { className: 'ocf-log-toolbar' },
          h('label', { htmlFor: 'ocf-log-level' }, t('level')),
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
                console.error('[dsh-opencode-free] locale register failed:', e2);
              }
            }
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') ctx.effect(() => dispose);
          }
          if (ctx.locale && typeof ctx.locale.bind === 'function') {
            t = ctx.locale.bind(NS) || fallbackT;
          }
        } catch (e) {
          console.error('[dsh-opencode-free] locale setup failed:', e);
        }

        // 2. RPC client — soft access; the panel reports "unreachable" if absent.
        let rpc = null;
        try {
          const connection = ctx.get ? ctx.get('connection') : ctx.connection;
          rpc = (connection && connection.rpc) || null;
        } catch (e) {
          console.error('[dsh-opencode-free] connection lookup failed:', e);
        }

        // Statics as a fallback for hosts that do not forward registration props.
        LogPanel.t = t;
        LogPanel.rpc = rpc;

        // 3. Slot registration — guarded and optional-chained: the settings
        // slot may not be declared yet at activation time.
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'opencode-free-logs',
                  order: 30,
                  label: () => t('nav'),
                  inject: () => ({ rpc, t }),
                },
                LogPanel,
              ),
            );
          } else {
            console.error('[dsh-opencode-free] slots service unavailable; settings page not registered');
          }
        } catch (e) {
          // Never rethrow: a failed activation is a fatal web-boot error.
          console.error('[dsh-opencode-free] settings registration failed:', e);
        }
      },
    };
  },
});
