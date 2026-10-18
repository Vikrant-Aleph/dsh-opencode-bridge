# dsh-opencode-bridge — Technical Design

[中文](TECHNICAL.zh.md) | English

Engineering documentation for the `dsh-opencode-bridge` DSH plugin: how the
OpenCode free-tier gate was reverse-engineered, how the wire protocol is
reproduced, how the adapter maps onto the DSH LLM contract, and what to do when
the upstream changes.

Audience: maintainers of this plugin, and DSH plugin authors who want a worked
example of a provider-wire `LlmAdapter`.

> Snapshot notice: every gate fact below was established empirically in
> **2026-10** against `https://opencode.ai/inference/v1`, plus a read of the
> official client source (`sst/opencode`, branch `dev`, v2.0.26). The upstream
> gate is actively evolving — treat all constants as a dated snapshot, not a
> permanent specification. Section 10 is the update playbook.

---

## 0. Documentation maintenance policy (binding on humans and AI alike)

**This document is a living document.** Whenever any of the following changes,
update this file (`TECHNICAL.md`) and its Chinese counterpart
(`TECHNICAL.zh.md`) in the same change, keeping the two consistent:

1. any user-visible feature is added or removed (config keys, UI, tools,
   logging behavior);
2. any technical principle changes (protocol, gate workaround, data flow,
   module boundary, error taxonomy);
3. any documented constant is replaced (UA, fingerprint tools, endpoints,
   defaults, thresholds);
4. the build/pack/publish flow or a DSH dependency version changes;
5. **the version number is bumped** — in the same change, update the install
   command (`dsh plugin ... add dsh-opencode-bridge@<version>`) and the local
   tarball example (`./dsh-opencode-bridge-<version>.tgz`) in both READMEs to
   the new `package.json` version. Both must match `version` exactly;
   `tests/readme-version.test.mjs` enforces this — do not bypass it.

Record every such change in chapter 14 "Change log" — one line per change,
written as part of the same commit. **Never leave a "code changed, docs stale"
commit.**

### AI handover guide (start here)

You are an AI taking over this repository? Build context in this order before
touching code:

1. **Read this section and chapters 1–2** — what the plugin does and where it
   attaches to DSH.
2. **Read chapter 3, the module map** — `opencode-protocol.ts` owns gate constants
   and planning; `tool-bridge.ts` owns conservative mapping/validation and
   `bridge-audit.ts` the scoped audit. Keep adapter/catalog/logger boundaries.
3. **Before editing, read chapter 4 (the gate) and chapter 5 (the wire)** —
   this is the highest-risk area: one wrong constant turns every request into
   a 403.
4. **After changes, always run**: `node node_modules/typescript/bin/tsc -p
   tsconfig.json` (build), `node --test tests/*.test.mjs` (unit tests),
   and, when network/quota use is explicitly appropriate, `node tests/smoke.mjs`
   (live probe — see chapter 10 for 429/403). Report skipped verification; never
   substitute offline tests for live acceptance.
5. **Before finishing, apply the maintenance policy above** and update this
   document plus the change log.
6. Logging/diagnostic questions belong to chapter 15; the settings-panel UI
   lives in `client.js` (a browser `__ModuleLoader__` module, not TypeScript —
   see 15.3).
7. **Read 15.6 before touching `client.js`**: activation exceptions can break
   client startup; regression tests do not prove Desktop crash recovery. After
   changes run `node --test tests/client-boot.test.mjs` and report live limits.

---

## 1. Scope and positioning

| | |
|---|---|
| **Goal** | Make the keyless OpenCode free-tier models selectable as first-class DSH models. |
| **Non-goal** | Paid OpenCode models (they need an OpenCode Console account and a console-issued key). |
| **Mechanism** | An `LlmAdapter` that speaks the official OpenCode client's wire protocol to the opencode.ai relay. |
| **Credential** | None. The relay accepts the signed-out sentinel `Bearer public`. |
| **Distribution** | npm bundle with a `cordis.patch.yml` layer patch. |

The plugin is an in-process adapter and creates no local proxy server. It may
route relay traffic through user-configured HTTP(S) CONNECT proxies (section 6.9).

---

## 2. System context

```
┌─ DSH host process ────────────────────────────────────────────────┐
│                                                                   │
│  dsh-agent-loop ──► LlmRuntime ──► OpenCodeFreeAdapter            │
│       │                  │              │                         │
│       │  GenerateOptions │              │ StreamChunk             │
│       └──────────────────┴──────────────┘                         │
│                                    │                              │
│  ctx.llm ◄── registerAdapter ──────┘                              │
│      ▲                                                            │
│      └── FreeModelCatalog ──► models.dev  (metadata)               │
│                           └─► GET /models (live availability)      │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ HTTPS + SSE
                                    ▼
                    https://opencode.ai/inference/v1
```

The principal adapter/discovery seams of the DSH LLM service are:

1. **`ctx.llm.registerAdapter(providers, adapter)`** — supplies the provider
   route (`opencode-bridge`) and the streaming implementation.
2. **`ctx.llm.registerModelDiscovery(id, fn)`** — supplies the GUI's model list.

It does not modify the agent loop or execute tools. Optional tool registration
adds `opencode_bridge_audit` (current-agent schemas only) and the existing log
utility. The adapter transforms request/response tool declarations; it does not
patch global HTTP entry points.

---

## 3. Module map

| File | Lines | Responsibility |
|---|---:|---|
| `src/index.ts` | — | Cordis plugin entry: `name`, `inject`, Schemastery `Config`, `apply()`, registrations, disposer. |
| `src/opencode-protocol.ts` | — | **All gate-sensitive constants.** ID minting, header recipe, verbatim fingerprint tools, tool cloaking/translation, message projection. |
| [src/adapter.ts](src/adapter.ts) | — | `OpenCodeFreeAdapter`: model metadata, request/SSE handling, whole-batch tool validation before chunk release, errors. |
| [src/tool-bridge.ts](src/tool-bridge.ts) | — | Pure fail-closed mapping/schema subset; reject executable decoys; no I/O or execution. |
| [src/bridge-audit.ts](src/bridge-audit.ts) | — | Current-agent scoped registry audit tool; metadata-only results, no network/execution. |
| [src/proxy-pool.ts](src/proxy-pool.ts) | — | Ordered egress/cooldown state, proxy store, pooled fetch and lazy undici CONNECT dispatchers. |
| [src/proxy-service.ts](src/proxy-service.ts) | — | Live edits/persistence, credential-redacted health, relay GET probes and package-private RPC. |
| [tests/proxy-pool.test.mjs](tests/proxy-pool.test.mjs) | — | Entry normalization, ordered healthy reuse, cooldown, redaction, BOM/store and transport tests. |
| [tests/proxy-rotation.test.mjs](tests/proxy-rotation.test.mjs) | — | Adapter 429/connection failover, exhausted pool and no mid-stream replay. |
| [tests/proxy-live.mjs](tests/proxy-live.mjs) | — | Opt-in real CONNECT/direct relay probes and fixed-marker synthetic completion. |
| [tests/readme-version.test.mjs](tests/readme-version.test.mjs) | — | Guard: both READMEs' install command/tarball versions must equal `package.json`. |
| [tests/tool-bridge.test.mjs](tests/tool-bridge.test.mjs) | — | Planning/collision, flag semantics, schema subset, native/decoy rejection tests. |
| [tests/bridge-integration.test.mjs](tests/bridge-integration.test.mjs) | — | Audit execution scope and mock-SSE batch/finish/error regression tests. |
| [tests/bridge-cancellation.test.mjs](tests/bridge-cancellation.test.mjs) | — | Pre-POST, buffered-call and per-chunk cancellation regression tests. |
| [docs/COMPARISON.zh.md](docs/COMPARISON.zh.md) | — | Six fixed-HEAD source comparison and differentiation limits. |
| [docs/research-notes/](docs/research-notes/README.md) | — | Publishable research notes (own analysis); the repo ships no third-party sources. |
| `src/catalog.ts` | — | `FreeModelCatalog`: metadata/live-list filtering, caching and degradation. |
| `src/logger.ts` | 326 | `PluginLogger`: levels, redaction, size-based rotation (oldest-first cleanup), memory fallback. See chapter 15. |
| `src/log-service.ts` | 245 | `LogService` + RPC routes + the `opencode_bridge_log` agent tool (one implementation, two callers). |
| [client.js](client.js) | — | Log panel (order30) and proxy add/remove/probe panel (order31); browser module, not a tsc product. See 6.9, 15.3, 15.6. |
| `cordis.patch.yml` | 4 | Bundle layer patch that inserts the plugin row. |
| `tests/logger.test.mjs` | — | Hermetic unit tests for the logging module (levels/redaction/rotation/read). |
| `tests/client-boot.test.mjs` | — | Client-module activation regression tests (apply never throws; 8 hostile-ctx cases). |
| `tests/smoke.mjs` | — | Live end-to-end probe (ids → plan → catalog → streaming completion). |
| `tests/wire-dump.mjs` | — | Prints the exact headers and fingerprint this build emits. |

**Design invariant:** every constant the upstream gate can key on lives in
`opencode-protocol.ts`. Nothing else in the codebase hard-codes a
gate fingerprint constant. Changes to planning may also need bridge, adapter,
audit and test updates; a new upstream declaration never grants execution authority.

---

## 4. The upstream gate

The relay rejects callers it does not believe are the official client:

```json
HTTP/1.1 403 Forbidden
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode.
            Download it at https://opencode.ai and keep building."}}
```

Naive attempts (`Bearer public` + a plain User-Agent + `x-opencode-client: cli`)
fail with exactly this response. Passing it requires satisfying three
independent layers.

### 4.1 Layer 1 — User-Agent

The value must contain a product token `opencode/<major>.<minor>[.<patch>]`
new enough for the gate (≥1.17/1.18 depending on the reporting source; this
plugin sends 1.19.0).

The trap: **a versioned foreign product token anywhere in the value is
rejected.** DSH's mandatory attribution header is
`deepseek-harness/<version> (+url)`; sent verbatim it trips the gate.

Fix — keep the attribution, strip only its version:

```ts
// src/opencode-protocol.ts
export function attributionSuffix(): string {
  const ua = attributionHeaders()['user-agent']
  return ua ? ` ${ua.replace(/^([\w-]+)\/\S+/, '$1')}` : ''
}
```

Resulting wire value:

```
opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14 deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)
```

This satisfies DSH's attribution contract (product name + project URL are
still advertised) while removing the version that the gate rejects. See
section 12 for the rationale.

### 4.2 Layer 2 — Session and request identity

Four headers carry a session id and one carries a per-call request id
(section 5.1). They are not opaque strings — the upstream decodes them:

```
ses_<12 hex><14 base62>      x-opencode-session, -session-id, x-session-affinity, x-session-id
msg_<12 hex><14 base62>      x-opencode-request
```

The 12 hex digits are the **48-bit truncation of `ms * 0x1000 + counter`**:

- `ses_` carries the **bitwise complement** (`~value`) — the official
  `Identifier.descending()` scheme, so newer sessions sort first.
- `msg_` carries the value directly — `Identifier.ascending()`.

`counter` is a sub-millisecond disambiguator living in the low 12 bits. Live
probing showed its range is validated: **counters 0–16 pass; counter ≥ 100 is
rejected with `FreeTierError`.** A caller that fabricates ids with a large or
constant counter is detected.

This plugin therefore generates ids the way the CLI does (`nextIdValue()` in
`opencode-protocol.ts`): reset the counter on every new millisecond, increment
per id, and clamp at 16 so a burst in one millisecond can never reach the
rejected range.

Checkable invariant: for `counter == 1`, `~1 & 0xFFF == 0xFFE`, so a freshly
minted `ses_` id always ends its hex field with `ffe`.

### 4.3 Layer 3 — Tool fingerprint

The request body must declare OpenCode's own built-in tools. The requirement
has moved:

- older gate: the `bash`/`glob`/`grep`/`read` quartet
- v2.0.26: an exact comparison of the `read` and `shell` **descriptions and
  parameter schemas**

The plugin sends both sets: `read` and `shell` verbatim from the CLI
(`READ_TOOL`, `SHELL_TOOL`), plus stub `bash`/`glob`/`grep`. See section 6.4
for how caller tools coexist with these without breaking tool execution.

### 4.4 Body-level requirements

`stream: true` and a `tool_choice` other than `"none"` are part of the
fingerprint on some routes. The plugin always streams and sends
`tool_choice: "auto"`.

### 4.5 Endpoint topology

| Path | Role |
|---|---|
| `/inference/v1` | **Default.** OpenAI-compatible relay. |
| `/inference/openai/v1` | The console proxy's mapping target; where chat requests are served. |
| `/inference/anthropic/v1` | Anthropic-family models (registry `provider.api` routes here). |
| `/zen/v1` | Legacy alias. |
| `/inference/systemone/v1` | SystemOne evaluation route — not a chat endpoint. |

`GET {baseUrl}/models` answers **anonymously** — model discovery needs no
fingerprint, only a plausible UA.

Because the registry can override the base per model (`provider.api`), the
adapter resolves the chat endpoint per request as
`meta.api ?? config.baseUrl`, then appends `/chat/completions`.

### 4.6 Empirical evidence

Live probe matrix against `/inference/v1/chat/completions`:

| Probe | Variation | Result |
|---|---|---|
| A | verbatim `read` + `shell`, quartet stubs, counter = 1 | **200** |
| B | quartet stubs only (no verbatim schemas) | 200 |
| C | counter = 100 | **403 FreeTierError** |
| D | `User-Agent: curl/8.4.0` | **403 FreeTierError** |
| E | `tool_choice: "none"` | 200 |

Conclusions that shaped the design:

- The UA version token and the session-counter encoding are **hard gates**
  (probes C and D).
- On this route, at that time, the exact tool schemas and `tool_choice` were
  **not independently decisive** (probes B and E).
- The plugin nevertheless keeps layers 3 and 4, because the source shows the
  newer gate compares schemas and because other routes/versions enforce them.
  The cost is 5 tool declarations; the benefit is resistance to the gate
  tightening.

---

## 5. Wire reference

### 5.1 Request headers

Emitted by `buildHeaders(recipe, sessionId, requestId)`:

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `authorization` | `Bearer public` |
| `user-agent` | `<userAgent> deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | `global` |
| `x-opencode-session` | `ses_…` |
| `x-opencode-session-id` | `ses_…` |
| `x-session-affinity` | `ses_…` |
| `x-session-id` | `ses_…` |
| `x-opencode-request` | `msg_…` |

All four session headers carry the same value; `config.extraHeaders` is merged
last so a deployment can override or extend anything.

### 5.2 Identifier bit layout

```
value    = (Date.now() * 0x1000 + counter) & 0xFFFF_FFFF_FFFF      // 48 bits
counter  ∈ [0, 16], reset per millisecond tick
ses_id   = "ses_" + hex48(~value) + base62(random, 14)
msg_id   = "msg_" + hex48( value) + base62(random, 14)
```

```
 bit 47                bit 12 bit 11         bit 0
┌───────────────────────────┬──────────────────┐
│  timestamp (truncated)    │     counter      │
└───────────────────────────┴──────────────────┘
```

Notes:

- 48 bits cannot hold a full millisecond epoch (`ms << 12` exceeds 48 bits
  today), so the timestamp is effectively `ms mod 2^36` — a ~795-day cycle.
  This is harmless: the upstream decodes the same field with the same width,
  so consistency, not absolute time, is what matters.
- Validation regex: `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/` (`SESSION_ID_RE`).
- 14 base62 characters ≈ 83 bits of entropy, matching the CLI's suffix width.

### 5.3 Fingerprint tool definitions

`FINGERPRINT_NAMES = ['bash', 'glob', 'grep', 'read', 'shell']`.

`READ_TOOL` and `SHELL_TOOL` are transcribed **verbatim** from the official
client and must not be reworded. The comparison the plugin itself uses for
"is the caller's tool already canonical?" is exact:

```ts
tool.description === want.description &&
JSON.stringify(tool.parameters) === JSON.stringify(want.parameters)
```

`bash`/`glob`/`grep` are cheap stubs (`{type:'object', properties:{}}`) — they
exist only to satisfy the older quartet check.

### 5.4 Request body

Built in `OpenCodeFreeAdapter.stream()`:

```jsonc
{
  "model": "glm-5.3-flash-free",
  "messages": [ /* see 6.5 */ ],
  "stream": true,
  "tools": [ /* plan.tools — see 6.4 */ ],
  "tool_choice": "auto",
  "prompt_cache_key": "<session id without the ses_ prefix>",

  // conditional
  "max_tokens": 8192,          // options.maxTokens
  "temperature": 0.7,          // options.temperature
  "stop": ["..."],             // options.stop, when non-empty
  "reasoning_effort": "high"   // only when the catalog lists this effort for this model
}
```

`reasoning_effort` is guarded: it is sent only if the model's registry entry
publishes that effort value, so an unsupported level can never reach the wire.

---

## 6. Adapter design

### 6.1 The DSH LLM contract

`LlmAdapter` (from `@deepseek-ai/dsh-llm`) requires only:

```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

The plugin overrides four optional hooks:

| Hook | Why |
|---|---|
| `providerInfo(provider)` | Display name `OpenCode Bridge` for the GUI. |
| `listModels(provider)` | Catalog-driven model selector. |
| `resolveModel(provider, model, signal)` | Publishes `context.contextWindow`, `defaultMaxTokens`, and `reasoning.efforts`. |
| `prepareCall(provider, model, signal)` | Binds metadata and the stream entry point to one generation. |

`stream()` is an async generator: the runtime wraps thrown errors into a
terminal `error`/`aborted` finish, but this adapter also catches internally so
it can attach a stable failure code.

### 6.2 Registration and lifecycle

```ts
export const name = 'dsh-opencode-bridge'
export const inject = ['llm']
export function apply(ctx: Context, config: Config): void
```

Three registrations, each individually guarded so a missing optional API in an
older host degrades instead of throwing:

1. `ctx.llm.registerAdapter(providers, adapter)` → returns a disposer.
2. `ctx.llm.registerConfigurableProviders(...)` → settings-UI metadata
   (`displayName: 'OpenCode Bridge'`, `settingsNs: 'opencode-bridge'`).
3. `ctx.llm.registerModelDiscovery('opencode-bridge', fn)` → `id`, `name`,
   `contextWindow`, `maxTokens` per model.

Cleanup is Cordis-managed:

```ts
ctx.effect(() => () => { registration?.() })
```

The catalog's first load is kicked off fire-and-forget so plugin activation
never blocks on network I/O.

### 6.3 Stream chunk protocol mapping

Emitted sequence, obeying the DSH contract (usage before finish, finish last):

```
block-start{index, blockType:'text'|'reasoning'}
  text-delta{index, text} | reasoning-delta{index, text}
block-end{index, block:{type:'text'|'reasoning', text}}

block-start{index, blockType:'tool-call'}
  tool-call-delta{index, id, name, argumentsDelta}
block-end{index, block:{type:'tool-call', id, name, arguments}}

usage{usage}
finish{reason}
```

Details:

- **Interleaving.** `reasoning_content` and `content` arrive interleaved. The
  adapter keeps one open block; a kind switch closes it and opens the next, so
  block indexes are strictly monotonic and no block is emitted twice.
- **Tool calls.** Names/arguments are buffered by `tool_calls[].index`, not
  streamed to execution as fragments. After `finish_reason:'tool_calls'`, all
  calls must pass bridge checks before any tool-call block is emitted, sorted
  by index. `tool-call-delta` then carries each complete argument string.
- **Finish reason.** A validated emitted batch yields `tool-calls`. Any buffered
  tool call without `finish_reason:'tool_calls'` (EOF/length/stop) is
  `TOOL_BRIDGE_INCOMPLETE`, not a usable tool batch. Without calls, length yields
  `max-tokens`, otherwise `stop`. Aborts yield `aborted`; failures `error`.
  Previously streamed text/reasoning is not rolled back by tool rejection.

### 6.4 Safe tool bridge and collision-free planning (0.3.0)

`planTools(callerTools, { fingerprint })` returns:

```ts
{ tools, aliasToOriginal, decoys, callerNames, callerTools }
```

It reserves **all caller names before allocation**, including names appearing
later in the input, so `read_client` cannot accidentally become another tool's
alias. Duplicate caller names are rejected. With fingerprinting enabled,
noncanonical conflicts use `<name>_client`, `_client2`, …; exact canonical
caller definitions remain native, and only missing fingerprint names are
injected as decoys. With `toolFingerprint:false`, caller tools pass unchanged,
no aliases/decoys are added. This fixes the previous flag path that discarded
caller tools while still injecting declarations.

Actual requests plan from `GenerateOptions.tools`; auxiliary calls with
`options.purpose` use an empty caller set, not the global registry. With
fingerprinting on they receive admission declarations, but none can execute
without a current caller target. With it off the auxiliary set stays empty.

`normalizeToolCall` always runs, including with `toolTranslation:false`:

| Returned name | Policy |
|---|---|
| Caller alias | Restore original name; require JSON object arguments; preserve raw argument bytes. |
| Caller native name, including canonical `bash`/`shell` | Require JSON object arguments; otherwise pass unchanged to DSH's own schema/permission checks. |
| Injected `bash`/`shell` | Reject `EXECUTABLE_DECOY`; never guess Bash→PowerShell or another runtime. |
| Injected `read` | Only current caller `read`; `path`→`file_path`, optional `offset`/`limit`. |
| Injected `glob` / `grep` | Only same-named caller target; map `pattern`/`path` and grep `include`. |
| Unknown name | Reject `UNKNOWN_TOOL`. |

Read/search mappings require a known object schema and compatible required
fields. Source arguments must be an object with only known keys, string paths/
patterns, and nonnegative safe-integer offset/limit; mapped values must satisfy
the target's **conservative JSON Schema subset**. Supported checks cover types,
properties/required/additionalProperties, items, enum/const, oneOf/anyOf and
listed numeric/string/container bounds. Unknown constraints such as `$ref`,
`pattern`, `format` or `allOf` reject rather than disappear. This is not a full
JSON Schema validator; native caller tools receive only JSON-object validation
here, with complete schema validation and permissions left to DSH.

`toolTranslation:false` rejects read/search decoys as `TRANSLATION_DISABLED`
(and executable decoys remain rejected), but **still restores caller aliases**.
The model receives guidance to prefer caller aliases and native command wire
names such as `pwsh`, not the injected shell declarations.

The adapter buffers the whole tool-call batch until `finish_reason:tool_calls`,
then normalizes every call before emitting **any** tool-call chunk. Any bridge
rejection blocks all tool-call chunks in that response. EOF, `length` or `stop`
with tool fragments instead produces `TOOL_BRIDGE_INCOMPLETE`. Text/reasoning
already streamed is not rolled back. This is bridge-level atomic release, not
transactional tool execution or side-effect rollback: DSH can later reject a
native schema or permission constraint independently.

All execution stays in DSH. The plugin adds no exec/spawn or global HTTP patch.
“Read-only” names the read/search bridge routes, not a proof that an arbitrary
caller-provided same-named implementation has no side effects.

Cancellation is checked before the POST, after stream buffering and before
each tool chunk; cancellation must not release cached tool calls.

### 6.4.1 Offline current-agent scope audit

`opencode_bridge_audit` accepts `{}` or `{ "limit": 12 }`; limit is an integer
1–200, default 80. It calls only `tools.schemas(exec.agent)`. Missing agent
scope returns `AGENT_SCOPE_REQUIRED`; it never calls `schemas(undefined)` for a
global fallback. Results contain names, aliases, route decisions/reasons and
counts/truncation metadata, not descriptions, defaults, arguments or chat.
It performs no network requests and executes no tools.

The report basis is `current-agent-scoped-native-registry`. Code Mode/PTC and
auxiliary calls may expose a different set: the real request always plans again
from `GenerateOptions.tools`. An audit is not call history, an HTTP/model health
test, a full schema certificate, or a permission grant. Cancellation, invalid
limits and unavailable registries return fixed status/code fields without
service error text. See [the source comparison](docs/COMPARISON.zh.md) for
alternative implementations and the limits of differentiation claims.

### 6.5 Message projection

`buildChatMessages(options, plan)` maps DSH's message model to OpenAI chat
messages:

| DSH | Wire |
|---|---|
| `options.system` | leading `{role:'system'}` |
| `role:'system'` | `{role:'system'}` (text only) |
| `role:'developer'` | **dropped** — tool additions/removals are already projected into `options.tools`, and the wire request carries the complete declarations |
| `role:'tool'` | `{role:'tool', tool_call_id, content}`; empty content becomes `'(no output)'` |
| `role:'assistant'` | `{role:'assistant', content: text|null, tool_calls: [...]}`; tool names are re-cloaked through the alias map |
| user content | text joined; `image` → `[image omitted: the free-tier chat path is text-only]`; `file` → `[attached file]` |

Because this route is text-only, images and files are represented by explicit
placeholders rather than dropped silently — the model is told something was
there, and the user can see why the content is missing.

### 6.6 Session affinity

`sessionIdFor(options)` maps one DSH `sessionId` to one minted `ses_` id and
caches it, so a conversation keeps a stable session identity (and therefore a
stable `prompt_cache_key`) across turns. The cache is bounded at 64 entries,
evicting the oldest inserted key. Requests without a session id get a fresh id
each time.

### 6.7 Usage accounting

```ts
inputTokens  = prompt_tokens - cached_tokens        // clamped at 0
outputTokens = completion_tokens
cacheReadTokens = prompt_tokens_details.cached_tokens   // when non-zero
reasoningTokens = completion_tokens_details.reasoning_tokens  // when non-zero
```

The subtraction matters: DSH bills `inputTokens` as fresh input, so cached
prompt tokens are reported separately rather than double-counted. `usage` is
always emitted before `finish`.

### 6.8 Error taxonomy

HTTP failures become `LlmError` with a stable `code` (`httpError()`):

| Condition | Code |
|---|---|
| HTTP 401 | `AUTH` |
| HTTP 403 with `error.type == "FreeTierError"` | `FREE_TIER_GATE` |
| HTTP 429 | `RATE_LIMIT` |
| anything else | `PROVIDER_HTTP_ERROR` |

Also extracted: the upstream's `error.message` (surfaced verbatim — it explains
quota resets), `retry-after` / `retry-after-ms` (as `providerRetryAfterMs`),
and `x-opencode-log-id` (as `requestId`, for upstream support tickets), **only
when nonempty**. In 0.4.0 this fixes absent headers passing `requestId:null` to
`LlmError`, which previously masked real 429/401 HTTP failures as `STREAM_FAILED`.
Pool health/attempt `lastCode` may be `RATE_LIMIT`, an underlying transport code
such as `ECONNREFUSED`, `TIMEOUT`, or fallback `TRANSPORT_ERROR`. These are egress
state codes, not new outer LlmError types: exhausted transport errors still
surface as `TIMEOUT` (TimeoutError) or `STREAM_FAILED`; HTTP 503 stays
`PROVIDER_HTTP_ERROR` and does not trigger pool failover.

Stream-level failures:

| Condition | Result |
|---|---|
| `options.signal` aborted | `finish{kind:'aborted', failure:{code:'ABORTED'}}` |
| `DOMException.name === 'TimeoutError'` | code `TIMEOUT` |
| Bridge check rejection | `TOOL_BRIDGE_REJECTED`; fixed reason only, never arguments |
| Tool fragments without terminal `tool_calls` | `TOOL_BRIDGE_INCOMPLETE`; no tool-call chunks |
| any other throw | code `STREAM_FAILED` |
| mid-stream `{"error":…}` frame | `LlmError` with `PROVIDER_STREAM_ERROR` |

Bridge reason codes are `UNKNOWN_TOOL`, `TRANSLATION_DISABLED`,
`EXECUTABLE_DECOY`, `NO_CALLER_TARGET`, `UNSUPPORTED_TARGET_SCHEMA` and
`INVALID_ARGUMENTS`. Error text is fixed (`Tool bridge rejected call: <reason>`),
not a dump of names, schema values or arguments. Native malformed/nonobject JSON
also yields `INVALID_ARGUMENTS`; valid native raw JSON is not reserialized.

Timeouts are enforced with
`AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])`, so
caller cancellation and the request deadline both work, and the caller's signal
is never ignored.

### 6.9 Egress proxy pool (0.4.0)

[ProxyPool](src/proxy-pool.ts) owns ordered selection, per-egress cooldown and
store helpers; [ProxyService](src/proxy-service.ts) owns edits and probes.
The adapter's inference POST and relay catalog `GET /models` share this pool;
public models.dev metadata remains direct. No local proxy server is created.
`undici` is lazily imported only for proxy use; one CONNECT `ProxyAgent` is
cached per URL. No global fetch/dispatcher or HTTP hook is patched.

**Entries and selection.** `proxies:[]` defaults to direct. Empty strings,
`direct` and `none` select the machine's local egress. HTTP(S) URLs or bare
`host:port` are normalized/deduplicated, preserving order; other schemes,
including SOCKS, are rejected with a reason. Every request selects the first
ready configured entry, **not round-robin**, reusing a healthy egress for quota/
cache affinity. This is not a per-session binding; earlier entries regain
priority when cooldown expires. Different proxies may share a public IP.
An explicit proxy-only list does not silently add direct, but an empty pool or
removing its last entry restores direct; adding to a direct-only pool retains it.

| Event | State/action |
|---|---|
| HTTP 429 | Increment failures, set lastCode=RATE_LIMIT, cool entry, try another before streaming. |
| Pre-stream fetch/CONNECT/DNS/reset failure | Increment failures, record transport code, cool briefly and try another. |
| Other HTTP status (including 401/403/503) | Return immediately, no failover; pooled fetch clears cooldown/failure state on this transport response, not proof of inference success. |
| Cooldown elapsed | Entry is selectable again; failure count resets only on a non-429 pooled response/successful probe. |
| All entries cooling | Select earliest-to-recover for best effort, not immediate local hard failure. |

A pooled request budgets at most the pool size in attempts, without sleeping
until cooldown expiry. If attempts all throttle, the last 429 is returned; if
only transport attempts fail, the final exception is surfaced. This is not a
guarantee of fresh quota, distinct public IPs or eventual success.

For 429, positive numeric `retry-after-ms` takes precedence over numeric
`retry-after` seconds. HTTP-date is not parsed. Otherwise cooldown is
`base * 2^(failures-1)`, capped at `max(base,30min)` with the configured base
clamped to at least 1s (default 60s). Transport cooldown is `min(15s,base)`.
The probe and normal pooled requests share this header parser. Cooldowns/failure
counts are process-memory state; saved URLs, not health history, survive restart.

**Safe retry boundary.** Failover is limited to the fetch/response-status phase,
before handing a response body to the SSE reader. A 429 already has an HTTP
response; no successful streaming body has been exposed. Once a response is
returned to the adapter, any body/stream failure is reported without pool
replay, so already streamed text is not duplicated by this pool. This does not
prove that a timed-out POST was never computed upstream, nor govern Host retries.

**Persistence and credentials.** A valid settings JSON store wins over config
at startup, including an empty saved list (which resolves to direct). Missing/
unreadable/invalid store falls back to config; UTF-8 BOM is stripped before JSON
parsing (PowerShell/editor compatibility). Default path is
`(DSH_PROFILE_DIR || ~/.dsh)/data/dsh-opencode-bridge/proxies.json`; `proxyStorePath`
overrides it. Edits apply to the live pool first, then save; failed save is
reported and memory changes need not survive restart. The file contains raw
URLs, including **plaintext unencrypted proxy passwords**, readable by the
account; this code does not establish a dedicated secure ACL or secret store.

Health/log/UI display removes userinfo; stable IDs have the form
`proxy:host:port#<8-hex digest>`, not a literal password. A short digest is an
identifier, not encryption or a general anonymity guarantee. UI edits use
`{add}` / `{remove:id}` / `{reset:true}` instead of reading/reposting existing
credentials. Add necessarily sends the newly entered URL to the Host; the
input is not a password-masked field. Avoid screenshots or publishing the store.
The Host service also accepts full `{proxies}` replacement for owned values.

**Management/probes.** Settings holds a **single** `settings.section`
(id `opencode-bridge`, order 30, labelled “OpenCode Bridge”); two browser-style
tabs inside it separate “Diagnostic log” from “Egress rotation (optional)”, so one plugin no longer appears
as two unrelated entries. The proxy tab provides add/remove, Test all,
refresh, redacted addresses, ready/cooling with remaining seconds and lastCode.
Package-private RPC routes are `/api/opencode-bridge-proxies/{read,write,test}`.
Test all sequentially GETs relay `/models` per entry (8s timeout by default),
without prompts or completion requests; it can change health (429 cools it,
transport failure cools briefly, successful probe clears failures). It is a
reachability/status check, not model/tool/remaining-quota validation; network
traffic is still subject to provider rules. UI rendering and real RPC require
separate verification; an unauthenticated 401 on arbitrary `/api` paths proves
neither route registration nor handler success.

Only HTTP(S) CONNECT is supported, not SOCKS, automatic proxy discovery,
per-session affinity or a paid/alternate-model fallback. Upstream quota may
also depend on non-IP signals. Use authorized egresses and respect service limits.

---

## 7. Catalog design

`FreeModelCatalog` answers "which free models exist right now?" from two
independent sources:

| Source | Provides | Cache |
|---|---|---|
| `https://models.dev/api.json` → `.opencode.models` | limits, modalities, reasoning efforts, per-model API base, deprecation status | 10 min in memory |
| `GET {baseUrl}/models` (anonymous) | live availability | same refresh cycle |

Both sources are fetched together and share one 10-minute in-memory cache
(`fetchedAt`). There is no on-disk cache: a host restart re-fetches. The
registry's own upstream refresh cadence is irrelevant here, because this
plugin only reads its published snapshot.

Merge rule — a model is offered when **all** hold:

1. `cost.input === 0` (zero-cost in the registry), and
2. `status !== 'deprecated'` (unless `includeDeprecated`), and
3. it is present in the live listing (when that listing was reachable).

Then two escape hatches:

- `config.extraModels` ids are always force-added.
- Unknown ids present live and matching `/(-free$|^big-pickle$)/` are surfaced,
  so a model that ships before the registry catches up is still usable.

`list()` **never throws**. On a failed refresh it logs and serves the cache; if
the cache is empty it backdates its timestamp by 5 minutes so a burst of
callers cannot hammer a failing endpoint.

Field mapping:

```
limit.context            → contextWindow   → resolveModel().context.contextWindow
limit.output             → maxOutputTokens → resolveModel().defaultMaxTokens
modalities.input         → inputModalities
reasoning_options[type=effort].values → efforts → resolveModel().reasoning.efforts
provider.api             → api             → per-request chat endpoint override
```

---

## 8. Configuration reference

Schemastery-validated; every key has a working default, so the plugin runs
keyless and config-free out of the box.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `baseUrl` | string | `https://opencode.ai/inference/v1` | Relay base for catalog + chat. |
| `apiKey` | string | `public` | Sent as `Bearer <key>`; the signed-out sentinel. |
| `userAgent` | string | `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` | Must contain a current `opencode/<version>`. |
| `client` | string | `cli` | `x-opencode-client`. |
| `project` | string | `global` | `x-opencode-project`. |
| `providers` | string[] | `['opencode-bridge']` | Provider routes served by this adapter. |
| `includeDeprecated` | boolean | `false` | Offer deprecated-but-still-live models. |
| `extraModels` | string[] | `[]` | Force-add model ids. |
| `requestTimeoutMs` | number | `600000` | Per-request deadline. |
| `proxies` | string[] | `[]` | Direct-only default; ordered HTTP(S) CONNECT proxy/direct entries; saved store wins at startup. |
| `proxyCooldownMs` | number | `60000` | Base 429 cooldown, clamped to at least 1s; exponential escalation. |
| `proxyStorePath` | string | `''` | Empty uses `$DSH_PROFILE_DIR` (or `~/.dsh` if unset) + `/data/dsh-opencode-bridge/proxies.json`; plaintext URL/credential store. |
| `toolFingerprint` | boolean | `true` | Add fingerprint declarations and cloak conflicts; false preserves caller tools and adds no decoys. |
| `toolTranslation` | boolean | `true` | Enable conservatively validated read/search decoys; false rejects decoys but still restores caller aliases. Injected shell is always rejected. |
| `logLevel` | string | `warn` | Minimum level written to disk: `debug`\|`info`\|`warn`\|`error`\|`off` (`off` disables file logging). |
| `logDir` | string | `''` | Log directory; empty = `<DSH_PROFILE_DIR or ~/.dsh>/logs/dsh-opencode-bridge` (the Host process usually has no `DSH_PROFILE_DIR`, so in practice `~/.dsh/logs/dsh-opencode-bridge`). |
| `logMaxBytes` | number | `524288` | Per-file size ceiling in bytes before rotation. |
| `logMaxFiles` | number | `5` | Total files kept (active + rotated); the **oldest is deleted first** on overflow. |

Overriding config in a profile is whole-row replacement (no deep merge), so an
override row must restate every key it wants to keep.

**0.4.0 migration (route and identifier rename).** The provider route changed
from `opencode-free` to `opencode-bridge`, and the plugin row id is now
`dsh-opencode-bridge`:

1. If a profile override row sets `providers: [opencode-free]`, change it to
   `providers: [opencode-bridge]`; omitting it picks up the new default.
2. If you use `dsh-opencode-free` as the default model provider (for example in
   `agent-default-model`), point the provider at `opencode-bridge` and prefix
   model ids with `opencode-bridge/`.
3. Sessions that already selected an `opencode-free/*` model do not follow the
   rename; pick the model again once.
4. The default log directory moves from `~/.dsh/logs/dsh-opencode-free` to
   `.../dsh-opencode-bridge`; move it manually if you want the old lines kept.
5. The proxy-pool store likewise moves to
   `~/.dsh/data/dsh-opencode-bridge/proxies.json`.

---

## 9. Compatibility

Verified against this framework generation:

| Package | Version |
|---|---|
| `@deepseek-ai/dsh-llm` | `0.2.0-rc.2` |
| `@deepseek-ai/cordis` | `4.0.4` |
| `@deepseek-ai/schemastery` | `3.18.4` |

Peer dependencies are declared with `peerDependenciesMeta.optional = true` so
the bundle installs into a profile without hoisting a second copy of the
framework.

The runtime requires **Node ≥ 20.3** (declared as `engines.node`): the adapter
merges caller cancellation with the request deadline via `AbortSignal.any`,
which only exists from Node 20.3. Older runtimes are unsupported and are not
blocked by the installer.

API differences that already bit this plugin — worth checking on any framework
upgrade:

1. **`CallId` → `ToolCallId`.** The branded id type was renamed; `ToolCallId(v)`
   is the constructor.
2. **Tool results are messages, not blocks.** In 0.2.0-rc.2 the content-block
   union is `text | image | reasoning | file | tool-call | tool-addition |
   tool-removal`; a tool result is a first-class `role: 'tool'` message
   (`ToolResultMessage` with `toolCallId` and `isError`). An adapter written
   against the older block-shaped model will not compile.
3. **`GenerateOptions.system`** exists for one-shot callers, while loop-built
   requests carry the system prompt as a leading system-role message. The
   adapter handles both.

---

## 10. Operational playbook

### Symptom → cause → action

| Symptom | Likely cause | Action |
|---|---|---|
| `403 FREE_TIER_GATE` returns | The gate moved (new UA floor, changed id scheme, schema diff) | Update the constants in `src/opencode-protocol.ts` (below), then rebuild + repack. |
| `401 AUTH` | The `Bearer public` sentinel changed | Check the client's signed-out path; update `apiKey`. |
| `429 RATE_LIMIT` | Selected egress throttled; other quota dimensions are possible | Pool cools it and tries another within budget; if exhausted, wait/check Retry-After and configured authorized egresses. |
| HTTP 503 / Endpoint is unavailable | Inference endpoint unavailable; root cause not isolated | No pool rotation on 503; do not equate it with IP quota or promise another proxy fixes it. |
| Pool lastCode ECONNREFUSED/TIMEOUT/TRANSPORT_ERROR | Pre-stream connection/transport failure | Check proxy reachability; short cooldown permits another egress. Body failures do not replay. |
| Model missing from the selector | Registry/live mismatch | Add the id to `extraModels`, or set `includeDeprecated: true`. |
| `TOOL_BRIDGE_REJECTED` | Unknown/executable decoy, disabled translation, unsupported schema, missing target or invalid JSON/values | Read the fixed reason; run scoped `opencode_bridge_audit`; prefer caller aliases/native pwsh. Never bypass refusal by guessing another shell. |
| `TOOL_BRIDGE_INCOMPLETE` | Tool fragments ended with EOF/length/stop rather than tool_calls | No tool-call chunks were released; inspect upstream truncation/finish handling. |
| DSH rejects a restored native call | Host schema/permissions differ from the model's arguments | Check the caller's actual tool contract; bridge object validation does not replace host policy. |

### How to re-derive the gate

1. Probe the endpoint directly and diff against a working recipe — start from
   `tests/smoke.mjs`, which exercises the whole path.
2. Read the current client source: `packages/core/src/plugin/provider/opencode.ts`,
   `packages/core/src/session/model-request.ts`, `packages/ai/src/providers/opencode.ts`.
3. Change one variable at a time (UA version → id scheme → tool schemas) and
   record the status codes. The probe matrix in section 4.6 is the template.
4. Update `opencode-protocol.ts`, run `tests/wire-dump.mjs` to confirm the wire
   value, then `tests/smoke.mjs` for a live completion.

---

## 11. Testing and verification

| Command | What it does |
|---|---|
| `pnpm build` | `tsc -p tsconfig.json` → `lib/` (ESM + `.d.ts`). |
| `pnpm typecheck` | Same compiler, `--noEmit`. |
| `pnpm test` | `node --test tests/*.test.mjs` — offline bridge/audit/batch/cancellation, proxy pool/rotation, logging and mock client activation regressions. |
| `node tests/proxy-live.mjs [proxyUrl] [model-id]` | Real CONNECT/direct relay GET probes plus a fixed-marker synthetic completion; needs network and completion quota. Not a deliberate 429 stress test. |
| `node tests/wire-dump.mjs` | Prints `attributionSuffix()`, `buildHeaders()`, `SESSION_ID_RE`, and the planned tool names — the fastest way to confirm the wire fingerprint without network I/O. |
| `node tests/smoke.mjs [model-id]` | Full live path: id regex + low-12-bit invariant, tool plan/alias/translation, live catalog, real streaming completion. |

**Verification scope:** [tool-bridge tests](tests/tool-bridge.test.mjs) and
[bridge integration tests](tests/bridge-integration.test.mjs) cover caller-name
reservation, config switches, schema rejection, native JSON-object checks,
agent-scoped audit and atomic mock-SSE batches (including incomplete finishes).
[Cancellation regressions](tests/bridge-cancellation.test.mjs) cover pre-POST,
buffered calls and cancellation while yielding tools.
Logging/client tests are offline too. `tests/wire-dump.mjs` is an offline dump;
`tests/smoke.mjs` is a live network/quota-consuming probe. Test existence or an
offline pass is not proof of every model, real tool dispatch, or Desktop startup.
Final release verification results should be recorded separately, without
recasting the historical gate observations as a fresh full acceptance run.

### 0.4.0 verification record (2026-10-18)

- Compilation succeeded; **66/66 offline tests** passed (11 proxy-pool cases,
  6 adapter proxy-rotation cases). These exercise policy under controlled inputs,
  not live 429 quota exhaustion.
- Real relay `GET /models` returned 200 through an authorized local HTTP CONNECT
  proxy (847ms) and direct (2384ms), proving real relay traffic traversed the
  tunnel. This does not prove completion availability or proxy authentication.
- The Host re-mounted `0.4.0` with `application: applied`. In this Host,
  `DSH_PROFILE_DIR` was unset: the default store base was `~/.dsh`. Writing a store
  in the UI's format and reloading produced `egress pool ready` with
  `source:settings-store` and the test proxy/direct entries, demonstrating real
  store→reload→pool loading (not a browser-save test).
- That test found UTF-8 BOM files silently falling back to config; loading now
  strips BOM, covered by the store round-trip test. The test store was then
  removed and the plugin reloaded: default remains **direct only**, with no
  preconfigured local proxy or remaining test store.
- Synthetic fixed `PROXY_OK` completions over both direct and proxy returned
  **HTTP 503 / Endpoint is unavailable**, not PROXY_OK. No cross-model retries
  or causal isolation were performed; end-to-end inference did not pass.
- Real 429 failover was not deliberately triggered to avoid exhausting free
  quota; its correctness is supported by offline tests, not an online 429 run.
  Browser rendering remains unverified. Host authentication returns 401 even for
  unknown `/api` paths, so external 401 probes do not verify RPC registration.

### 0.3.0 verification record (2026-10-18)

- Compilation succeeded; **49/49 offline tests** passed, including bridge,
  cancellation, scope, logging and mock client activation coverage.
- Plugin Manager re-mounted `0.3.0` with `application: applied`. A real
  `opencode_bridge_audit({limit:8})` invocation succeeded: the observed agent had
  41 caller tools, 3 aliases, 3 candidate mappings and 2 executable-decoy
  rejections. These counts describe that sample, not a fixed inventory.
- Pack dry-run exited 0 and included the new modules/comparison, not `research/`.
- One synthetic `glm-5.3-flash-free` smoke read 10 live catalog entries, but the
  inference POST returned **HTTP 503 / Endpoint is unavailable**, no `SMOKE_OK`,
  and exit 1. No cross-model retries or policy-guidance A/B isolation were run;
  this result does not establish the cause of the 503.
- Therefore this round does **not** claim end-to-end inference or full
  Desktop/UI acceptance; offline regressions and the real audit entry passed.

An end-to-end acceptance run has two parts:

1. **Wire level** — `tests/smoke.mjs` returns `finish{kind:'stop'}` with
   non-empty text and a valid `ses_` id.
2. **Host level** — inside a running DSH profile, a one-shot model call routed
   through provider `opencode-bridge` returns the expected answer, proving the
   adapter is registered, discovered, and reachable through `LlmRuntime`.

---

## 12. Security, privacy, attribution

- **Keyless by default.** The plugin does not discover keychain/environment
  credentials. It sends `Bearer public` by default, or the explicit configured
  `apiKey`; such configured values must be treated as secrets.
- **Attribution is preserved, not removed.** DSH's contract requires every
  provider request to identify the harness. The plugin satisfies it — product
  name and project URL are advertised — and strips only the version component,
  because a versioned foreign product token is rejected by the gate. This is
  the minimum deviation that satisfies both constraints, and it is the reason
  `attributionHeaders()` is imported and transformed rather than bypassed.
- **No extra telemetry.** The plugin sends nothing beyond the request itself:
  no analytics, no phone-home, no logging of prompt content. `prompt_cache_key`
  is the session id with its prefix stripped — a stable per-conversation
  cache token, not an intentionally embedded user identifier. Stable identifiers
  and metadata can still enable correlation; this is not an anonymity guarantee.
- **Content leaves the machine.** Prompts go to `opencode.ai`, subject to their
  terms and retention. Users should not send material they would not send to a
  third-party relay.
- **Terms of service.** This plugin deliberately presents itself as the official
  client in order to use a tier that is gated to that client. That is the whole
  point of the project and also its main caveat: it is intended for personal,
  experimental use, upstream rate limits apply, and it is not affiliated with
  OpenCode or DeepSeek. Operators who need a supported path should use the paid
  console API instead.
- **Upstream visibility.** The gate is server-side and can change or be
  enforced differently at any time; the plugin's own diagnostics
  (`FREE_TIER_GATE`, verbatim upstream messages) exist so failures are
  self-explanatory rather than mysterious.

---

## 13. Known gaps and roadmap

1. **Conservative bridge, bounded evidence.** Tool planning/bridge/audit and
   mock-stream regressions now exist, but there is no full model/Host/UI matrix
   or complete protocol formal verification. Unknown schema constraints fail
   closed, causing legitimate tools to be rejected; native full-schema and
   permissions remain Host-owned. Tool calls wait for the whole response batch,
   adding latency. The scoped audit is not necessarily the PTC/aux request set,
   does not inspect actual call history, and grants no permission. Read/search
   route names do not certify an arbitrary implementation is side-effect-free.
2. **Text-only content path.** Images and files are placeholders. Some free
   models advertise `image` input in the registry; when the relay serves
   multimodal chat, `buildChatMessages` should emit real content parts. The
   registry already publishes `inputModalities`, so the adapter can decide
   per model.
3. **Response-side reasoning.** Only `reasoning_content` is recognised. Other
   providers' spellings (`reasoning`, `thinking`) are not parsed.
4. **Narrow egress failover, not general retry.** The pool retries only 429 or
   pre-stream transport failure within its attempt budget; 401/403/503 and body
   failures do not rotate. Other Host retry policy remains separate. Only
   HTTP(S) CONNECT is supported, not SOCKS. Selection is ordered healthy reuse,
   not per-session binding; earlier recovered entries take priority. Credentials
   are plaintext on disk; numeric Retry-After only, and quota may not be IP-only.
5. **Single-tier default.** Only zero-cost models are offered; there is no
   switch to opt into paid console models.
6. **Session cache is process-local.** A restarted host mints new `ses_` ids for
   existing conversations, so upstream prompt-cache affinity is lost across
   restarts.

---

## 14. Change log

Every feature addition/removal or technical-principle change must append one
line here (see the chapter 0 policy).

| Date | Version | Change | Chapters affected |
|---|---|---|---|
| 2026-10-18 | 0.4.1 | **Patch release preparation**: bump the package version and synchronize the pinned installation command and local tarball example in both READMEs; preserve historical feature versions and verification records. | 0, 14, READMEs |
| 2026-10-18 | 0.4.0 | **Settings merged and renamed**: the former log and proxy `settings.section` entries became one `opencode-bridge` page with two tabs, and the display name changed from “OpenCode Free” to “OpenCode Bridge” (`locale` title, `providerInfo`, `displayName`, settings nav). | 3, 6.2, 6.9, 15.4 |
| 2026-10-18 | 0.4.0 | **Route and identifier rename**: provider route `opencode-free` → `opencode-bridge` (default `providers`, model discovery, `settingsNs`), plugin row id and exported name → `dsh-opencode-bridge`, RPC namespaces → `/api/opencode-bridge-{logs,proxies}/*`, tool `opencode_free_log` → `opencode_bridge_log`, log directory/file and proxy store → `dsh-opencode-bridge`. Sessions that already selected an `opencode-free/*` model must re-pick it; no profile configuration needed migrating (see chapter 8). | 0, 3, 6.2, 6.9, 8, 11, 15 |
| 2026-10-18 | 0.4.0 | **Default log level is now `warn`** (was `info`): both the `Config.logLevel` default and the invalid-value fallback became `warn`, and the Settings dropdown starts on `warn`, so less is written by default. | 8, 15 |
| 2026-10-18 | 0.4.0 | **Repository hygiene**: `research/` stays unpublished (third-party sources and binaries); the two original analysis notes were curated into `docs/research-notes/` and versioned; removed duplicate upstream tarballs and an unused `bun.exe` (~92 MiB). | Appendix A |
| 2026-10-18 | 0.4.0 | **Runtime requirement**: declares `engines.node: ">=20.3"` (needed for `AbortSignal.any`); both READMEs' development sections state the Node version and that `lib/` is generated, so `pnpm build` comes first. | 9, Appendix A |
| 2026-10-18 | 0.4.0 | **Release rule**: chapter 0 now requires a version bump to update the install command and tarball example in both READMEs, guarded by `tests/readme-version.test.mjs` (both must equal `package.json`); READMEs now use `dsh plugin --profile desktop add dsh-opencode-bridge@<version>`. | 0, 11, Appendix A |
| 2026-10-18 | 0.4.0 | **Egress proxy rotation**: ordered healthy reuse, per-egress 429/transport cooldown, pre-stream-only failover, lazy undici CONNECT agents; proxy settings panel and plaintext URL store persistence with BOM-tolerant loading. Fixed absent `x-opencode-log-id` passing requestId:null to LlmError, so HTTP 429/401 retain RATE_LIMIT/AUTH instead of STREAM_FAILED. Added proxy pool/adapter regressions and opt-in live probe; no global HTTP patch. | 1–3, 6.8–6.9, 7–14, Appendix A |
| 2026-10-18 | 0.3.0 | **Safe bridge**: reserve every caller name before aliasing; preserve caller tools when fingerprinting is off; always restore aliases; reject executable/unknown decoys and unsupported schemas; require native JSON objects; validate an entire completed tool batch before releasing any tool chunks, without execution rollback. | 0, 3, 6, 8, 10–13 |
| 2026-10-18 | 0.3.0 | **Offline scope audit**: optional `opencode_bridge_audit` uses only `tools.schemas(exec.agent)` with bounded names/aliases/route decisions; no global fallback, chat/arguments/schema-description export, network or execution. Added bridge/audit regression suites and fixed-HEAD source comparison; narrowed privacy/rotation and Desktop verification claims. | 3, 6.4.1, 11–15, Appendix A |
| 2026-10-18 | 0.2.1 | **Release prep**: npm package name set to `dsh-opencode-bridge` (unscoped `dsh-opencode-free` is taken by another author; the scoped name lacked distinction, so renamed to evoke the protocol bridge); `client.js` module id and `cordis.patch.yml` `name` follow the package name (row `id` unchanged); added LICENSE, `.gitignore`, `prepack` build hook; removed the settings log-viewer pitch from the plugin description. | 3, 14, Appendix A |
| 2026-10-18 | 0.2.1 | **Client activation hardening**: per-step try/catch, optional service access, locale registration before binding, no `immediately:true`; added hostile-ctx regression tests. These tests cover mocked activation, not proof of Desktop crash reproduction/root cause or live recovery. | 3, 15.6 |
| 2026-10-18 | 0.2.0 | Added leveled logging (redaction + size-based rotation that cleans oldest first), a DSH Settings log view/copy UI, and the `opencode_bridge_log` agent tool; established the documentation maintenance policy. | 0, 3, 8, 11, 13, 14, 15 |
| 2026-10-17 | 0.1.0 | First release: three-layer gate reproduction, `OpenCodeFreeAdapter`, free-model catalog, tool cloaking/translation. | 1–13 |

---

## 15. Logging and diagnostics

Goals: useful metadata-only diagnostics, best-effort redaction and rotation.
Call sites must not intentionally log credentials, user messages or arguments.
These are engineering rules, not proof of zero sensitive information or a strict
disk-byte cap; review logs before sharing, especially raw upstream errors.

### 15.1 Levels and output

`PluginLogger` in `src/logger.ts` offers `debug / info / warn / error`
(`logLevel` sets the write floor; `off` disables file output). Line format:

```
2026-10-18T02:17:05.003Z [INFO ] [adapter] completed {"model":"glm-5.3-flash-free",...}
```

Timestamp (ISO) + level + scope + message + optional JSON data. Scopes:
`plugin` (entry/registration), `adapter` (per model call), `catalog` (model
catalog), `log-service` (log operations themselves).

Call-site rule: **metadata only** — model name, message/tool counts, token
usage, status codes, durations, session/request ids. Never message content,
tool arguments, or full request bodies.

### 15.2 Redaction (three backstops against leaks)

`PluginLogger.redact()` provides heuristic backstops, not exhaustive detection:

1. **Literal secrets**: values injected at construction (`secrets`, currently
   `config.apiKey`) are replaced verbatim with `[redacted]`;
2. **Token shapes**: `Bearer <token>` and long `sk-…`/`key-…`/`token-…`/
   `secret-…` literals become `[redacted]`;
3. **Truncation**: any string over 2000 characters is cut and marked
   `…[truncated]`.

String/serialized values in `data` pass through `redact()`; known secrets
shorter than four characters are not registered, and arbitrary sensitive text
may not match the heuristics. Truncation is not redaction. The tested rules
([logger tests](tests/logger.test.mjs)) are examples, not a universal privacy proof.

### 15.3 Rotation and automatic cleanup

Before append, a threshold check against `logMaxBytes` (default 512 KiB)
triggers `dsh-opencode-bridge.log` → `.1` → `.2` …, attempting oldest-first cleanup
under `logMaxFiles` (default 5). This is best-effort retention, **not** the strict
bound `logMaxBytes × logMaxFiles`: an oversized line may exceed the threshold,
rotation/deletion may fail, and the one-file setting has a `.1` edge case.
Startup prunes numbered siblings up to its fixed scan limit. Disk failures are
swallowed; a 200-line memory ring remains available. Do not rely on this as a
storage quota or secure erasure mechanism.

### 15.4 One implementation, two callers

`LogService` in `src/log-service.ts` is the single implementation of
read/clear/set-level:

- **Settings UI** (`client.js`): registers into the `settings.section` slot
  (Settings page “OpenCode Bridge” → “Diagnostic log” tab) with level filtering, refresh, **copy all**
  (Clipboard API with an `execCommand` fallback), and clear (with
  confirmation). Data comes from the package-private JSON RPC
  `/api/opencode-bridge-logs/{read,stat,clear,level}` — the same
  `connection.fetch.register` / `connection.rpc.call` channel a verified
  shipped plugin uses (see `dsh-tool-antigravity`).
- **Agent tool `opencode_bridge_log`**: `action: read|stat|clear|level`, backed
  by the same `LogService`, so the model can pull its own diagnostics. The log
  uses best-effort redaction; review it before sharing or putting it into context.

The UI is browse/copy only (it changes no configuration), so no agent path
mutates config — `level` changes runtime verbosity only and the configured
level returns after restart.

### 15.5 Display resources

`locale/{en,zh}.json` carry the plugin title and description; `icon.svg` is an
original mark (two nodes, a bridging arc, a spark — "protocol bridge").
`package.json` `exports`/`files` include `client.js`, `locale/*.json`, and
`icon.svg`; `dsh.client` declares `platform: web` plus the four client
dependency packages. **Note: `dsh.client` must NOT set `immediately: true`** —
it forces module activation early in web-boot, before the `settings.section`
slot may be declared (see 15.6).

### 15.6 Client-module robustness rules (0.2.1 activation hardening)

Activation exceptions can break client startup. The defensive changes below
address missing/throwing services and activation ordering; mocked regression
tests do **not** establish a particular Desktop crash root cause or prove a
live Desktop restart/recovery. Obtain actual client logs and a controlled
reproduction before making such claims.

**Risks addressed:**

1. Binding an unregistered locale namespace may throw; register before binding.
2. Unguarded slot/service access may fail when unavailable; early forced
   activation can race slot declaration. Avoid `immediately:true`.

**Defensive rules** (mandatory when editing `client.js`; enforced by
`tests/client-boot.test.mjs`):

1. **`apply()` must never throw** — each step (locale / rpc / slot
   registration) has its own try/catch; failures only `console.error`, never
   propagate;
2. **All service access is optional-chained with a fallback** — `ctx.slots`,
   `ctx.locale`, `ctx.get('connection')` may be missing or not yet available;
   the panel shows "Log service unreachable" instead of crashing;
3. **Register the locale namespace before binding it**; fall back to the
   built-in zh/en dictionary translator if registration fails;
4. **No `immediately: true`** — on-demand activation avoids racing the host's
   slot declarations;
5. The component reads props and statics with a double fallback
   (`props.t || LogPanel.t || fallback`).

The regression tests simulate hostile ctx shapes (all services missing;
`bind`/`register`/`inject`/`get` each throwing) and assert `apply()` never
throws while the settings page still registers when possible. **After any
`client.js` change, run**: `node --test tests/client-boot.test.mjs`.

---

## Appendix A — repository inventory

```
package.json              manifest; dsh.bundle.patch → cordis.patch.yml; dsh.client → client.js
tsconfig.json             ES2022 / Node16 / strict, src → lib
cordis.patch.yml          bundle layer patch (insert row)
.npmrc                    auto-install-peers=false
src/index.ts              plugin entry (Config, apply, registrations, logging wiring)
src/opencode-protocol.ts  gate constants, ids, headers, tools, messages
src/adapter.ts            LlmAdapter; atomic bridge-level release of completed tool batches
src/tool-bridge.ts        conservative schema subset, read/search mapping, executable-decoy refusal
src/bridge-audit.ts       offline current-agent scoped native-registry audit
src/proxy-pool.ts         ordered egress/cooldown/store and lazy CONNECT dispatchers
src/proxy-service.ts      live proxy edits, health, GET probes and RPC
src/catalog.ts            free-model catalog
src/logger.ts             leveled logger (redaction, rotation, memory fallback)
src/log-service.ts        LogService + RPC routes + agent tool
client.js                 Settings log and proxy-management panels (browser module)
locale/en.json, zh.json   plugin title/description (display checklist)
icon.svg                  original plugin icon
lib/                      tsc output (published)
tests/logger.test.mjs     logging module hermetic unit tests
tests/tool-bridge.test.mjs planning, collision, flags, schema/JSON and decoy refusal tests
tests/bridge-integration.test.mjs scoped audit and atomic mock-stream batch tests
tests/bridge-cancellation.test.mjs preflight/buffered/yield cancellation regressions
tests/proxy-pool.test.mjs  entry/health/ordered selection/store/cooldown tests
tests/proxy-rotation.test.mjs adapter failover and no mid-stream replay tests
tests/proxy-live.mjs      optional real CONNECT/direct metadata and synthetic inference probe
tests/readme-version.test.mjs README install-command/tarball version guard
docs/COMPARISON.zh.md     fixed-HEAD source comparison and evidence boundaries
docs/research-notes/      publishable research notes (own analysis; no third-party sources)
tests/smoke.mjs           live end-to-end probe
tests/wire-dump.mjs       offline wire fingerprint dump
research/                 reverse-engineering artifacts (not published)
README.md / README.zh.md  user documentation
TECHNICAL.md / .zh.md     this document
```

Build output is ESM with declarations; `package.json` `main`/`types` point at
`lib/index.js` / `lib/index.d.ts`, and `files` limits the tarball to `lib/`,
`client.js`, the patch, locales, the icon, and the documentation. Note that
`client.js` is **not** a tsc product — it is a hand-written browser
`__ModuleLoader__` module shipped as-is.

## Appendix B — observed free models (2026-10 snapshot)

```
beam-free                        mimo-v2.6-flash-free
big-pickle                       nemotron-3.5-lightning-free
deepseek-v4.1-flash-free         nemotron-3.5-super-vl-free
glm-5.3-flash-free               space-bunny-free
jev-1.13-free                    longcat-2.5-preview-free
```

The set is volatile: probes earlier in 2026-10 saw 13 ids, later 10 (with
`ll-alpha-free`, `muse-spark-1.2-contributor-free`,
`muse-spark-1.3-contributor-free` gone). Never hard-code the list — always ask
the catalog.

Non-`-free` ids that the relay lists (for example a bare `test` entry) are
filtered out by the unknown-id pattern in section 7 unless explicitly
configured via `extraModels`.

Live probes also confirmed the per-model endpoint override (section 4.5):
`glm-5.3-flash-free`'s registry entry resolves its chat path to
`/inference/openai/v1/chat/completions`, not the configured default.

## Appendix C — glossary

| Term | Meaning |
|---|---|
| **relay** | The opencode.ai inference proxy that fronts the free and paid models. |
| **free tier** | The keyless model set, gated to the official client. |
| **fingerprint** | The set of client-identifying properties (UA, id encoding, tool declarations, body flags) the gate inspects. |
| **decoy** | A fingerprint tool declaration appended to the request that the caller did not ask for. |
| **cloaking** | Sending a caller tool under an alias (`read_client`) to avoid colliding with a fingerprint name. |
| **translation** | Rewriting a decoy tool call onto a caller tool, including its argument names. |
| **StreamChunk** | DSH's raw streaming protocol vocabulary emitted by adapters. |
| **effort** | A named reasoning level published by the registry and selected per model. |
