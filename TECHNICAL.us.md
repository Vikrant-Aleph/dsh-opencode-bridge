# dsh-opencode-bridge — Technical Design

[中文](TECHNICAL.md) | English · [Camouflage policy](CAMOUFLAGE.us.md)

How the OpenCode free-tier gate was reverse-engineered, how the wire protocol is
reproduced, how the adapter maps onto the DSH LLM contract, and how to respond
when upstream changes. Also covers optional context trimming of completed-turn
reasoning and the safeguards around it.

Audience: maintainers of this plugin, and DSH plugin authors building a
provider-wire `LlmAdapter`.

> **Dated snapshot.** Every upstream fact here was established empirically in
> 2026-10/11 against `https://opencode.ai/inference/*`, the installed official
> CLI (2.2.0), and a read of `anomalyco/opencode`. The gate evolves; treat all
> constants as dated observations. §8 is the update
> playbook.

## 0. Documentation maintenance

This file and its [Chinese counterpart](TECHNICAL.md) change together. Update both in
the same change when a user-visible feature, a protocol principle, a documented constant,
the build/pack/publish flow, or the version moves. A version bump must also update the
install command in both READMEs to match `version` in `package.json`;
`tests/readme-version.test.mjs` enforces it.

READMEs are for visitors; this file is for maintainers. Record every change in §11.

**Two rules for citing evidence.** Both are enforced by
`tests/evidence-links.test.mjs`:

1. **Every file a document cites must be published in this repository.** A claim whose
   evidence is unavailable cannot be checked, which defeats the point of citing it. Put
   the capture under [`docs/evidence/`](docs/evidence/README.md) and link it there.
2. **Never mention an artefact that is not published.** Do not describe what was
   withheld, where it lives, or why. A reader can only be confused by a pointer to
   something they cannot reach.

---

## 1. What this plugin is

An `LlmAdapter` that speaks the official OpenCode client's wire protocol, so DSH
can use the keyless `-free` models at `opencode.ai` without an account.

It does **not** modify the agent loop, execute tools itself, or patch global
HTTP entry points. Tool execution, permissions and schema validation stay in DSH.

Two rules govern the design:

1. **Imitate only what the gateway actually checks.** See [CAMOUFLAGE.us.md](CAMOUFLAGE.us.md).
2. **Dated evidence over assumption.** A constant stays only while a capture supports it;
   §8 explains how to re-derive each one.

## 2. Architecture

```
DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
OpenCodeFreeAdapter            src/adapter.ts
   ├── planTools               src/opencode-protocol.ts   declare caller tools (+ placeholder)
   ├── buildChatMessages       src/opencode-protocol.ts   DSH messages → OpenAI chat
   ├── buildHeaders            src/opencode-protocol.ts   identity headers + tracing
   ├── prepareImageProjection  src/image-input.ts         official attachment seam
   └── fetchWithPool           src/proxy-pool.ts          egress pool, cooldown, failover
          │
          ├── bunFetch        src/bun-transport.ts        Bun-shaped TLS (wreq-js)
          └── plain fetch                                 fallback when unavailable
   ▼
https://opencode.ai/inference/...
```

Other modules:

| Module | Responsibility |
|---|---|
| `src/catalog.ts` | Free-model discovery: models.dev registry ∩ live `/models`, TTL and retry. |
| `src/project-identity.ts` | Derives the official `x-opencode-project` id from a real directory. |
| `src/request-waits.ts` | Per-model server retry deadlines, persisted across reloads. |
| `src/http-errors.ts` | Typed upstream classification; safe, bounded diagnostics. |
| `src/retry-after.ts` | Strict `Retry-After` parsing (ms, seconds, HTTP-date). |
| `src/reasoning-policy.ts` | Host-only completed-turn reasoning projection for optional trimming. |
| `src/context-service.ts` | The Context-trimming preference (RPC + agent tool, one operation). |
| `src/logger.ts`, `log-service.ts` | Leveled, redacted diagnostic logging. |
| `src/proxy-service.ts` | Egress pool editing and probing for the Settings page. |
| `client.js` | Settings page (browser module, not a tsc product). |

## 3. The gate, as observed

Three layers were identified. Only the third was later **rejected** by
experiment — it is documented here because the rejection is the reason the code
looks the way it does.

### 3.1 User-Agent

`opencode/<channel>/<version>/<name>`, e.g. `opencode/latest/2.2.0/cli`. The
captured value is sent byte-identically. A versioned foreign token such as
`deepseek-harness/<n>` is refused; DSH attribution is therefore opt-in
(`userAgentAttribution`) and off by default.

### 3.2 Session and request identity

`ses_` ids encode a 48-bit time field: the CLI's descending encoding
`~(ms * 0x1000 + counter)`, with a small counter, followed by 14 base62
characters. The same id is sent as `x-opencode-session`,
`x-opencode-session-id`, `x-session-affinity` and `x-session-id`.

`x-opencode-project` is derived from the caller's directory, matching the
official rule verified by capture:

- git checkout → `sha1("git-remote:" + normalized remote)`
- otherwise → `sha1("directory:" + resolved path)`

### 3.3 Tool declarations — rejected as an identity signal

An earlier revision injected OpenCode's built-in tool manifest and cloaked
colliding caller tools behind `*_client` aliases. **Experiment disproved the
premise** (`docs/evidence/user-customization-round2-2026-11-13.json`,
`docs/evidence/user-add-tools-2026-11-13.json`):

| Mechanism | Result |
|---|---|
| `agents.<name>.system` | Replaced the entire system prompt |
| `agents/<name>.md` (global or project) | Replaced the entire system prompt |
| Custom agent without tools | Tool list dropped 12 → 1 |
| Plugin registering invented tools | Requests carried arbitrary names and schemas |

A user can emit any tool list and any system prompt from the official client, so
neither *content* identifies it. The bridge now declares exactly the caller's tools.

Content being free does not make the *shape* free: at least one declared tool and
separator-free names still hold, as §3.4 and §3.5 show. That is precisely why the rule
is phrased as "what is checked" rather than "what is configurable".

### 3.4 The one declaration the bridge must add

Community reports across several independent projects claim a tool **named** `read` is
required. That specific claim did not reproduce: measured from a single runtime with
only the tool array varying, a lone tool called `dsh_probe_tool` passes just as well
(`docs/evidence/any-tool-vs-read.json`). What *is* required is simply **at least one
declared tool** — an empty list is refused (`docs/evidence/bun-tool-minimum.json`).

So the caller's own tools satisfy the requirement, and `planTools` adds a placeholder
only when the caller declares none. That keeps a tool DSH cannot execute out of normal
traffic; the placeholder's description tells the model not to call it, and a call that
happens anyway is **dropped** by the adapter (logged at `warn`) so the turn still ends
normally.

### 3.5 Transport

The official client runs on Bun. Node's TLS cannot express the same
`ClientHello`: OpenSSL orders extensions itself and offers no post-quantum key
share. Measured against the captured handshake, Node's `tls`/`tls-impersonate`
paths produce a different extension order and a ~274-byte hello versus 1482.

`src/bun-transport.ts` delegates the handshake to `wreq-js` (Rust + BoringSSL),
configured from the capture. The library is an **optional** dependency; without
its native binding the adapter falls back to plain `fetch`.

Matching the capture required four corrections, each found by a deep extension
diff:

| Correction | Detail |
|---|---|
| `curvesList` | Drop the extra `MLKEM768` group; the client offers `X25519MLKEM768`, `X25519`, `P-256`, `P-384` only. |
| `sigalgsList` | `0x0807` is **ed25519**, not `rsa_pss_pss_sha256` (which is `0x0809`). `0x0603` is spelled `ECDSA+SHA512`. Both are needed for the captured 11-entry list. |
| Header casing | `Authorization`, `Content-Type`, `User-Agent`, `Connection`, `Accept`, `Host`, `Accept-Encoding`, `Content-Length` — the transport's lowercase defaults differ. |
| Header positions | `Host`, `Accept-Encoding` and `Content-Length` are supplied explicitly so they land at positions 14–16; the transport would otherwise append them at the end. |

With those in place the `ClientHello` has **zero extension mismatches** and the
same 1482-byte record as the capture, and the request headers are byte-identical
apart from `x-opencode-project`, which is derived from the caller's directory
(`docs/evidence/clienthello-deep-2026-11-13.json`, `docs/evidence/byte-exact-2026-11-13.json`).

A persistent `wreq` Transport keeps one pooled connection across turns, matching
the official client; a pooled connection returns to the pool only once its
response body has been fully read.

The client offers **only `http/1.1`** — no `h2` — so HTTP/2 SETTINGS
fingerprinting is not part of this client's traffic.

### 3.6 The three structural requirements

Three properties of a request are checked. The official client sends all of them
regardless of user configuration:

| Requirement | Finding |
|---|---|
| **At least one declared tool** | Any tool name satisfies it; an empty list is refused with `FreeUsageLimitError` (`docs/evidence/bun-tool-minimum.json`, `docs/evidence/any-tool-vs-read.json`). |
| **An `<env>` block in the system prompt** | A 177-byte prompt containing nothing but the block passes; a prompt without one is refused (`docs/evidence/bun-env-hypothesis.json`). |

The `<env>` values are not checked: rewriting the paths or flipping the git flag still
passes (`docs/evidence/bun-env-strictness.json`). The plugin still generates the block
from the real working directory, so its contents are useful to the model. The official
harness text and the Code Mode catalogue are **not** required — a synthetic catalogue of
DSH's own tools passes too (`docs/evidence/bun-synthetic-catalog.json`).

The runtime is not the differentiator: Bun 1.4.4 with a zero-tool body is refused
exactly like Node (`docs/evidence/bun-runtime-test.json`).

**Declared tool names must not contain separators.** This requirement was identified on
2026-11-14 and is why every request was refused before 1.0.4. The gateway answers a
declaration whose names contain underscores, dashes, dots or capitals with
`FreeUsageLimitError`, which looks exactly like an exhausted quota, so it was treated as
rate limiting for a long time:

| Body | Tool names | Result |
|---|---|---|
| The full UI request (46 tools, 69 KB) | Original, with underscores | 429 |
| The same body | Separators removed (`askuserquestion`) | **200** |
| Six tiny tools | `job_list`, `web_search`, … | 429 |
| The same six objects | `pwsh`, `read`, `glob`, … | 200 |

All 12 official tools are free of separators (`edit`, `glob`, `grep`, `question`,
`read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`,
`execute`). A declaration also needs at least one name the gateway recognises: a set of
purely invented names is refused even without separators.

`planTools` therefore reduces every name to `[a-z0-9]` (appending a counter on
collision) and keeps a sanitized-to-real map, which is applied to returned calls so
DSH's dispatch is unaffected.

### 3.7 Field-level differences from the official encoder

After reading the official OpenAI Chat encoder end to end (`openai-chat.ts`, 1288 lines),
three differences remain. Each was measured inside one open window with a control on
either side (`docs/evidence/tools-field-and-token-budget-2026-11-14.json`):

| Difference | Official | This bridge | Measured |
|---|---|---|---|
| `tools` when empty | The whole field is omitted | A `read` placeholder is declared | **Omitting it is refused (429)**; the placeholder is required |
| `max_completion_tokens` | The caller's value is sent | Raised to `minOutputTokens` (32000) | A small value (1000) is **accepted**; the floor is a configuration choice, not a requirement |
| A system message inside `messages` | Rendered as a user message | Folded into the leading system message | The gateway accepts either, but the official form is **not adopted**: the only system message DSH sends is the system prompt itself |

The first row is worth recording: the official `Generate.text` path (title generation)
really does send a body without `tools`, and such a request is refused — a failed title
is silent, so nobody notices.

Every other field is aligned: `store` and `prompt_cache_key` are both omitted (the
official client sends them only where a provider declares support), `temperature`,
`stop` and `reasoning_effort` are forwarded when present, and the assistant message's
`content: null`, empty-string `reasoning_content` and `tool_calls` shape match.

The adapter appends `environmentBlock()` after the DSH prompt, matching where the
official client puts it, so the agent's own instructions still lead. With both in place
the adapter's own path returns 200 repeatedly (`docs/evidence/verify-env-fix.json`,
`docs/evidence/placeholder-verify.json`).

## 4. Wire reference

### 4.1 Headers

| Header | Value |
|---|---|
| `authorization` | `Bearer public` (the signed-out sentinel) |
| `content-type` | `application/json` |
| `accept` | `*/*` |
| `accept-encoding` | `gzip, deflate, br, zstd` |
| `user-agent` | `opencode/latest/2.2.0/cli` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | derived (§3.2) |
| `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id` | the session id |
| `b3`, `traceparent` | minted per request in the captured shape (`tracing: false` disables) |
| `x-opencode-request` | **not sent** (2.x omits it; `requestIdHeader: true` for 1.x relays) |

`host`, `content-length` and `connection` are written by the transport.

### 4.2 Body

```jsonc
{
  "model": "deepseek-v4.1-flash-free",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [...],            // the caller's tools, or one placeholder if there are none
  "max_completion_tokens": 32000
}
```

`tool_choice` and `prompt_cache_key` are **not** sent: the captured client omits
both. `max_completion_tokens` is raised to `minOutputTokens` (default 32000),
matching the client's catalog-derived budget.

### 4.3 Message mapping

| DSH | Wire |
|---|---|
| `options.system` | leading `{role:'system'}` |
| `role:'system'` | `{role:'system'}` |
| `role:'developer'` | dropped — tool changes are already in `options.tools` |
| `role:'tool'` | `{role:'tool', tool_call_id, content}`; empty → `''` |
| `role:'assistant'` | `{role:'assistant', content, reasoning_content?, tool_calls?}`; text joins with `''`, `content` is `null` only when tool calls exist without text, `reasoning_content` sent only when reasoning exists or the model requires it |
| user content | ordered text/`image_url` parts on vision routes |

Returned calls keep their id, name and raw argument bytes: DSH owns lookup and
validation. The batch is buffered until `finish_reason: tool_calls`; a truncated
batch yields `TOOL_BRIDGE_INCOMPLETE` and dispatches nothing.

## 5. Adapter behaviour

- **Streaming**: SSE is parsed incrementally; text, reasoning and tool-call
  deltas map to DSH chunks. A stream failure after output starts is never
  replayed (`PARTIAL_STREAM_ERROR`).
- **Retry**: the adapter declares a bounded policy (`maxRetries: 2`, 2s initial,
  120s cap, 0.2 jitter) and does not run timers itself. A positive server wait is
  honored verbatim and is never shortened, jittered or capped by local policy.
- **Per-model waits**: an observed `Retry-After` is stored per model with the egress that produced it, and
  persisted, so a reload cannot erase a server-imposed deadline. Other models and
  metadata requests are unaffected.
- **Free-usage rejections**: a typed `FreeUsageLimitError` becomes
  `FREE_USAGE_LIMIT` — non-retryable, and **not** treated as proof that the whole
  egress is exhausted. Local guesses are never recorded as server waits. The state file is re-read before every check, so an external clear applies immediately; a wait whose egress is no longer configured stops applying; and Settings offers **Clear cooldowns**.

**Probe policy**: the gateway's `Retry-After` points at UTC midnight, but it serves again within minutes (refused at 17:24, the same model served at 17:27). A cooldown therefore blocks only an exponential probe window -- 60 seconds, doubling, capped at 15 minutes -- not the duration the server claims. The server deadline is still recorded, as an upper bound and for diagnostics.
- **Cancellation**: checked before the POST, after buffering and before each
  tool chunk.

### 5.1 Images

`src/image-input.ts` uses only the public attachment seam
(`readImageRequest`). It never guesses storage paths. Model declarations decide
reads: only routes declaring `image` input read bytes. Budgets default to 4 MP,
1 MiB per image, 20 MiB total, 20 occurrences; over-budget calls return
`IMAGE_OFFLOAD_REQUIRED` rather than dropping images silently. Tool-result images
are hoisted as one associated user message **after** the whole contiguous tool
result group.

### 5.2 Reasoning replay

Every assistant history row carries `reasoning_content` when the model requires
it or reasoning exists. Optional trimming (`trimCompletedReasoning`) removes
reasoning only from canonical **completed** turns, verified by message id and a
SHA-256 fingerprint; active, failed or interrupted chains are retained. It
applies to new requests only and never deletes local history.

## 6. Model catalog

`src/catalog.ts` intersects the models.dev registry (cost 0, not deprecated) with
the live `/models` list. Snapshots are committed atomically: a failed source
never erases a usable snapshot. Refresh defaults to 10 minutes; failures back off
60s. `modelRefreshIntervalMs: 0` disables periodic refresh but keeps startup
prefetch and on-demand caching.

## 7. Configuration

| Key | Default | Purpose |
|---|---|---|
| `baseUrl` | `https://opencode.ai/inference/v1` | Relay base. |
| `apiKey` | `public` | Signed-out sentinel. |
| `userAgent` | `opencode/latest/2.2.0/cli` | Identity UA; sent verbatim. |
| `userAgentAttribution` | `false` | Append the DSH attribution token. |
| `client` | `cli` | `x-opencode-client`. |
| `requestIdHeader` | `false` | Send `x-opencode-request` (1.x relays only). |
| `tracing` | `true` | Send `b3`/`traceparent`. |
| `bunTransport` | `true` | Use the Bun-shaped TLS transport when available. |
| `toolStrict` | `true` | Add `strict: false` to tool declarations. |
| `minOutputTokens` | `32000` | Lower bound for `max_completion_tokens`. |
| `project` | `global` | Explicit `x-opencode-project`; overrides derivation. |
| `projectDirectory` | `''` | Directory used for derivation; empty uses cwd. |
| `providers` | `['opencode-bridge']` | Provider routes served. |
| `includeDeprecated` | `false` | Offer deprecated-but-live models. |
| `extraModels` | `[]` | Force-add model ids. |
| `requestTimeoutMs` | `600000` | Per-request deadline. |
| `modelRefreshIntervalMs` | `600000` | Catalog refresh; `0` disables polling. |
| `trimCompletedReasoning` | `false` (live) | Settings → Context trimming. |
| `toolResultImages` | `true` | Forward tool-output images on vision routes. |
| `requestImagePixelBudget` | `4194304` | Request image pixels. |
| `requestImageMaxBytes` | `1048576` | Per-image encoded byte target. |
| `maxRequestImageBytes` | `20971520` | Aggregate base64 budget. |
| `maxRequestImages` | `20` | Retained image occurrences. |
| `proxies` | `[]` | Egress pool, in order. |
| `proxyCooldownMs` | `60000` | Local fallback cooldown; never shortens a server wait. |
| `proxyStorePath` | `''` | Settings-owned pool store. |
| `logLevel` | `warn` | `debug`\|`info`\|`warn`\|`error`\|`off`. |
| `logDir` | `''` | Defaults to the profile log directory. |
| `logMaxBytes` / `logMaxFiles` | `524288` / `5` | Rotation. |

## 8. When upstream changes

Symptoms and first actions:

| Symptom | Likely cause | Action |
|---|---|---|
| `403 FreeTierError` | Identity shape refused | Check the UA, the session headers, that at least one tool is declared, and that the `<env>` block is present (§3). |
| `429 FreeUsageLimitError` | Free lane refusal or real quota | Read the diagnostics; do not retry, rotate or clear the stored wait. |
| `400 MissingSessionID` | Session header absent | Session minting broke. |
| Endpoint `404`/`426` | Route migrated | Re-read the catalog's `provider.api`. |
| Empty catalog | Registry or `/models` failing | Check logs; the previous snapshot is retained. |

Re-deriving a constant:

1. Capture what the **installed official client** sends, using a loopback
   endpoint (never by guessing): run it with `--standalone`, an isolated config
   and a local fake model, then record headers, body and TLS `ClientHello`.
2. Compare against `buildHeaders`/`buildChatMessages`/`BUN_TLS_EMULATION`.
3. Change only what the capture contradicts, and only in the direction it shows.
4. Add or update the assertion in `tests/` that pins the new value.
5. Record the change in §11.

## 9. Testing

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json   # build
node --test tests/*.test.mjs                            # full offline suite
```

All tests are offline. Live probes under `tests/*-live.mjs` are opt-in, require
an explicit `--run`, and refuse to overwrite an earlier report.

| Suite | Covers |
|---|---|
| `current-protocol`, `alignment`, `gateway-requirements` | Wire shape, headers, tool declarations, `<env>` block, placeholder handling. |
| `bun-transport` | Captured cipher/extension configuration. |
| `bridge-integration`, `bridge-stream` | Batch atomicity, incomplete batches, streaming assembly. |
| `reasoning-*` | Replay rules, trimming eligibility, stream probes. |
| `image-*`, `vision-*` | Attachment projection, budgets, tool-image hoisting. |
| `retry-integration`, `proxy-rotation` | Server waits, pool cooldown, no-replay guarantees. |
| `project-identity`, `request-waits` | Identity derivation, persisted deadlines. |
| `catalog-*`, `log-*`, `client-boot` | Catalog lifecycle, redaction, settings page. |

### 9.1 Live probes

All require `--run`, spend real quota, and refuse to overwrite an existing report. No
offline suite catches a request shape the gateway refuses — before 1.0.4, 418 offline
tests passed while every real request was refused.

| Probe | What it verifies |
|---|---|
| `smoke.mjs --run` | Session and request id shape, separator-free tool names and their round trip, catalog reachability, one live completion with a full tool set, and that a returned call carries the caller name. |
| `tool-loop-live.mjs --run` | A multi-turn tool loop: three sequential calls where each result feeds the next, and later requests must replay the assistant history and `reasoning_content`. Ran 10/10 with deepseek-v4.1-flash-free on 2026-11-14 (`docs/evidence/tool-loop-live-2026-11-14.json`). |
| `proxy-live.mjs` | A proxy tunnel carrying real traffic. |
| `vision-compat-live.mjs` | Image input and tool-result images. |
| `reasoning-compat-live.mjs`, `reasoning-roundtrip-live.mjs` | Reasoning replay and round trips. |
| `wire-dump.mjs` | Print the wire fingerprint actually emitted. |

How to read a refusal: the free lane stops serving after a handful of requests. **Every
429 must be compared against the official client at the same moment** — if the official
client fails too it is quota, and if it passes the camouflage still has a gap.

## 10. Security, privacy, attribution

- No credential is read beyond the configured `apiKey`; proxy URLs are redacted
  in every log and UI surface.
- Logs are metadata-only: no prompts, tool arguments, results or image bytes.
- Image data never appears in logs at any level (asserted by tests).
- The plugin adds no `exec`/`spawn` call. Attribution to DSH is available via
  `userAgentAttribution` and is off by default for protocol reasons (§3.1).

## 11. Change log

| Date | Version | Change |
|---|---|---|
| 2026-11-13 | **1.0.0** | **Gateway requirements found and met.** Two structural requirements are now satisfied: at least one declared tool (any name) and an `<env>` block in the system prompt. The `read` placeholder is added only when the caller declares no tools, its description says not to call it, and a call to it is dropped rather than failing the turn. Transport: `wreq-js` persistent Transport with connection pooling, `Connection: keep-alive`, official header casing/positions, `curvesList` trimmed, `sigalgsList` completed (`ed25519` + `ECDSA+SHA512`), and the wiring fix that had left the transport unused; the selected proxy URL now reaches a non-undici transport, so rotation works with the Bun-shaped transport. Removed the tool-bridge layer, `opencode_bridge_audit`, and the dead `harnessSystem` option. |
| 2026-10-23 | 0.5.5 | Optional completed-turn reasoning trimming with a persistent settings tab. |
| 2026-10-22 | 0.5.4 | Official attachment-backed images (Issue #3); tool-result image hoisting. |
| 2026-10-21 | 0.5.3 | Assistant reasoning replay (Issue #2). |
| 2026-10-19 | 0.5.2 | Bounded retries with safe 429 diagnostics and strict cooldown. |
| 2026-10-19 | 0.5.1 | Dynamic model catalog refresh. |
| 2026-10-18 | 0.4.1 | SOCKS4/4a/5/5h support, DNS modes, credential handling. |
| 2026-10-18 | 0.3.0 | Egress proxy pool and rotation. |
| 2026-10-17 | 0.1.0 | First release: gate reproduction, `OpenCodeFreeAdapter`, catalog. |

## 12. Glossary

| Term | Meaning |
|---|---|
| **free tier** | The keyless model set offered to the official client. |
| **gate** | The upstream check that decides whether a request from a non-official client is served. This project treats it as a dated observation. |
| **identity header** | A header the official client always sends and a user cannot change (§3). |
| **placeholder** | A tool declaration sent only when the caller declares none, to satisfy the gateway's "at least one tool" rule. |
| **wire name** | The declared tool name with separators removed; mapped back to the caller's real tool when a call returns. |
| **server wait** | A `Retry-After` observed from upstream; scoped to the egress that produced it, blocking only a capped probe window, and clearable on demand. |
| **egress** | One configured route to upstream (`direct` or a proxy). |
| **Bun-shaped transport** | The wreq-js handshake reproducing the official client's `ClientHello`. |
