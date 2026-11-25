# Camouflage policy

[中文](CAMOUFLAGE.md) | English · [Technical design](TECHNICAL.us.md)

What the bridge imitates, and why. This is the authority for the code: any imitation not listed here should be removed. The measurements, controls and evidence live in [TECHNICAL §2](TECHNICAL.us.md); this file lists only the conclusions and the trade-offs, without repeating that data.

---

## The rule

> **Keep official-consistent details that user settings cannot change.**

The plugin emulates the official client by reproducing its always-sent details. The retention boundary is "user configuration cannot change it": official, user-invariant shapes and details may be kept; content left to the user by design (the system-prompt body, tool-list content, etc.) is not imitated.

Within that boundary, attitude splits by whether the gateway currently checks it: checked details must match; unchecked ones may still be kept as insurance against a future item-by-item gate. Both are "official details the user cannot change", so keeping the latter is not an exception but the same principle extended.

---

## What the gateway checks (must replicate)

"Currently" = **2026-11-25** (latest live probe; the tool-shape body was measured 2026-11-17). Mismatch is refused.

| Requirement | How the bridge satisfies it | Detail |
|---|---|---|
| `User-Agent` | Sends the captured `opencode/latest/2.2.0/cli` byte-identically | §2.1 |
| Session and request identity | Root sessions use one ID in four headers; see §2.1 for child-session lineage | §2.1 |
| Tool declarations | At least one tool (a placeholder only when the caller has none); separator-free names with a map back; free models use Code Mode | §2.2, §5 |
| `skill` description | The recognized `skill` description is fingerprinted: the wire always carries the official text (DSH wording is refused); `skill` is a direct tool like `subagent` | §2.2, `docs/evidence/skill-direct-gate-2026-11-25.json` |
| An `<env>` block in the system prompt | Environment instructions appended after the DSH prompt | §2.2 |

The official client always sends these shapes, so a user cannot remove them. The three tool-declaration gates — at least one tool, name shape, and not many rich tools at once —are together in §2.2.

---

## Not checked, but still replicated (preventive only)

These are always-sent official features that, as of 2026-11-17, are **not** checked. They are replicated only so a future gate comparing them item by item cannot distinguish the bridge.

| Surface | Note | Detail |
|---|---|---|
| Transport TLS / header order / connection reuse | `ClientHello` byte-aligned, http/1.1, keep-alive; necessity unproven | §2.3 |
| Date line / `<env>` intro / 5th line | Official built-in instructions, replicated | §2.2 |
| env derivations | worktree root, upward git discovery | §2.2 |
| Multi-turn `<system-update>` | frozen baseline; changes go in user messages | §2.2 |
| Always-on `max_completion_tokens` | catalog default 32000 | §2.2 |
| Catalog reasoning-field replay | empty string on every assistant message for e.g. big-pickle | §2.2 |
| Body key order | tools before stream | §2.2 |
| `b3`/`traceparent` | official sends them only with OTEL on, not by default; bridge can disable `tracing` | §2.2 |

---

## Not checked and not replicated (user-free content)

| Surface | Note |
|---|---|
| System prompt body | `agents.<name>.system`, `agents/<name>.md` can replace it entirely; still passes |
| Tool list content | Content is free; 12 tools down to 1 still passes |
| Contents of `<env>` | Rewriting paths or flipping the git flag still passes (only presence is checked) |
| Code Mode catalogue | A catalogue synthesised from different tool names still passes |

---

## Explicitly not done

- No swapping IPs, sessions or identities to bypass service limits.
- Tools are dispatched by DSH and permissions are managed by DSH. The bridge adds no separate tool-execution or authorization flow.

---

## Ruled out

Each of these was disproved by measurement and is recorded so the work is not repeated.

| Hypothesis | Result |
|---|---|
| User-Agent | Aligned to the capture; insufficient alone |
| Endpoint lane | All four paths behave identically |
| Stale session id | A fresh session fails the same way |
| Egress IP quota | A brand-new IP still refused the bridge while the official client passed |
| Proxy process routing | The same egress IP under both process names |
| TCP write coalescing | Differs, but is timing-dependent and implausible as a gate |
| TLS fingerprint alone | Byte-identical, still refused |
| Runtime | Bun with the same body fails identically |
| "The lane opens in windows" | An artefact: hand-built probes lacked the `<env>` block, so they were always refused and looked like a closed lane |

