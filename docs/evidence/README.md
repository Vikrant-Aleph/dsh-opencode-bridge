# Evidence

Dated captures behind the claims in [TECHNICAL.us.md](../../TECHNICAL.us.md) and the [camouflage policy](../../CAMOUFLAGE.us.md). The records preserve observed results and experiment context so readers can check the claims.

**These are dated observations.** The free tier changes; a capture from 2026-11-13 may describe a gate that no longer behaves that way.

## How the captures were produced

1. Run the installed official CLI with `--standalone`, an isolated config directory and a loopback endpoint, so its real request is recorded without touching the upstream.
2. Replay the request from a single runtime, changing **one field per request**.
3. Keep a change only when the outcome flips; revert everything that does not.

A request is refused with `FreeUsageLimitError` (429) when it fails the check and with `FreeTierError` (403) when the identity shape is rejected. A plain `curl` request receives the same 429 as a fully aligned one, because the quota check runs before the identity check — so a 429 alone says nothing about whether an imitation succeeded.

## What each file shows

| File | Finding |
|---|---|
| `bun-tool-minimum.json` | At least one tool must be declared; `read` alone passes, zero tools is refused |
| `any-tool-vs-read.json` | The tool name does not matter — a custom tool passes without `read` |
| `bun-env-hypothesis.json` | An `<env>` block in the system prompt is required; a 177-byte prompt containing only it passes |
| `bun-env-strictness.json` | The `<env>` values are not checked — rewriting paths or flipping the git flag still passes |
| `bun-synthetic-catalog.json` | The official Code Mode catalogue is not required |
| `bun-runtime-test.json` | Zero-tool bodies refused with `FreeUsageLimitError` on both Bun (2026-11-13) and Node (2026-11-18 supplement); two records, so the runtime is not the differentiator |
| `user-customization-round2-2026-11-13.json` | A user can replace the system prompt through three documented mechanisms |
| `user-add-tools-2026-11-13.json` | A plugin can add arbitrary tool names and schemas |
| `clienthello-deep-2026-11-13.json` | Field-level comparison of the official and bridge `ClientHello` |
| `byte-exact-2026-11-13.json` | Normalized request HEADER text matches apart from the directory-derived project id; a header-shape comparison, not a whole-request byte match (full sizes differ: 23,073 vs 951) |
| `verify-env-fix.json`, `repeat-1.json`, `placeholder-verify.json` | The adapter's own path returning 200 and answering |
| `tools-field-and-token-budget-2026-11-14.json` | Omitting `tools` is refused while a placeholder passes; a small `max_completion_tokens` is accepted; a system message rendered as a user message is accepted but not adopted |
| `tool-loop-live-2026-11-14.json` | ONE live three-round session with a thinking model; all 10 checks passed (a single session, not ten runs). Each result feeds the next round; later requests replay the assistant turn and its `reasoning_content` |
| `official-client-comparison-2026-11-17.json` | Official v2.3.0 and plugin success on the same host/model, including 52 synthetic tools and a 72 KB request; also records the offline reproduction of a cleared store still blocked by the old adapter Map |
| `tool-gate-codemode-2026-11-17.json` | The free lane refuses rich tool declarations (real description text and complex schemas each trigger it); a same-size neutral block passes. Records the Code Mode fix, the real-return-type catalog, and end-to-end verification |
| `codemode-agent-test-2026-11-17.json` | End-to-end four-step task in a real free-model session: read package.json, glob src, write a report, read it back — all through `execute` |
| `codemode-complex-test-2026-11-17.json` | End-to-end six-step complex task: glob + grep + parallel reads with import parsing + write + `edit` append + read-back verification, completed correctly |

