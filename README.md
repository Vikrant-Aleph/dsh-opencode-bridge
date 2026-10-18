# dsh-opencode-bridge

[中文](README.zh.md) | English

Use the **free models of [OpenCode](https://opencode.ai)** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — no account, no API key.

The plugin is a DSH **LLM adapter** bundle that simulates the official OpenCode
client wire protocol, which the opencode.ai free tier ("Zen" relay) requires:
`big-pickle`, `mimo-v2.6-flash-free`, `glm-5.3-flash-free`,
`deepseek-v4.1-flash-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`
and friends become selectable DSH models.

## How it works

The relay rejects non-OpenCode callers with `403 FreeTierError`. This plugin
reproduces the official client's request fingerprint (verified live, 2026-10):

| Layer | What the plugin sends |
|---|---|
| User-Agent | `opencode/<version> ai-sdk/provider-utils/... runtime/bun/...` plus DSH's attribution with its `/<version>` stripped (a versioned foreign product token is rejected) |
| Session identity | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` = one stable `ses_` id per conversation, and `x-opencode-request` = `msg_` id per call, both minted with the CLI's descending/ascending `~(ms*0x1000+counter)` 48-bit encoding + 14 base62 chars. The upstream decodes the time field and rejects fake counters. |
| Client headers | `x-opencode-client: cli`, `x-opencode-project: global` |
| Tool fingerprint | Declare canonical `read`/`shell` plus `bash`/`glob`/`grep`; reserve every caller name before allocating collision-free aliases. Added shell tools are never executable; only conservatively validated read/search mappings may reach tools already provided by the caller. |
| Streaming | `stream: true`, `tool_choice: "auto"` |

Models and their limits/reasoning levels are discovered from the public
[models.dev](https://models.dev) registry (zero-cost entries) intersected with
the relay's live `GET /models` listing.

## Install

**From npm** (after publishing), pinning a version for reproducibility:

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.4.0
```

`dsh` resolves from your DSH installation; if it is not on `PATH`, the same
command works as `npx @deepseek-ai/dsh plugin ...`.

**From source** (this directory):

```sh
pnpm install && pnpm build && pnpm pack

# install the tarball into your profile (example: "desktop")
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.4.0.tgz
```

Restart the profile, then pick any `opencode-bridge/*` model in the model
selector. No configuration is required — the plugin is keyless.

## Configuration (optional)

All settings have working defaults; change them in `cordis.patch.yml`:

```yaml
- id: dsh-opencode-bridge
  config:
    baseUrl: https://opencode.ai/inference/v1   # relay base
    apiKey: public                              # signed-out sentinel
    userAgent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
    client: cli                                 # x-opencode-client
    project: global                             # x-opencode-project
    providers: [opencode-bridge]                  # provider route(s)
    includeDeprecated: false                    # also offer deprecated models still listed live
    extraModels: []                             # force-add model ids
    requestTimeoutMs: 600000
    proxies: []                                 # direct only; e.g. [direct, 'http://127.0.0.1:7890']
    proxyCooldownMs: 60000                       # base cooldown after HTTP 429
    proxyStorePath: ''                           # empty = $DSH_PROFILE_DIR (or ~/.dsh) + /data/dsh-opencode-bridge/proxies.json
    toolFingerprint: true                       # send the tool fingerprint
    toolTranslation: true                       # allow validated read/search decoys; never shell
    logLevel: warn                              # debug|info|warn|error|off
    logDir: ''                                  # empty = ~/.dsh/logs/dsh-opencode-bridge
    logMaxBytes: 524288                         # per-file size cap before rotation
    logMaxFiles: 5                              # total files kept; oldest deleted first
```

`toolFingerprint: false` preserves caller tools unchanged and injects no decoys.
`toolTranslation: false` still restores caller aliases, but rejects injected tools;
it does not forward unvalidated OpenCode arguments to DSH.

## Safe tool bridge & offline scope audit (0.3.0)

The bridge uses the **actual request's caller tools**, not the global registry.
It restores caller aliases, rejects injected `bash`/`shell` rather than guessing
Bash→PowerShell, and maps injected `read`/`glob`/`grep` only when a caller target
exists and its schema fits a conservative validated subset. Unknown constraints
such as `$ref` or `pattern` fail closed. Caller-owned native tools, including
`pwsh` and canonical shell tools, remain subject to DSH's own validation/execution.
Native/alias calls must also have JSON-object arguments (raw bytes preserved);
complete native schema/permission checks remain DSH-owned. “Read-only” describes
bridge routes, not a guarantee about arbitrary tool implementations.

All returned tool calls are checked **before any tool-call chunk is emitted**;
one rejection blocks the whole batch. Tool fragments ending with EOF, `length`
or `stop` instead of `tool_calls` fail with `TOOL_BRIDGE_INCOMPLETE`. Policy
rejections use `TOOL_BRIDGE_REJECTED` and a fixed reason, without arguments.
This is bridge-level atomic release, not transactional execution/side-effect
rollback; already streamed text/reasoning remains visible, and DSH still applies
its own native schema and permission checks.

Ask the agent to call `opencode_bridge_audit` with:

```json
{ "limit": 12 }
```

Calling it with `{}` uses the default limit 80 (range 1–200). It reads only the
current agent's native tool schemas and returns names, aliases, route decisions
and reason codes; no schema descriptions/defaults, arguments or chat history.
It makes no network requests and executes no tools. Missing agent scope is
rejected, never replaced with a global registry view. The report basis is
`current-agent-scoped-native-registry`: Code Mode/PTC and auxiliary requests may
expose different tools. It is **not** call history, an HTTP/model health test,
or a permission grant; each real request is planned again from `GenerateOptions.tools`.
See the [source comparison](docs/COMPARISON.zh.md) for existing alternatives and evidence limits.

## Egress-proxy rotation (0.4.0)

`proxies: []` means direct only; use `direct` (also `none` or an empty entry)
for the local IP, or HTTP(S) proxy URLs/bare `host:port`. Duplicates are removed;
SOCKS/other schemes are rejected. HTTP proxy credentials can be supplied as
`http://user:password@host:port` (URL-encode reserved characters).

In Settings → **OpenCode Bridge** → **Egress rotation (optional)**, add/remove entries, refresh health or
**Test all**. Rows show a credential-redacted address, ready/cooling with remaining
seconds and lastCode. Test all calls relay `GET /models` per entry: no prompts or
completion request, but still network traffic subject to upstream rules; 429 cools
that entry. UI rendering/RPC acceptance is not established by the tests alone.

Each request prefers the first configured ready entry, reusing a healthy egress;
there is no per-session binding. Cooling entries yield to the next ready one,
and earlier entries regain priority after recovery. Within one request, only
HTTP 429 or a pre-stream transport failure triggers
failover; 401, FreeTierError/403 and 503 do not. Numeric Retry-After hints take
priority, otherwise 429 cooldown grows from `proxyCooldownMs` (60s default),
normally capped at 30min. Transport failures cool briefly (at most 15s).
When all entries cool, the earliest recovery gets a best-effort attempt instead
of a local hard failure. Streaming-body failures are surfaced, never retried.

The UI-saved list overrides config at startup and is stored at
`(DSH_PROFILE_DIR || ~/.dsh)/data/dsh-opencode-bridge/proxies.json` unless
`proxyStorePath` overrides it. Health/UI reads omit userinfo; remove/reset do not
echo saved passwords. Adding necessarily sends the newly entered URL to the Host.
**Proxy passwords remain plaintext in this local JSON, not encrypted.**
Only HTTP(S) CONNECT is supported; no global fetch/dispatcher patch is installed.
A different proxy need not mean a different public IP, and upstream quota is not
proven to depend only on IP. Use only authorized proxies and respect service limits.

## Logging & diagnostics

`opencode_bridge_log` supports `action: read|stat|clear|level`. Call sites aim to
record metadata only, with best-effort secret redaction and oldest-first rotation.
These are not perfect privacy or strict byte-cap guarantees: error text and
metadata can be sensitive, a write may overshoot the rotation threshold, and
cleanup can fail. Review logs before sharing them.

## Notes & limits

- **Rate limits**: HTTP 429 (`FreeUsageLimitError`) cools the selected egress;
  other configured entries may help, but cannot guarantee fresh quota. Exhausted
  pools surface the rate limit; the service may also use non-IP quota signals.
- **Text + tools first**: images/files in prompts are sent as placeholders on
  this path; most free models are text-in anyway. Reasoning deltas from models
  that emit `reasoning_content` are surfaced as thinking blocks.
- **Live with the relay**: the upstream gate evolves (it gained the session
  counter and tool checks within days in 2026-10). If `403 FreeTierError`
  returns, update `userAgent`/fingerprint in `src/opencode-protocol.ts`.
- Only zero-cost models are offered. Paid OpenCode models require an OpenCode
  Console account and are out of scope here.

## Development

Requires **Node ≥ 20.3** (the adapter uses `AbortSignal.any`) and pnpm:

```sh
pnpm install
pnpm build       # tsc -> lib/  (lib/ is generated, not committed)
pnpm test        # node --test tests/*.test.mjs
node tests/smoke.mjs [model-id]   # live end-to-end probe
```

The offline suites cover tool planning, bridge/schema rejection, scoped audit,
atomic response batches, client activation and logging. `tests/wire-dump.mjs` is
an offline wire dump. `tests/smoke.mjs` checks ids/planning/catalog and a real
streaming completion, consuming network/quota; it does not verify every model,
Desktop startup, or all tool execution paths.

For the protocol internals — the three-layer gate, the identifier bit layout,
tool cloaking/translation, and the update playbook for when the upstream
changes — see [TECHNICAL.md](TECHNICAL.md) ([中文](TECHNICAL.zh.md)).

## Credits

Protocol details were reconstructed from the official client source
(`sst/opencode`), and cross-checked against community reports (sub2api,
9router, hermes-oc-free-provider, cpa-plugin-opencodezen). This project is not
affiliated with OpenCode or DeepSeek.

## License

MIT
