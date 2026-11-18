# Camouflage policy

[中文](CAMOUFLAGE.md) | English · [Technical design](TECHNICAL.us.md)

What the bridge imitates, and why. This is the authority for the code: any imitation
not listed here should be removed. The measurements, controls and evidence live in
[TECHNICAL §3](TECHNICAL.us.md); this file lists only the conclusions and the trade-offs,
without repeating that data.

---

## The rule

> **Imitate only what the gateway actually checks.**

The original wording was "imitate only what the official client cannot let a user
change". Measurement on 2026-11-13 corrected it: a configurable field is ruled out as a
*fingerprint*; the gateway can still require its *default shape* as a
protocol precondition. The test is therefore "is it checked", not "is it configurable".

---

## What the gateway checks (must replicate)

"Currently" = **2026-11-17** (last live probe; this file updated 2026-11-18). Mismatch is refused.

| Requirement | How the bridge satisfies it | Detail |
|---|---|---|
| `User-Agent` | Sends the captured `opencode/latest/2.2.0/cli` byte-identically | §3.1 |
| Session and request identity | One session id in four headers; `x-opencode-project` derived from the real directory | §3.2 |
| Tool declarations | At least one tool (a placeholder only when the caller has none); separator-free names with a map back; free models use Code Mode | §3.3, §5.3 |
| An `<env>` block in the system prompt | Environment instructions appended after the DSH prompt | §3.4 |

The official client always sends these shapes, so a user cannot remove them. The three
tool-declaration gates — at least one tool, name shape, and not many rich tools at once —
are together in §3.3.

---

## Not checked, but still replicated (preventive only)

These are always-sent official features that, as of 2026-11-17, are **not** checked. They
are replicated only so a future gate comparing them item by item cannot distinguish the bridge.

| Surface | Note | Detail |
|---|---|---|
| Transport TLS / header order / connection reuse | `ClientHello` byte-aligned, http/1.1, keep-alive; necessity unproven | §3.5 |
| Date line / `<env>` intro / 5th line | Official built-in instructions, replicated | §3.7 |
| env derivations | worktree root, upward git discovery | §3.7 |
| Multi-turn `<system-update>` | frozen baseline; changes go in user messages | §3.7 |
| Always-on `max_completion_tokens` | catalog default 32000 | §3.7 |
| Catalog reasoning-field replay | empty string on every assistant message for e.g. big-pickle | §3.7 |
| Body key order | tools before stream | §3.7 |
| `b3`/`traceparent` | official sends them only with OTEL on, not by default; bridge can disable `tracing` | §3.7 |

---

## Not checked and not replicated (user-free content)

| Surface | Note |
|---|---|
| System prompt body | `agents.<name>.system`, `agents/<name>.md` can replace it entirely; still passes |
| Tool list content | Content is free; 12 tools down to 1 still passes |
| Contents of `<env>` | Rewriting paths or flipping the git flag still passes (only presence is checked) |
| Code Mode catalogue | A catalogue synthesised from different tool names still passes |

---

## Deliberately not done

- No rotating of IPs, sessions or identities to evade service limits.
- No executing tools inside another runtime: returned calls are dispatched by DSH.
- No imitation of what the gateway does not check.

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
