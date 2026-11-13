# Evidence

Dated captures behind the claims in [TECHNICAL.us.md](../../TECHNICAL.us.md) and the
[camouflage policy](../../CAMOUFLAGE.us.md). Every file here is a raw measurement, so a reader can check a claim
for themselves.

**These are dated observations.** The free tier changes; a capture from
2026-11-13 may describe a gate that no longer behaves that way.

## How the captures were produced

1. Run the installed official CLI with `--standalone`, an isolated config directory and
   a loopback endpoint, so its real request is recorded without touching the upstream.
2. Replay the request from a single runtime, changing **one field per request**.
3. Keep a change only when the outcome flips; revert everything that does not.

A request is refused with `FreeUsageLimitError` (429) when it fails the check and with
`FreeTierError` (403) when the identity shape is rejected. A plain `curl` request
receives the same 429 as a fully aligned one, because the quota check runs before the
identity check — so a 429 alone says nothing about whether an imitation
succeeded.

## What each file shows

| File | Finding |
|---|---|
| `bun-tool-minimum.json` | At least one tool must be declared; `read` alone passes, zero tools is refused |
| `any-tool-vs-read.json` | The tool name does not matter — a custom tool passes without `read` |
| `bun-env-hypothesis.json` | An `<env>` block in the system prompt is required; a 177-byte prompt containing only it passes |
| `bun-env-strictness.json` | The `<env>` values are not checked — rewriting paths or flipping the git flag still passes |
| `bun-synthetic-catalog.json` | The official Code Mode catalogue is not required |
| `bun-runtime-test.json` | Bun and Node are refused identically, so the runtime is not the differentiator |
| `user-customization-round2-2026-11-13.json` | A user can replace the system prompt through three documented mechanisms |
| `user-add-tools-2026-11-13.json` | A plugin can add arbitrary tool names and schemas |
| `clienthello-deep-2026-11-13.json` | Field-level comparison of the official and bridge `ClientHello` |
| `byte-exact-2026-11-13.json` | The HTTP request is byte-identical apart from the directory-derived project id |
| `verify-env-fix.json`, `repeat-1.json`, `placeholder-verify.json` | The adapter's own path returning 200 and answering |
