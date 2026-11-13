# Camouflage policy

[中文](CAMOUFLAGE.md) | English · [Technical design](TECHNICAL.us.md)

What the bridge imitates, and why. This is the authority for the code: any imitation
not listed here should be removed.

---

## The rule

> **Imitate only what the gateway actually checks.**

The original wording was "imitate only what the official client cannot let a user
change". Measurement on 2026-11-13 corrected it: a configurable field is ruled out as a
*fingerprint*; the gateway can still require its *default shape* as a
protocol precondition. The test is therefore "is it checked", not "is it configurable".

---

## What is checked

| Requirement | What we measured | Evidence |
|---|---|---|
| `User-Agent` | Must be `opencode/latest/2.2.0/cli`; everything else correct is not enough | Community reports and this project's probes |
| **At least one declared tool** | Any name works; a single tool is enough; an empty array is refused | `docs/evidence/bun-tool-minimum.json`, `docs/evidence/any-tool-vs-read.json` |
| **An `<env>` block in the system prompt** | A 177-byte prompt containing only that block passes; removing it is refused | `docs/evidence/bun-env-hypothesis.json` |

The last two are the key ones: the official client generates them automatically, so a
user cannot remove them.

---

## What is not checked

| Surface | User control | Evidence |
|---|---|---|
| System prompt | `agents.<name>.system`, `agents/<name>.md`; still passes when replaced | `docs/evidence/user-customization-round2-2026-11-13.json` |
| Tool list | Reduced from 12 to 4; still passes | same |
| Contents of `<env>` | Rewriting paths or flipping the git flag still passes | `docs/evidence/bun-env-strictness.json` |
| Code Mode catalogue | A catalogue synthesised from different tool names still passes | `docs/evidence/bun-synthetic-catalog.json` |
| `b3`, `traceparent` | Minted per request; no fixed value | — |
| `x-opencode-project` | Derived from the working directory | — |
| Runtime | Bun 1.4.4 with a zero-tool body is refused identically | `docs/evidence/bun-runtime-test.json` |

---

## Transport (TLS)

The official client's `ClientHello` cannot be expressed by Node's own TLS.
`src/bun-transport.ts` delegates the handshake to `wreq-js` (BoringSSL, the same library
the official client uses).

**Status: aligned byte for byte; necessity unproven.** It exists to cover
fingerprint checks that may appear later.

| Element | Value |
|---|---|
| Cipher suites | The captured 17, in order |
| `supported_groups` | `X25519MLKEM768`, `X25519`, `P-256`, `P-384` — the extra `MLKEM768` group the default profile offers must be removed |
| `signature_algorithms` | The captured 11, including **`0x0807` = ed25519** (not `rsa_pss_pss_sha256`, which is `0x0809`) and `0x0603` = ecdsa_secp521r1_sha512 |
| Extensions | The captured 12, in order, no GREASE/ECH/ALPS |
| ALPN | `http/1.1` only — the official client never offers `h2` |

The `ClientHello` is 1482 bytes and byte-identical to the capture once random fields are
normalised (`docs/evidence/clienthello-deep-2026-11-13.json`).

---

## Deliberately not done

- No rotating of IPs, sessions or identities to evade service limits.
- No executing tools inside another runtime: returned calls are dispatched by DSH.
- No extra imitation of user-configurable content, which carries no identity.

---

## Current state

| Requirement | How the bridge satisfies it |
|---|---|
| At least one declared tool | The caller's own tools suffice; a placeholder is added **only when the caller declares none**. Its description says not to call it, and a call that happens anyway is dropped (logged at `warn`) so the turn ends normally. |
| `<env>` block in the system prompt | The adapter appends `environmentBlock()` after the DSH prompt, generated from the real working directory. |
| `ClientHello` | Byte-identical to the capture, zero extension mismatches. |
| Headers | Byte-identical names, casing, order and values apart from `x-opencode-project`. |
| Connection | Pooled, `keep-alive`. |

The adapter's own code path returns 200 and answers repeatedly
(`docs/evidence/verify-env-fix.json`, `docs/evidence/repeat-1.json`,
`docs/evidence/placeholder-verify.json`).

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
