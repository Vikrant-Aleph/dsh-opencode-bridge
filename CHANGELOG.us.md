# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are published from `v*` tags, and the notes on the release page are taken from
the matching section of this file.

## [Unreleased]

## [1.0.1] - 2026-11-14

### Fixed

- A stored cooldown was read once at startup, so clearing the file had no effect until a
  restart. The store now re-reads it before every check, and an external clear applies
  immediately.
- Cooldowns are recorded with the egress that produced them and stop applying once that
  egress is no longer configured. Previously a wait from a removed proxy kept blocking
  the model.
- The cooldown error now states that no request was sent and reports when and on which
  egress the rejection was recorded, so it cannot be mistaken for a live 429.

### Added

- Settings → Egress rotation → **Clear cooldowns**, which retires stale records without
  a restart.


## [1.0.0] - 2026-11-13

The release that answers the question the project was built around: what does the free
tier actually check?

### Found

Measured against the real gateway, one variable at a time from a single runtime. Three
things are checked:

- The `User-Agent` must be `opencode/latest/2.2.0/cli`.
- **At least one tool must be declared.** The name does not matter; an empty array is
  refused.
- **The system prompt must contain an `<env>` block.** A 177-byte prompt containing
  nothing else passes.

The last two were the missing pieces. The plugin declared only the caller's tools — often
none — and sent DSH's prompt unchanged, so every request was refused with
`FreeUsageLimitError` however closely the headers matched.

### Added

- `src/bun-transport.ts`: reproduces the official client's TLS handshake through the
  optional `wreq-js` dependency — cipher suites, supported groups, signature algorithms
  (including `ed25519` as `0x0807` and `ecdsa_secp521r1_sha512` as `0x0603`), extension
  order, and `http/1.1`-only ALPN. The `ClientHello` matches the capture byte for byte
  once random fields are normalised.
- HTTP framing alignment: header names, casing and order, `accept-encoding`,
  `keep-alive`, and a persistent connection pool reused across turns.
- An environment block generated from the real working directory and appended after the
  DSH prompt.
- `docs/evidence/`: the captures behind every claim, published so a reader can check
  them. Guarded by `tests/evidence-links.test.mjs` and `tests/doc-links.test.mjs`.
- `scripts/clean.mjs`, run before every build, so removed modules cannot leave compiled
  output behind.
- `CHANGELOG.md`, with the release page generated from it by
  `scripts/release-notes.mjs`.
- Chinese is now the primary documentation language: `README.md`, `TECHNICAL.md` and
  `CAMOUFLAGE.md` are Chinese, and the English versions carry a `.us` suffix.

### Changed

- Tool declarations are exactly the caller's tools. A placeholder is added only when the
  caller declares none; its description says not to call it, and a call that happens
  anyway is dropped with a `warn` log entry instead of failing the turn.
- The adapter waits for a transport that is still resolving, so the first request after
  plugin load no longer falls back silently to plain `fetch`.
- The egress pool's selected proxy URL now reaches non-undici transports, so rotation
  works while the Bun-shaped transport is active.

### Fixed

- The Bun-shaped transport was never wired to the adapter, so earlier transport work had
  no effect on requests.
- `package.json` carried a byte-order mark, which made it invalid JSON for strict
  parsers.
- Stale compiled modules and a missing published-docs entry were shipping in the package.

### Removed

- **Breaking:** `toolFingerprint` and `toolTranslation` configuration keys.
- **Breaking:** the `opencode_bridge_audit` tool, along with the tool-bridge layer it
  described.
- `docs/COMPARISON.zh.md` and `docs/research-notes/`, which documented that removed
  architecture.

### Upgrade

Configuration keys that no longer exist are ignored, so an existing config keeps working.
If you relied on `opencode_bridge_audit`, that tool is gone. `wreq-js` is an optional
dependency: without its native binding the plugin falls back to plain `fetch` and loses
only the TLS alignment.

## [0.5.5] - 2026-10-23

### Added

- Optional trimming of completed-turn reasoning, with a persistent Settings tab.

## [0.5.4] - 2026-10-22

### Added

- Image input through DSH's attachment request-version API.
- Tool-result image hoisting after the contiguous tool result group.

## [0.5.3] - 2026-10-21

### Fixed

- Assistant reasoning history is replayed for thinking-mode tool calls, including an
  explicitly empty reasoning field where the model requires one.

## [0.5.2] - 2026-10-19

### Changed

- Bounded retries with safe 429 diagnostics and a strict cooldown that never shortens a
  server-requested wait.

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

[Unreleased]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v1.0.0
[0.5.5]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.5
[0.5.4]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.4
[0.5.3]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.3
[0.5.2]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.2
[0.5.1]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.5.1
[0.4.1]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.4.1
[0.3.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.3.0
[0.1.0]: https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/tag/v0.1.0
