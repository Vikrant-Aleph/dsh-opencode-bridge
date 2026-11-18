# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are published from `v*` tags, and the notes on the release page are taken from the matching section of this file.

## [Unreleased]

## [1.2.0] - 2026-11-19

### Added

- **Preventive camouflage (not currently checked; preempts future fingerprinting).** Replicated a set of always-sent, non-gate official details from source (cross-checked against v2.2.0): the system-prompt date line (frozen per session), the `<env>` intro line and 5th line (tmp preference), `Workspace root folder` = git worktree root, upward `.git` discovery for the git flag, multi-turn changes as `<system-update>` user messages (baseline not re-appended), always-on `max_completion_tokens` (default 32000) on primary requests, empty-string reasoning replay on every assistant message when the catalog declares a reasoning field (e.g. big-pickle), and body key order with `tools` before `stream`. None of these was a gate condition in the 2026-11-17 probes.

### Changed

- **Technical design rewritten.** New order: architecture → client camouflage → model catalog → messages & attachments → tool execution → error handling & diagnostics → configuration → testing → document maintenance rules (moved to the end), credits as an appendix. The camouflage chapter follows the request composition (headers & session info / body, system prompt & tool declarations / TLS & HTTP transport), tagging each item checked / preventive / user-free; Code Mode's declaration shape lives in the camouflage chapter and its execution & permissions in tool execution, no longer explained twice. The architecture diagram shows both declaration paths and the no-PTC fallback.
- **Camouflage principle reworded** to "keep official-consistent details that user settings cannot change": checked ones must match, unchecked ones are kept as prevention; removed the absolute "do not imitate what the gateway does not check".
- **Unwrapped mid-sentence hard line breaks in all md**, so rendered Chinese has no stray spaces (code fences, tables, headings, lists preserved).
- **Maintenance rules strengthened**: plugin logic changes must update the technical design in both languages with a full re-read for coherence, clarity and no ambiguity; every plugin change is recorded in the standalone CHANGELOG; "re-derive a constant" is now a five-step procedure with its purpose stated.

### Fixed

- **Corrected three evidence claims.** The runtime comparison gained a real Node zero-tool record paired with the Bun one; "byte-identical apart from one field" is scoped to the normalized request header text (full request sizes differ); the tool-loop "10/10" is now "one three-round session, all 10 checks passed", not ten independent runs.

## [1.1.1] - 2026-11-18

### Fixed

- **Loosened the DSH version floor for the optional PTC components.** 1.1.0 pinned the five optional peers `dsh-tools`, `dsh-scope`, `dsh-system-prompt`, `dsh-ptc-runtime`, `dsh-tool-executor-ptc` to `>=0.2.2-rc.3`, so the install gate rejected older DSH such as 0.2.2-rc.1. These components only serve the guarded Code Mode (enabled only when the host provides `ptcRuntime`, otherwise it falls back to plain declaration) and must not raise the whole-plugin floor. They are now `>=0.2.1-rc.2`, matching the other optional peers.

## [1.1.0] - 2026-11-18

### Added

- **Free models now declare tools via Code Mode.** The free lane refuses a request that declares many rich tools (real descriptions + complex schemas) at once. The wire now declares only a few simple anchor tools plus `execute`, the real tool catalog moves into the system prompt, and the model calls tools through a program passed to `execute`, reusing DSH's native PTC sandboxed runtime and guarded nested dispatch. The behavior is closer to DSH's PTC mode; only the free-model routes are affected, and other agents keep their executor.
- **The Code Mode catalog shows real return types.** It renders the SDK from each tool's actual output schema (e.g. `read` returns `{lines,totalLines}`), so the model parses returns by type instead of guessing. Verified end-to-end in a real free-model session: a simple reply, a four-step read/write task, and a six-step complex task with parallel reads and an `edit` append all completed correctly.
- **Persistent redacted request summaries.** Failures record route, transport, controls and message/tool structure by default; successful requests record summaries only at Debug. Message text, tool arguments, images, keys and arbitrary schema literals are excluded, with size and depth budgets.
- The log tool's `stat` reports the diagnostics format version so a running-code update can be checked.
- Cumulative npm download charts in both READMEs, including the full history since the first release, the total count and the statistics cutoff date. GitHub Actions updates the charts and daily data each day; a failed statistics request preserves the previous charts.

### Changed

- Short package, marketplace and settings summaries state that no OpenCode installation is required.

### Fixed

- **Clear cooldowns takes effect immediately.** It clears live pool waits, backoff counters and legacy model files. The adapter no longer keeps a second model lock that survives until restart.
- **Quota wait scope follows the official client.** `FreeUsageLimitError` ends the run without automatic retries, a retry-delay hint or a cross-request cooldown. Eligible retry hints are capped at 15 minutes; diagnostics retain the original value.
- Updated live probes to the current catalog constructor and UA constant, and made the proxy probe require an explicit `--run`.
- Added same-host official v2.3.0 comparisons and cooldown-clear regression coverage. Requests with 7/52 synthetic tools and roughly 72 KB bodies succeeded; the root cause of the real 46-tool refusal (rich description and schema content) was located and is fixed by the Code Mode change above.

## [1.0.8] - 2026-11-16

This release updates the icon and documentation layout without changing model requests.

### Changed

- **Replaced the shared plugin icon.** A 256×256 WebP replaces the SVG. The icon export, package file list and both READMEs use the new file.
- **Updated the README header.** The title and badges are centred, with the icon directly to the title's left and aligned along its bottom edge. The language switcher stays left-aligned.
- Replaced the four plugin marks in the Chinese and English structure diagrams, preserving the remaining text and graphics.

## [1.0.7] - 2026-11-15

### Changed

- **A new plugin icon.** It follows the official `artwork.md` rules: a 36x36 canvas, no tile of its own, the subject drawn inside the margins, pure SVG geometry, 2.9 KB. The old one used a 64x64 canvas with its own dark tile, which stacked a second tile inside the one Plugin Manager draws.
- The README shows the icon at the top, by absolute URL so the npm page renders it too.

This release includes everything in 1.0.6. That version has a GitHub tag and release but never reached npm, because the publish was refused for a missing two-factor code.

## [1.0.6] - 2026-11-15

The model list now refreshes the way the official client does, along with the documentation that accumulated after 1.0.5.

### Changed

- **One catalog source.** The plugin reads only `https://models.opencode.ai/api.json`, the same catalog the official client's `ModelsDev.Service` reads, and refreshes on the official five-minute TTL instead of ten minutes.
- **The live `/models` probe is gone.** It existed to decide which models were actually served. Measurement showed it added nothing: the twelve zero-cost, non-deprecated catalog entries matched the live list exactly, and the 74 extra ids the listing returned were paid models. Availability is already carried by the catalog's `status` field. As a side effect the plugin no longer sends a request the official client never makes.

### Fixed

- **The README's document links are absolute now.** npm renders the page outside any repository, where a relative `TECHNICAL.md`, `CAMOUFLAGE.md` or `LICENSE` points at nothing. On GitHub the links behave as before.
- This also ships the documentation accumulated since 1.0.5: the structure diagram, the stars and last-commit badges, the consulted-projects list, and the install section moved up.

## [1.0.5] - 2026-11-15

Copy only. After 1.0.0 removed the tool bridge and the offline audit, the package description, the marketplace copy and the settings-page intro still advertised both.

### Fixed

- **The package description and two copies are updated.** `package.json`, `locale/en.json`, `locale/zh.json` and the plugin's settings intro now describe what the plugin does: no account or API key, the official client's request shape and fingerprints, automatic model refresh, optional context trimming, optional egress rotation.
- Added a regression check: the description fails if either the tool bridge or the audit reappears. A test had been asserting the old wording, which is how the stale copy survived.

## [1.0.4] - 2026-11-14

The release that explains why the UI never worked.

### Fixed

- **Tool names containing separators are refused by the gateway.** Almost every one of DSH's 46 tools carries an underscore (`ask_user_question`, `job_list`, `web_search`, and so on), and the gateway answers such a request with `FreeUsageLimitError`, which reads like an exhausted quota. All 12 official tools are free of separators. Declared names are now reduced to `[a-z0-9]` and a returned call is mapped back to the caller's real tool, so dispatch is unaffected.
- The model listing request carried only `user-agent`, without `authorization` or the `x-opencode-*` headers. The official client never sends that shape; the listing now carries the full identity.
- All system text is folded into one message, matching the official client, with the `<env>` block after the prompt.

## [1.0.3] - 2026-11-14

### Fixed

- The gateway's `Retry-After` points at UTC midnight, but it serves again within minutes. The plugin used to lock the model for the stated duration, turning a transient refusal into hours of downtime. It now retries with an exponential backoff: 60 seconds, doubling, capped at 15 minutes. The server's deadline is still recorded, but only as an upper bound and for diagnostics.
- The cooldown message now says the pause is this client's own backoff rather than the server's requested wait, and reports when the next automatic attempt is allowed.

## [1.0.2] - 2026-11-14

### Fixed

- A byte-order mark made the state file look corrupt, after which the store rebuilt cooldowns from the log and undid a clear. A BOM is now tolerated when reading.
- An unreadable state file no longer rebuilds cooldowns from the log. Recovery runs only when the file is genuinely absent; an existing file is authoritative, so a clear cannot be reverted by the log.

## [1.0.1] - 2026-11-14

### Fixed

- A stored cooldown was read once at startup, so clearing the file had no effect until a restart. The store now re-reads it before every check, and an external clear applies immediately.
- Cooldowns are recorded with the egress that produced them and stop applying once that egress is no longer configured. Previously a wait from a removed proxy kept blocking the model.
- The cooldown error now states that no request was sent and reports when and on which egress the rejection was recorded, so it cannot be mistaken for a live 429.

### Added

- Settings → Egress rotation → **Clear cooldowns**, which retires stale records without a restart.

## [1.0.0] - 2026-11-13

The release that answers the question the project was built around: what does the free tier actually check?

### Found

Measured against the real gateway, one variable at a time from a single runtime. Three things are checked:

- The `User-Agent` must be `opencode/latest/2.2.0/cli`.
- **At least one tool must be declared.** The name does not matter; an empty array is refused.
- **The system prompt must contain an `<env>` block.** A 177-byte prompt containing nothing else passes.

The last two were the missing pieces. The plugin declared only the caller's tools — often none — and sent DSH's prompt unchanged, so every request was refused with `FreeUsageLimitError` however closely the headers matched.

### Added

- `src/bun-transport.ts`: reproduces the official client's TLS handshake through the optional `wreq-js` dependency — cipher suites, supported groups, signature algorithms (including `ed25519` as `0x0807` and `ecdsa_secp521r1_sha512` as `0x0603`), extension order, and `http/1.1`-only ALPN. The `ClientHello` matches the capture byte for byte once random fields are normalised.
- HTTP framing alignment: header names, casing and order, `accept-encoding`, `keep-alive`, and a persistent connection pool reused across turns.
- An environment block generated from the real working directory and appended after the DSH prompt.
- `docs/evidence/`: the captures behind every claim, published so a reader can check them. Guarded by `tests/evidence-links.test.mjs` and `tests/doc-links.test.mjs`.
- `scripts/clean.mjs`, run before every build, so removed modules cannot leave compiled output behind.
- `CHANGELOG.md`, with the release page generated from it by `scripts/release-notes.mjs`.
- Chinese is now the primary documentation language: `README.md`, `TECHNICAL.md` and `CAMOUFLAGE.md` are Chinese, and the English versions carry a `.us` suffix.

### Changed

- Tool declarations are exactly the caller's tools. A placeholder is added only when the caller declares none; its description says not to call it, and a call that happens anyway is dropped with a `warn` log entry instead of failing the turn.
- The adapter waits for a transport that is still resolving, so the first request after plugin load no longer falls back silently to plain `fetch`.
- The egress pool's selected proxy URL now reaches non-undici transports, so rotation works while the Bun-shaped transport is active.

### Fixed

- The Bun-shaped transport was never wired to the adapter, so earlier transport work had no effect on requests.
- `package.json` carried a byte-order mark, which made it invalid JSON for strict parsers.
- Stale compiled modules and a missing published-docs entry were shipping in the package.

### Removed

- **Breaking:** `toolFingerprint` and `toolTranslation` configuration keys.
- **Breaking:** the `opencode_bridge_audit` tool, along with the tool-bridge layer it described.
- `docs/COMPARISON.zh.md` and `docs/research-notes/`, which documented that removed architecture.

### Upgrade

Configuration keys that no longer exist are ignored, so an existing config keeps working. If you relied on `opencode_bridge_audit`, that tool is gone. `wreq-js` is an optional dependency: without its native binding the plugin falls back to plain `fetch` and loses only the TLS alignment.

## [0.5.5] - 2026-10-23

### Added

- Optional trimming of completed-turn reasoning, with a persistent Settings tab.

## [0.5.4] - 2026-10-22

### Added

- Image input through DSH's attachment request-version API.
- Tool-result image hoisting after the contiguous tool result group.

## [0.5.3] - 2026-10-21

### Fixed

- Assistant reasoning history is replayed for thinking-mode tool calls, including an explicitly empty reasoning field where the model requires one.

## [0.5.2] - 2026-10-19

### Changed

- Bounded retries with safe 429 diagnostics and a strict cooldown that never shortens a server-requested wait.

## [0.5.1] - 2026-10-19

### Added

- Dynamic model catalog refresh.

## [0.4.1] - 2026-10-18

### Added

- SOCKS4/4a/5/5h proxies, DNS modes, and credential handling.

## [0.3.0] - 2026-10-18

### Added

- Egress proxy pool with rotation.

## [0.1.0] - 2026-10-17

### Added

- First release: gate reproduction, `OpenCodeFreeAdapter`, and the model catalog.

[Unreleased]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/compare/v1.0.0...HEAD [1.0.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v1.0.0 [0.5.5]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.5 [0.5.4]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.4 [0.5.3]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.3 [0.5.2]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.2 [0.5.1]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.1 [0.4.1]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.4.1 [0.3.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.3.0 [0.1.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.1.0

