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

## What is checked

| Requirement | How the bridge satisfies it | Detail |
|---|---|---|
| `User-Agent` | Sends the captured `opencode/latest/2.2.0/cli` byte-identically | §3.1 |
| Session and request identity | One session id in four headers; `x-opencode-project` derived from the real directory | §3.2 |
| Tool declarations | At least one tool (a placeholder only when the caller has none); names sanitized to separator-free with a map back; free models use Code Mode to avoid declaring many rich tools at once | §3.3, §5.3 |
| An `<env>` block in the system prompt | `environmentBlock()` appended after the DSH prompt, from the real working directory | §3.4 |

The official client always sends these shapes, so a user cannot remove them. The three
tool-declaration gates — at least one tool, name shape, and not many rich tools at once —
are together in §3.3.

---

## What is not checked

| Surface | Note |
|---|---|
| System prompt | `agents.<name>.system`, `agents/<name>.md` can replace it entirely; still passes |
| Tool list | Content is free; 12 tools down to 1 still passes |
| Contents of `<env>` | Rewriting paths or flipping the git flag still passes |
| Code Mode catalogue | A catalogue synthesised from different tool names still passes |
| `b3`, `traceparent` | Minted per request; no fixed value |
| `x-opencode-project` | Derived from the working directory |
| Runtime | Bun and Node are refused identically (zero-tool body) |
| Transport fingerprint | Not currently checked; reproduced only for the future (below) |

---

## Transport (TLS)

**The gate does not currently check this layer.** `src/bun-transport.ts` delegates the
handshake to `wreq-js` (BoringSSL, the same library the official client uses). The
`ClientHello` is aligned byte for byte with the capture, but its **necessity is
unproven** — it exists to cover fingerprint checks that may appear later. The handshake
parameters and the four corrections are in [TECHNICAL §3.5](TECHNICAL.us.md).

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
