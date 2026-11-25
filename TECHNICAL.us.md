# dsh-opencode-bridge — technical design

[中文](TECHNICAL.md) | English · [Camouflage policy](CAMOUFLAGE.us.md)

For maintainers of this plugin, and DSH plugin authors who want a reference `LlmAdapter` implementation of a provider's wire protocol. It also covers optional context trimming and its safety constraints.

> **A dated snapshot.** Upstream facts were established by measurement in 2026-10/11: probes
> against `https://opencode.ai/inference/*`, captures of the installed official CLI (2.2.0), and
> reading `anomalyco/opencode` source (cross-checked at v2.2.0). "Currently checked" is relative to
> **2026-11-17** (the last live probe). The gate evolves; constants are dated observations, not a
> specification. How to refresh them is in §9.

Overarching rule: **keep official-consistent details that user settings cannot change.** Checked ones must match; unchecked ones are kept as prevention; content left to the user is not imitated. The trade-off list is in the [camouflage policy](CAMOUFLAGE.us.md).

## 1. Architecture

```
DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
OpenCodeFreeAdapter              src/adapter.ts
   ├── planTools                 declare caller tools (placeholder only if none)
   ├── code-mode (free routes)   anchors + execute + admitted subagent/skill; other tools in the SDK
   ├── buildChatMessages         DSH messages → OpenAI chat, append environment instructions
   ├── buildHeaders              identity headers + optional tracing
   ├── prepareImageProjection    official attachment API
   └── fetchWithPool             egress pool, cooling, failover
         ├── bunFetch            Bun-shaped TLS (wreq-js, optional)
         └── plain fetch         fallback when the transport is unavailable
   ▼
https://opencode.ai/inference/...
```

There are two declaration paths. What the model sees is in §2.2; who executes a call is in §5:

- **Direct declaration**: sanitized caller tools go on the wire. Used for non-free routes, or as the fallback when the host has no PTC runtime.
- **Code Mode**: when a free-model step admits `execute`, the wire declares the anchors, `execute`, and `subagent`/`skill` if the step admits them. The remaining tools go in the SDK in the system prompt. If PTC or `execute` is unavailable, the adapter falls back to direct declaration.

Other modules:

| Module | Role |
|---|---|
| [catalog.ts](src/catalog.ts) | Free-model discovery from the official catalog, TTL + retry (§3). |
| [opencode-protocol.ts](src/opencode-protocol.ts) | Wire shape of headers, messages, tool declarations, environment instructions (§2). |
| [code-mode.ts](src/code-mode.ts) | Code Mode catalog rendering and `execute` registration (§2.2, §5). |
| [project-identity.ts](src/project-identity.ts) | Derives `x-opencode-project` from the real directory (§2.1). |
| [image-input.ts](src/image-input.ts) | Attachment image projection and budgets (§4). |
| [reasoning-policy.ts](src/reasoning-policy.ts) | Completed-turn reasoning projection for optional trimming (§4). |
| [http-errors.ts](src/http-errors.ts), [retry-after.ts](src/retry-after.ts) | Upstream classification, `Retry-After` parsing (§6). |
| [request-waits.ts](src/request-waits.ts) | Cleans legacy cooldown files; current requests read/write no per-model waits (§6). |
| [proxy-pool.ts](src/proxy-pool.ts), [proxy-service.ts](src/proxy-service.ts) | Egress pool and Settings editing (§6, §7). |
| [request-diagnostics.ts](src/request-diagnostics.ts), [logger.ts](src/logger.ts) | Bounded, content-free request summaries; redacted logs (§6). |
| [context-service.ts](src/context-service.ts) | Context-trimming preference (RPC + agent tool, one operation). |
| `client.js` | Settings page (browser module, not a tsc product). |

Terms: **free tier** = the keyless model set offered to the official client; **gate** = the upstream check deciding whether to serve a non-official client; **placeholder** = the single tool sent only when the caller declares none; **wire name** = the separator-free declared name, mapped back on return; **egress** = one configured route upstream (`direct` or a proxy).

## 2. Client camouflage

Three sections by request composition: headers & session info; body, system prompt & tool declarations; transport. Each says what the plugin does first, then why. Every item is tagged: **[checked]** the gateway checks it now, a mismatch is refused; **[preventive]** not checked now, replicated only for detection that may appear in the future; **[user-free]** content is left to the user, the gateway cannot identify the client through it, so it is not imitated.

### 2.1 Headers and session info

The bridge generates:

| Header | Value | Class |
|---|---|---|
| `user-agent` | `opencode/latest/2.2.0/cli`, byte-identical | [checked] |
| `x-opencode-session-id` | The current session's wire ID | [checked] session header shape |
| `x-opencode-session` / `x-session-affinity` / `x-session-id` | Direct parent's wire ID for subagents; known source's wire ID for ordinary forks; otherwise the session's own ID | Root-session shape tested; child behavior observed locally |
| `x-opencode-parent-session-id` / `x-parent-session-id` | The same direct-parent ID in both headers, sent only for subagents with a parent recorded in DSH | Verified locally; upstream checks are unconfirmed |
| `x-opencode-client` | `cli` | [checked] shape |
| `authorization` | `Bearer public` (signed-out sentinel) | [checked] shape |
| `x-opencode-project` | derived from the real directory (below) | [preventive] value not checked |
| `b3` / `traceparent` | minted per request; `tracing:false` disables | [preventive] official default omits |
| `content-type` / `accept` / `accept-encoding` | `application/json` / `*/*` / `gzip, deflate, br, zstd` | [preventive] |
| `x-opencode-request` | not sent (2.x); `requestIdHeader:true` for 1.x relays | — |

The bridge reads the direct parent and subagent marker from DSH's session header, then maps parent and child to separate wire IDs. It never sends local DSH session IDs or adds parent headers without a recorded parent. A loopback test with OpenCode v2.3.0 confirmed this grouping. The official free model rejected the single-request baseline with a 429, so the test did not establish whether these headers affect upstream limits.

`host`, `content-length`, `connection` are written by the transport (§2.3).

The session id reproduces the CLI encoding: `ses_` + a 48-bit time field (descending `~(ms*0x1000+counter)`, small counter) + 14 base62 chars. `x-opencode-project` follows the capture-verified official rule: git checkout → `sha1("git-remote:"+normalized remote)`; otherwise →`sha1("directory:"+realpath)` ([project-identity.ts](src/project-identity.ts)).

Why: the gateway compares UA and session headers as client identity; missing or wrong is refused. A versioned foreign product token (e.g. `deepseek-harness/<n>`) is refused, so DSH attribution is off by default (`userAgentAttribution` enables it). The project value is not checked; deriving it only matches the official client. Tracing headers are sent by the official client only with OTEL on; the bridge's early capture-based default minted a pair, an addition — disable `tracing` to match the default.

### 2.2 Body, system prompt and tool declarations

The outgoing body consists of (key order matches the official):

```jsonc
{
  "model": "...",
  "messages": [...],
  "tools": [...],                 // caller tools; a placeholder if none
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_completion_tokens": 32000  // always sent, catalog default; caller may override
}
```

`tool_choice` and `prompt_cache_key` are not sent (the captured client has neither); `temperature`/`stop`/`reasoning_effort` are forwarded when present. [preventive] The always-on output limit and key order are not currently checked; aligning them is preemption (`docs/evidence/tools-field-and-token-budget-2026-11-14.json`).

**System prompt**: one `system` message = DSH prompt + environment instructions, joined with `\n`. [checked] It must contain an `<env>` block: a 177-byte prompt with only the block passes, without it is refused (`docs/evidence/bun-env-hypothesis.json`). [user-free] The values are not checked — rewriting paths or flipping the git flag still passes (`docs/evidence/bun-env-strictness.json`); the plugin still generates them from the real directory so they are useful. [preventive] The official date line (frozen per session), intro sentence, 5th line (tmp preference), worktree-root/upward-git derivations and multi-turn `<system-update>` are not checked; the bridge copies them as insurance. The official harness text and Code Mode catalogue are not required — a synthetic catalogue passes too (`docs/evidence/bun-synthetic-catalog.json`).

**Tool declarations**: [user-free] the list content does not identify the client (a user can send any list/prompt via the official client, `docs/evidence/user-customization-round2-2026-11-13.json`, `user-add-tools-2026-11-13.json`), so only the caller's own tools are declared. But the shape has three [checked] requirements:

1. **At least one tool.** Empty is refused; any name works (`dsh_probe_tool` passes, `docs/evidence/bun-tool-minimum.json`, `any-tool-vs-read.json`). Caller tools suffice; with none, `planTools` adds a placeholder whose description discourages calls, and a stray call is dropped.
2. **Name shape.** Unrecognized names with underscores/dashes/dots/capitals are refused; recognized names may carry separators; at least one recognized name. `planTools` reduces to `[a-z0-9]` (counter on collision) and keeps a map back. This caused every refusal before 1.0.4 (error looked like quota exhaustion).
3. **Not many rich tools at once.** Real descriptions and complex schemas each trigger refusal (`docs/evidence/tool-gate-codemode-2026-11-17.json`).

**skill declaration**: the official client registers `skill` with `codemode:false` — like `subagent`, it stays on the native tool list and the model calls it directly, not through `execute`; the bridge likewise declares it direct when the step admits it, keeping it out of the SDK and out of `execute`'s nested tool set. [checked] The gateway fingerprints the recognized `skill` description: DSH's own wording is refused (`FreeUsageLimitError`) while the official text passes (`docs/evidence/skill-direct-gate-2026-11-25.json`), so the wire always carries the official `skill` description; the input stays DSH's `{name}` (also accepted), so dispatch needs no argument rewrite. See §5 for execution and permissions.

**Code Mode** keeps the wire list small. The anchors are not callable; `execute` and an admitted `subagent`/`skill` are. DSH's SDK renderer lists the remaining admitted tools in the system prompt with their real return types (`read`, for example, returns `{lines,totalLines}`). `subagent` keeps DSH's own argument schema. See §5 for execution and permissions.

### 2.3 TLS and HTTP transport

The transport makes the handshake and header shape look official. [preventive] As of 2026-11-17 the gate does not check this layer; reproduction only covers a future fingerprint check.

The official client runs on Bun; Node's TLS cannot express the same `ClientHello` (OpenSSL orders extensions itself, no post-quantum key share; ~274-byte hello vs 1482). [bun-transport.ts](src/bun-transport.ts) delegates to `wreq-js` (Rust+BoringSSL, same library as the official), configured from the capture with four corrections:

| Correction | Detail |
|---|---|
| `curvesList` | Drop the extra `MLKEM768` group; keep `X25519MLKEM768:X25519:P-256:P-384`. |
| `sigalgsList` | `0x0807` is ed25519, `0x0603` spelled `ECDSA+SHA512`; completes the captured 11. |
| Header casing | `Authorization`/`Content-Type`/`User-Agent`/`Connection`/`Accept`/`Host`/`Accept-Encoding`/`Content-Length` capitalised as captured. |
| Header positions | `Host`/`Accept-Encoding`/`Content-Length` supplied explicitly at positions 14–16. |

After these, the `ClientHello` has zero extension mismatches and is 1482 bytes. The request **header** text (dynamic values normalised) matches the capture apart from `x-opencode-project`; this is a header-shape comparison, not a whole-request byte match (the two records are 23,073 vs 951 bytes, different bodies) (`docs/evidence/clienthello-deep-2026-11-13.json`, `byte-exact-2026-11-13.json`). A persistent Transport reuses one connection across turns; only `http/1.1` is offered, no `h2`.

**Fallback**: `wreq-js` is optional; without its native binding or with `bunTransport:false` the adapter falls back to plain `fetch`, losing TLS alignment but still working (in some proxy setups plain fetch cannot connect at all, so the transport has value beyond fingerprinting). The runtime is not the gate differentiator: a zero-tool body is refused with `FreeUsageLimitError` on both Bun and Node (`docs/evidence/bun-runtime-test.json`, two records).

## 3. Model catalog

[catalog.ts](src/catalog.ts) reads the official stable v1 catalog `https://models.opencode.ai/api.json`, taking `opencode`-provider models with zero cost and not `deprecated`. Official v2.3.0 reads the same service's v2 catalog with cache/bundled snapshot; same origin, the plugin has not migrated to v2.

| Item | Value |
|---|---|
| Refresh | 5 min (official TTL); `modelRefreshIntervalMs:0` disables polling, keeps startup prefetch + on-demand cache |
| Failure | keep last snapshot, retry after 60s; atomic commit, `onUpdated` only on real change |

No more `/models` probe: on 2026-11-15 the catalog and live availability matched exactly, the probe added nothing and is a request shape the official client never sends. The catalog also carries `interleaved.field` (reasoning replay field, §2.2/§4) and `limit.output` (output limit).

## 4. Messages and attachments

Message mapping (DSH → wire):

| DSH | Wire |
|---|---|
| `options.system` / `role:system` | folded into the leading `system` (§2.2) |
| `role:developer` | dropped — tool changes already in `options.tools` |
| `role:tool` | `{role:tool, tool_call_id, content}`; empty result sends `''` |
| `role:assistant` | `content` texts joined with `''`; `null` only when tool calls exist and no text; `reasoning_content` when reasoning exists or the model requires it |
| user content | text/`image_url` kept in order on vision routes |

**Reasoning replay**: when the catalog declares a reasoning field (e.g. big-pickle), every assistant row replays it (empty string when no reasoning). Optional trimming (`trimCompletedReasoning`) removes only completed-turn reasoning, verified by message id + SHA-256; in-flight/failed/interrupted chains are kept; affects new requests only, never deletes local history.

**Images**: [image-input.ts](src/image-input.ts) uses only the public attachment API, never guesses store paths; only routes declaring `image` input read bytes. Default budgets 4 MP, 1 MiB per image, 20 MiB total, 20 occurrences; over budget returns `IMAGE_OFFLOAD_REQUIRED`, never silently drops. Tool-result images are hoisted after the contiguous tool-result group as one associated user message.

## 5. Tool execution

After the model issues a call, execution and permissions stay in DSH; the bridge adds no separate flow.

- Returned calls keep id, name and raw argument bytes; lookup and schema validation are DSH's. The batch is buffered until `finish_reason:tool_calls`; a truncated batch returns `TOOL_BRIDGE_INCOMPLETE` and dispatches nothing.
- DSH's existing tools handle direct `subagent` and `skill` calls, including model selection, permissions, and result delivery. `execute` borrows the current step's tool set and excludes `subagent`, `skill` and `execute` from nested dispatch without changing the outer tool set or registry.
- The adapter drops placeholder calls. In Code Mode, it also drops calls to anchors and other tools not admitted for direct calls, and logs a warning.
- **Code Mode execution side**: `execute` is an ordinary registered tool whose body delegates to a `PtcExecutor` running `run_code`, reusing DSH's native PTC sandboxed runtime and guarded nested dispatch; nested tool calls still go through DSH permissions and dispatch. DSH's `run_code` is executor-private and unregistrable, so `execute` carries it. Enabled only on free routes admitting `execute`; without a host PTC it falls back to direct declaration. Behavior is closer to DSH's PTC mode. Verified end to end: simple answer, four-step read/write, six-step task with parallel reads and `edit` (`docs/evidence/codemode-complex-test-2026-11-17.json`). Known boundary: the SDK renders parameters as TypeScript types and cannot express numeric caps like `read`'s `limit<=2000`, so the model may guess large, get refused, then correct (same as native PTC rendering).

## 6. Error handling and diagnostics

- **Streaming**: incremental SSE parse; a stream failure after output starts is not replayed (`PARTIAL_STREAM_ERROR`).
- **Free-quota refusal**: 429 + `FreeUsageLimitError` → `FREE_USAGE_LIMIT`, turn ends, no auto-retry, no retry wait passed on; raw `Retry-After` kept only in diagnostics.
- **Wait scope**: new requests inherit no per-model wait; no in-memory model lock, no cooldown files; upgrade clears legacy files.
- **Transient rate limit**: retries scheduled by DSH (max 2, initial 2s, jitter 0.2); retryable wait capped at 15 min, raw value in diagnostics.
- **Clear cooling**: one RPC synchronously clears pool waits, backoff counters and legacy files; no restart needed.
- **Cancellation**: checked before POST, after buffering, before each tool block.

Per official v2.3.0 error classification and ModelRetry: quota refusal is not auto-retried; only transient/internal errors use retry waits, capped at 15 min. Official general retry budget is 10; the plugin keeps DSH's 2. What is aligned is quota handling and wait scope, not replacing the host retry loop.

Upstream-change table:

| Symptom | Likely cause | Action |
|---|---|---|
| `403 FreeTierError` | identity shape refused | check UA, session headers, ≥1 tool, `<env>` block (§2). |
| `429 FreeUsageLimitError` | free-lane refusal or real quota | compare same egress/model/time; the error name cannot confirm IP quota. |
| `400 MissingSessionID` | missing session header | session generation broken. |
| endpoint `404`/`426` | route migration | re-read catalog `provider.api`. |
| empty catalog | catalog request failed | check logs; last snapshot retained. |

**Diagnostics**: failed requests append `request shape` and `tool schema shape` summaries sharing the `request` id; success summaries only at `debug`. Summaries carry metadata only (path, transport, bytes, roles/lengths, env-block count, image count, tool pairing, schema structure stats) — never bodies, arguments, results, images or secrets; caps 8 MiB/512 messages/128 tools/8192 nodes/depth 32, over-cap marked `capped`. `transport:configured` only means a dedicated transport was set, not TLS byte proof.

**Log rotation**: the logger checks file size before writing. By default, it keeps up to five files including the active one, at up to 512 KiB each, dropping the oldest file first. A cleanup pass runs at startup and once an hour while the plugin is running. It removes records older than seven days by timestamp, preserving newer records in the same file. Oversized files keep only the newest complete lines that fit. If rotation or a disk write fails, the logger buffers failed records in memory rather than growing an oversized file.

**Safety & privacy**: no credentials read beyond the configured `apiKey`; proxy URLs redacted in all logs/UI; image data never logged at any level (test-asserted); no new `exec`/`spawn`.

## 7. Configuration

| Key | Default | Purpose |
|---|---|---|
| `baseUrl` | `https://opencode.ai/inference/v1` | relay base |
| `apiKey` | `public` | signed-out sentinel |
| `userAgent` | `opencode/latest/2.2.0/cli` | identity UA |
| `userAgentAttribution` | `false` | append DSH attribution |
| `client` | `cli` | `x-opencode-client` |
| `requestIdHeader` | `false` | send `x-opencode-request` (1.x) |
| `tracing` | `true` | send `b3`/`traceparent` |
| `bunTransport` | `true` | use Bun-shaped TLS when available |
| `toolStrict` | `true` | add `strict:false` to tools |
| `minOutputTokens` | `32000` | output-limit floor |
| `project` / `projectDirectory` | `global` / `''` | explicit project / derivation dir |
| `providers` | `['opencode-bridge']` | served provider routes |
| `includeDeprecated` / `extraModels` | `false` / `[]` | catalog filter/append |
| `requestTimeoutMs` | `600000` | per-request deadline |
| `modelRefreshIntervalMs` | `300000` | catalog refresh; 0 disables polling |
| `trimCompletedReasoning` | `false` | context trimming |
| `toolResultImages` | `true` | forward tool images on vision routes |
| `requestImagePixelBudget` / `requestImageMaxBytes` / `maxRequestImageBytes` / `maxRequestImages` | `4194304`/`1048576`/`20971520`/`20` | image budgets |
| `proxies` / `proxyCooldownMs` / `proxyStorePath` | `[]`/`60000`/`''` | egress pool |
| `logLevel` / `logDir` | `warn`/`''` | Minimum log level / log directory (empty uses the default) |
| `logMaxBytes` / `logMaxFiles` | `524288`/`5` | Bytes per log file / files retained (including the active file) |
| `logMaxAgeDays` | `7` | Days to keep; `0` disables age cleanup, not size rotation |

## 8. Testing

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json   # build
node --test tests/*.test.mjs                            # full offline suite
```

All offline; `tests/*-live.mjs` probes need explicit `--run` and refuse to overwrite existing reports.

| Suite | Coverage |
|---|---|
| `current-protocol`/`alignment`/`gateway-requirements`/`official-fidelity` | wire shape, headers, tool declarations, `<env>`, placeholder, preventive camouflage |
| `bun-transport` | captured cipher/extension config |
| `bridge-integration`/`bridge-stream` | batch atomicity, stream assembly |
| `reasoning-*` | replay, trimming eligibility |
| `image-*`/`vision-*` | attachment projection, budgets, tool-image hoisting |
| `retry-integration`/`proxy-rotation` | server waits, pool cooling, no-replay |
| `project-identity`/`request-waits`/`official-cooldown-policy` | identity derivation, legacy cleanup, instant clearing |
| `catalog-*`/`log-*`/`client-boot`/`references`/`evidence-links` | catalog, redaction, settings, credits & evidence consistency |

Live probes (consume real quota): `smoke`, `tool-loop-live` (one three-round session, 10 checks, `docs/evidence/tool-loop-live-2026-11-14.json`), `proxy-live`, `vision-compat-live`, `reasoning-*`, `wire-dump`, `official-client-ab-live` (same-host same-model comparison vs the official CLI, `docs/evidence/official-client-comparison-2026-11-17.json`: 7/52 synthetic tools, 52 tools + 60 KB prompt, max ~72 KB). A fully green offline suite can still be wholly refused by the gate (before 1.0.4, 418 offline tests passed while every real request was refused), so shape problems must be found live.

## 9. Document maintenance rules

- This file and the [Chinese version](TECHNICAL.md) change together; user-visible features, protocol principles, recorded constants, build/release flow or version changes update both. Version changes also sync the README install commands in both languages to match `package.json`'s `version` (`tests/readme-version.test.mjs` enforces).
- **When plugin logic changes, this technical design must be updated in both languages**, and the whole document re-read to keep the context coherent, the structure clear and nothing ambiguous; do not patch one spot and leave contradictions elsewhere.
- Every change to the plugin (feature, fix, protocol, docs) is recorded in the standalone changelog ([CHANGELOG.us.md](CHANGELOG.us.md)/[CHANGELOG.md](CHANGELOG.md)); this file keeps no separate change log.
- Consulting a new project updates [README credits](README.us.md#references-and-credits) and §10 here.
- Two evidence rules (`tests/evidence-links.test.mjs` enforces): every referenced file ships with the repo (captures go in [`docs/evidence/`](docs/evidence/README.md)); never mention unpublished content.

**Re-deriving a constant**: the constants here (UA, headers, tool shape, TLS parameters) are dated observations. When upstream changes make one stale, re-measure it instead of guessing:

1. Capture with the installed official client: local loopback endpoint, isolated config, local fake model; record request headers, body and TLS `ClientHello`.
2. Compare against the current values in `buildHeaders`/`buildChatMessages`/`BUN_TLS_EMULATION`.
3. Change only what the capture contradicts, in the capture's direction.
4. Add or update an assertion pinning the value in `tests/`.
5. Sync this file and the Chinese version, and record it in the CHANGELOG.

## 10. Community projects consulted

Every protocol behaviour comes from measuring the official client, not from any community project. The projects below were compared during design only. **No code was copied from any of them.**

| Project | Relationship | Licence |
|---|---|---|
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | Peer adapter; compared tool-filling and config | MIT |
| [x5427876/dsh-opencode-free](https://github.com/x5427876/dsh-opencode-free) | Peer adapter; compared aliasing and call blocking | MIT |
| [DragonHorizon-xtihc/dsh-connect-opencode-free](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free) | Peer adapter; compared placeholder suppression | MIT |
| [1624318455/dsh-plugin-adapter](https://github.com/1624318455/dsh-plugin-adapter) | Peer adapter; earlier tool-filling | MIT |
| [randomix777/dsh-opencode-zen](https://github.com/randomix777/dsh-opencode-zen) | Peer adapter; compared catalog refresh and caching | MIT |
| [seonzzy/dsh-zen-adapter](https://github.com/seonzzy/dsh-zen-adapter) | Peer adapter; compared catalog discovery | MIT |
| [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) | Read only its issues on free quota decaying per egress IP | GPL-3.0 |

opencode2api is GPL-3.0; only its issues were read and no code was used, so its licence does not bind this project; re-evaluate compatibility before ever using its code. This section and the README's matching section are one list; update both together.

