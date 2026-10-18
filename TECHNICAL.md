# dsh-opencode-bridge — Technical Design

[中文](TECHNICAL.zh.md) | English

Engineering documentation for the `dsh-opencode-free` DSH plugin: how the
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
4. the build/pack/publish flow or a DSH dependency version changes.

Record every such change in chapter 14 "Change log" — one line per change,
written as part of the same commit. **Never leave a "code changed, docs stale"
commit.**

### AI handover guide (start here)

You are an AI taking over this repository? Build context in this order before
touching code:

1. **Read this section and chapters 1–2** — what the plugin does and where it
   attaches to DSH.
2. **Read chapter 3, the module map** — `opencode-protocol.ts` is the single
   home of gate constants; **change protocol behavior only there**. Keep
   adapter/catalog/logger within their own boundaries.
3. **Before editing, read chapter 4 (the gate) and chapter 5 (the wire)** —
   this is the highest-risk area: one wrong constant turns every request into
   a 403.
4. **After changes, always run**: `node node_modules/typescript/bin/tsc -p
   tsconfig.json` (build), `node --test tests/*.test.mjs` (unit tests),
   `node tests/smoke.mjs` (live probe; needs network — see chapter 10 for what
   429/403 mean).
5. **Before finishing, apply the maintenance policy above** and update this
   document plus the change log.
6. Logging/diagnostic questions belong to chapter 15; the settings-panel UI
   lives in `client.js` (a browser `__ModuleLoader__` module, not TypeScript —
   see 15.3).
7. **Read 15.6 before touching `client.js`**: an uncaught exception from
   `apply()` crashes all of DSH Desktop (web-boot treats activation failure as
   fatal). After any change run `node --test tests/client-boot.test.mjs`.

---

## 1. Scope and positioning

| | |
|---|---|
| **Goal** | Make the keyless OpenCode free-tier models selectable as first-class DSH models. |
| **Non-goal** | Paid OpenCode models (they need an OpenCode Console account and a console-issued key). |
| **Mechanism** | An `LlmAdapter` that speaks the official OpenCode client's wire protocol to the opencode.ai relay. |
| **Credential** | None. The relay accepts the signed-out sentinel `Bearer public`. |
| **Distribution** | npm bundle with a `cordis.patch.yml` layer patch. |

The plugin never proxies through a local server; it is a pure in-process adapter.

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

The plugin occupies exactly two seams of the DSH LLM service:

1. **`ctx.llm.registerAdapter(providers, adapter)`** — supplies the provider
   route (`opencode-free`) and the streaming implementation.
2. **`ctx.llm.registerModelDiscovery(id, fn)`** — supplies the GUI's model list.

It does not touch sessions, tools, or the agent loop.

---

## 3. Module map

| File | Lines | Responsibility |
|---|---:|---|
| `src/index.ts` | 174 | Cordis plugin entry: `name`, `inject`, Schemastery `Config`, `apply()`, registrations, disposer. |
| `src/opencode-protocol.ts` | 375 | **All gate-sensitive constants.** ID minting, header recipe, verbatim fingerprint tools, tool cloaking/translation, message projection. |
| `src/adapter.ts` | 361 | `OpenCodeFreeAdapter`: model metadata, request assembly, SSE parsing, `StreamChunk` emission, error taxonomy. |
| `src/catalog.ts` | 143 | `FreeModelCatalog`: models.dev ∪ live listing, caching, degradation. |
| `src/logger.ts` | 326 | `PluginLogger`: levels, redaction, size-based rotation (oldest-first cleanup), memory fallback. See chapter 15. |
| `src/log-service.ts` | 245 | `LogService` + RPC routes + the `opencode_free_log` agent tool (one implementation, two callers). |
| `client.js` | 321 | Settings log viewer/copy panel (browser module, not a tsc product). See 15.3, 15.6. |
| `cordis.patch.yml` | 4 | Bundle layer patch that inserts the plugin row. |
| `tests/logger.test.mjs` | — | Hermetic unit tests for the logging module (levels/redaction/rotation/read). |
| `tests/client-boot.test.mjs` | — | Client-module activation regression tests (apply never throws; 8 hostile-ctx cases). |
| `tests/smoke.mjs` | — | Live end-to-end probe (ids → plan → catalog → streaming completion). |
| `tests/wire-dump.mjs` | — | Prints the exact headers and fingerprint this build emits. |

**Design invariant:** every constant the upstream gate can key on lives in
`opencode-protocol.ts`. Nothing else in the codebase hard-codes a
protocol detail. When the gate moves, that is the only file that should need
editing.

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
| `providerInfo(provider)` | Display name `OpenCode Free` for the GUI. |
| `listModels(provider)` | Catalog-driven model selector. |
| `resolveModel(provider, model, signal)` | Publishes `context.contextWindow`, `defaultMaxTokens`, and `reasoning.efforts`. |
| `prepareCall(provider, model, signal)` | Binds metadata and the stream entry point to one generation. |

`stream()` is an async generator: the runtime wraps thrown errors into a
terminal `error`/`aborted` finish, but this adapter also catches internally so
it can attach a stable failure code.

### 6.2 Registration and lifecycle

```ts
export const name = 'dsh-opencode-free'
export const inject = ['llm']
export function apply(ctx: Context, config: Config): void
```

Three registrations, each individually guarded so a missing optional API in an
older host degrades instead of throwing:

1. `ctx.llm.registerAdapter(providers, adapter)` → returns a disposer.
2. `ctx.llm.registerConfigurableProviders(...)` → settings-UI metadata
   (`displayName: 'OpenCode Free'`, `settingsNs: 'opencode-free'`).
3. `ctx.llm.registerModelDiscovery('opencode-free', fn)` → `id`, `name`,
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
- **Tool calls.** Deltas are accumulated by `tool_calls[].index` (id, name, and
  concatenated argument fragments), then emitted as complete blocks after the
  text stream ends, sorted by index. `tool-call-delta` carries the full
  argument string because the upstream sends the id/name once and fragments the
  rest.
- **Finish reason.** `tool-calls` if any call was emitted; `max-tokens` when
  `finish_reason === 'length'`; otherwise `stop`. Aborts surface as `aborted`;
  failures as `error` with a stable `code`.

### 6.4 Tool cloaking and translation

This is the most subtle part of the plugin: the body must contain OpenCode's
tools, yet DSH's tools must remain callable.

`planTools(callerTools)` produces four things:

```ts
{ tools, aliasToOriginal, decoys, callerNames }
```

Algorithm:

1. For each caller tool:
   - not in `FINGERPRINT_NAMES` → send unchanged;
   - in `FINGERPRINT_NAMES` **and** exactly canonical → send unchanged (it
     doubles as the fingerprint, no decoy is appended);
   - in `FINGERPRINT_NAMES` with a different definition → **cloak**: send it as
     `<name>_client` (then `_client2`, `_client3`, … if taken) and record the
     alias. DSH's `read` tool has a different schema than OpenCode's, so in
     practice DSH's `read` always travels as `read_client`.
2. Append every fingerprint name that is not already satisfied, marking them as
   `decoys`.

On the response side, `normalizeToolCall(call, plan)`:

- **alias → original**: `read_client` becomes `read` again, so DSH executes its
  own tool with its own arguments untouched.
- **decoy → caller tool**: a model that calls the appended `read`/`shell`/etc.
  is rerouted onto the caller's equivalent, with arguments translated:

  | Decoy | Caller target (preference order) | Argument mapping |
  |---|---|---|
  | `read` | `read` | `path`→`file_path`, `offset`, `limit` |
  | `shell`, `bash` | `pwsh` → `bash` → `shell` | `command`, `description` (command's first 120 chars), `workdir`, `timeout`→`timeoutMs` |
  | `glob` | `glob` | `pattern`, `path` |
  | `grep` | `grep` | `pattern`, `path`, `include` |

**Safety property:** translation applies *only* when `plan.decoys` contains the
name. A tool the caller declared is never re-mapped — its arguments are already
in the caller's schema. This prevents silently corrupting arguments for tools
that happen to share a name with a fingerprint tool.

**Preference order note:** the shell decoy prefers `pwsh` over `bash` over
`shell`. The DSH desktop profile ships `pwsh` (and disables `bash`), so CLI
models' Linux-flavoured `shell` calls land on the PowerShell tool.

**Auxiliary calls:** for `options.purpose` set (`compaction`,
`session-title`), caller tools are dropped — `planTools([])` — leaving only the
5 fingerprint declarations. The gate stays satisfied without offering tools to
an auxiliary call.

If `config.toolTranslation` is disabled, `normalizeToolCall` is skipped: decoy
calls then reach DSH with OpenCode's argument names (`path`, `command`) and
will fail schema validation. This is why it defaults to `true`; the flag exists
so a future gate can be satisfied with the fingerprint alone.

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
and `x-opencode-log-id` (as `requestId`, for upstream support tickets).

Stream-level failures:

| Condition | Result |
|---|---|
| `options.signal` aborted | `finish{kind:'aborted', failure:{code:'ABORTED'}}` |
| `DOMException.name === 'TimeoutError'` | code `TIMEOUT` |
| any other throw | code `STREAM_FAILED` |
| mid-stream `{"error":…}` frame | `LlmError` with `PROVIDER_STREAM_ERROR` |

Timeouts are enforced with
`AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])`, so
caller cancellation and the request deadline both work, and the caller's signal
is never ignored.

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
| `providers` | string[] | `['opencode-free']` | Provider routes served by this adapter. |
| `includeDeprecated` | boolean | `false` | Offer deprecated-but-still-live models. |
| `extraModels` | string[] | `[]` | Force-add model ids. |
| `requestTimeoutMs` | number | `600000` | Per-request deadline. |
| `toolFingerprint` | boolean | `true` | Send the OpenCode tool declarations. |
| `toolTranslation` | boolean | `true` | Translate fingerprint-tool calls onto DSH tools. |
| `logLevel` | string | `info` | Minimum level written to disk: `debug`\|`info`\|`warn`\|`error`\|`off` (`off` disables file logging). |
| `logDir` | string | `''` | Log directory; empty = `<DSH_PROFILE_DIR or ~/.dsh>/logs/dsh-opencode-free` (the Host process usually has no `DSH_PROFILE_DIR`, so in practice `~/.dsh/logs/dsh-opencode-free`). |
| `logMaxBytes` | number | `524288` | Per-file size ceiling in bytes before rotation. |
| `logMaxFiles` | number | `5` | Total files kept (active + rotated); the **oldest is deleted first** on overflow. |

Overriding config in a profile is whole-row replacement (no deep merge), so an
override row must restate every key it wants to keep.

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
| `429 RATE_LIMIT` | Per-IP free-tier quota, or upstream capacity (`Upstream request failed: Endpoint is unavailable.`) | Wait for reset; the upstream message states it. Not a plugin bug. |
| Model missing from the selector | Registry/live mismatch | Add the id to `extraModels`, or set `includeDeprecated: true`. |
| Tool calls fail schema validation | `toolTranslation` disabled, or a mapping drifted | Re-enable it; re-check `translations()` against the current DSH tool schemas. |

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
| `pnpm test` | `node --test tests/*.test.mjs` — hermetic unit tests. Currently covers the logging module (8 cases: levels/redaction/rotation/read). |
| `node tests/wire-dump.mjs` | Prints `attributionSuffix()`, `buildHeaders()`, `SESSION_ID_RE`, and the planned tool names — the fastest way to confirm the wire fingerprint without network I/O. |
| `node tests/smoke.mjs [model-id]` | Full live path: id regex + low-12-bit invariant, tool plan/alias/translation, live catalog, real streaming completion. |

**Current state:** `tests/logger.test.mjs` is hermetic; `tests/smoke.mjs` and
`tests/wire-dump.mjs` are live probes. Hermetic protocol tests remain on the
roadmap (section 13); until they land, treat the smoke probe as the live
acceptance test — it is what validated the recipe in section 4.6.

An end-to-end acceptance run has two parts:

1. **Wire level** — `tests/smoke.mjs` returns `finish{kind:'stop'}` with
   non-empty text and a valid `ses_` id.
2. **Host level** — inside a running DSH profile, a one-shot model call routed
   through provider `opencode-free` returns the expected answer, proving the
   adapter is registered, discovered, and reachable through `LlmRuntime`.

---

## 12. Security, privacy, attribution

- **No credentials.** The plugin reads no keychain, no env var, no config
  secret. The only `Authorization` value it can send is `Bearer public` (or
  whatever the operator sets explicitly).
- **Attribution is preserved, not removed.** DSH's contract requires every
  provider request to identify the harness. The plugin satisfies it — product
  name and project URL are advertised — and strips only the version component,
  because a versioned foreign product token is rejected by the gate. This is
  the minimum deviation that satisfies both constraints, and it is the reason
  `attributionHeaders()` is imported and transformed rather than bypassed.
- **No extra telemetry.** The plugin sends nothing beyond the request itself:
  no analytics, no phone-home, no logging of prompt content. `prompt_cache_key`
  is the session id with its prefix stripped — a stable per-conversation
  cache token, not a user identifier.
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

1. **Protocol hermetic unit tests still missing.** `tests/logger.test.mjs`
   covers the logging module (levels/redaction/rotation/read — all 8 pass), but
   the protocol pure functions have no matching tests yet:
   - id encoding: regex shape, the `ffe` low-12-bit invariant, counter clamping,
     ascending vs descending
   - `planTools`: passthrough, canonical-match (no decoy), cloaking, alias
     collision (`_client2`), decoy set contents
   - `normalizeToolCall`: alias restoration, each decoy translation, the
     "declared tools are never re-mapped" safety property, malformed JSON
   - `buildHeaders`: exact header set and the stripped-version UA
   - `buildChatMessages`: assistant tool-call re-cloaking, `role:'tool'`
     mapping, image/file placeholders, developer-message dropping
2. **Text-only content path.** Images and files are placeholders. Some free
   models advertise `image` input in the registry; when the relay serves
   multimodal chat, `buildChatMessages` should emit real content parts. The
   registry already publishes `inputModalities`, so the adapter can decide
   per model.
3. **Response-side reasoning.** Only `reasoning_content` is recognised. Other
   providers' spellings (`reasoning`, `thinking`) are not parsed.
4. **Retry/backoff is delegated.** The adapter surfaces `providerRetryAfterMs`
   but implements no retry of its own, relying on `dsh-llm-retry`.
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
| 2026-10-18 | 0.2.1 | **Release prep**: npm package name set to `dsh-opencode-bridge` (unscoped `dsh-opencode-free` is taken by another author; the scoped name lacked distinction, so renamed to evoke the protocol bridge); `client.js` module id and `cordis.patch.yml` `name` follow the package name (row `id` unchanged); added LICENSE, `.gitignore`, `prepack` build hook; removed the settings log-viewer pitch from the plugin description. | 3, 14, Appendix A |
| 2026-10-18 | 0.2.1 | **Fixed a DSH Desktop startup crash**: an uncaught exception in `client.js` `apply()` failed web-boot module activation, which the desktop shell treats as fatal. Hardened: `apply()` never throws (per-step try/catch), all service access optional-chained, locale registered before bound, `immediately: true` removed (avoids activating before the settings slot is declared); added 8 hostile-ctx regression tests. | 3, 15.6 |
| 2026-10-18 | 0.2.0 | Added leveled logging (redaction + size-based rotation that cleans oldest first), a DSH Settings log view/copy UI, and the `opencode_free_log` agent tool; established the documentation maintenance policy. | 0, 3, 8, 11, 13, 14, 15 |
| 2026-10-17 | 0.1.0 | First release: three-layer gate reproduction, `OpenCodeFreeAdapter`, free-model catalog, tool cloaking/translation. | 1–13 |

---

## 15. Logging and diagnostics

Goals: **debuggable, zero sensitive information, bounded disk usage** — in that
order of precedence. However useful a log line is, it may never contain
credentials or user message content.

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

Even if a call site misbehaves, these catch sensitive material
(`PluginLogger.redact()`):

1. **Literal secrets**: values injected at construction (`secrets`, currently
   `config.apiKey`) are replaced verbatim with `[redacted]`;
2. **Token shapes**: `Bearer <token>` and long `sk-…`/`key-…`/`token-…`/
   `secret-…` literals become `[redacted]`;
3. **Truncation**: any string over 2000 characters is cut and marked
   `…[truncated]`.

Every value inside `data` passes through `redact()` as well. The rules are unit
tested (`tests/logger.test.mjs`, the two "redaction" cases).

### 15.3 Rotation and automatic cleanup

When a log file reaches `logMaxBytes` (default 512 KiB) it rotates:
`dsh-opencode-free.log` → `.1` → `.2` …, **deleting the oldest first** on
overflow, so the total file count stays ≤ `logMaxFiles` (default 5) and disk
usage is bounded by `logMaxBytes × logMaxFiles`. Startup also prunes historical
files beyond the retention. Write failures never throw (they degrade to a
200-line memory ring that `read()` still serves).

### 15.4 One implementation, two callers

`LogService` in `src/log-service.ts` is the single implementation of
read/clear/set-level:

- **Settings UI** (`client.js`): registers into the `settings.section` slot
  (Settings page "OpenCode Free") with level filtering, refresh, **copy all**
  (Clipboard API with an `execCommand` fallback), and clear (with
  confirmation). Data comes from the package-private JSON RPC
  `/api/opencode-free-logs/{read,stat,clear,level}` — the same
  `connection.fetch.register` / `connection.rpc.call` channel a verified
  shipped plugin uses (see `dsh-tool-antigravity`).
- **Agent tool `opencode_free_log`**: `action: read|stat|clear|level`, backed
  by the same `LogService`, so the model can pull its own diagnostics. The log
  is already redacted and safe to bring into context.

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

### 15.6 Client-module robustness rules (0.2.1 crash fix)

**Incident**: installing 0.2.0 crashed DSH Desktop on startup. The crash log
(`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`) shows
`web boot: 1 entry did not activate / dsh-opencode-free: failed` — **the
desktop shell treats a failed client-module activation as fatal**; any
uncaught exception thrown from `apply()` kills the whole application
(`dsh-session-mover` on 10-15 died the same way).

**Root cause** (two compounding defects):

1. `locale.bind(NS)` was called BEFORE `locale.register(NS, …)` — binding an
   unregistered namespace can throw;
2. `ctx.slots.inject('settings.section', …)` was called unguarded — with
   `immediately: true`, the module activates before the settings slot is
   declared, so the property access/call throws a TypeError.

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
src/adapter.ts            LlmAdapter implementation
src/catalog.ts            free-model catalog
src/logger.ts             leveled logger (redaction, rotation, memory fallback)
src/log-service.ts        LogService + RPC routes + agent tool
client.js                 Settings log viewer/copy panel (browser module)
locale/en.json, zh.json   plugin title/description (display checklist)
icon.svg                  original plugin icon
lib/                      tsc output (published)
tests/logger.test.mjs     logging module hermetic unit tests
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
