# OpenCode Bridge

[![npm version](https://img.shields.io/npm/v/dsh-opencode-bridge?logo=npm)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![Total npm downloads](https://img.shields.io/npm/dt/dsh-opencode-bridge?logo=npm&label=Downloads)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![License](https://img.shields.io/github/license/Vikrant-Aleph/dsh-opencode-bridge)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Vikrant-Aleph/dsh-opencode-bridge)](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/latest)
[![Node.js requirement](https://img.shields.io/node/v/dsh-opencode-bridge?logo=node.js)](https://www.npmjs.com/package/dsh-opencode-bridge)

[中文](README.md) | English

Use [OpenCode](https://opencode.ai)'s free models in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — no
OpenCode account or API key needed. Optional context trimming and egress rotation are
included.

## Features

**Impersonates the official OpenCode client so DSH can use OpenCode's free models.**

Concretely, it reproduces the official client's request headers, the request shape the
gateway requires, and the TLS and HTTP fingerprints. It is an `LlmAdapter`, so it plugs
into DSH's existing loop: the agent loop, permissions and tool
execution stay with DSH, and DSH resolves every tool call itself. What the gateway does
and does not check is described [below](#how-opencode-identifies-a-client).

Also included:

- **Automatic model refresh** — reads the free-model list at startup and every 10 minutes, adding and removing models as the upstream catalog changes and keeping the last good list when a refresh fails.
- **Streaming with reasoning continuity** — streams responses and preserves reasoning across multi-step tool calls, including the `reasoning_content` field some models require on replay.
- **Optional context trimming** — clears reasoning only from confirmed completed turns, off by default.
- **Optional egress rotation** — several HTTP(S) or SOCKS proxies in order, failing over on explicit egress-quota errors or connection failures and always honouring server-requested waits.

## How OpenCode identifies a client

Everything below was measured — one variable at a time, from a single runtime, against
the real gateway.

### What is checked

| Requirement | What we measured |
|---|---|
| `User-Agent` | Must be the official token, `opencode/latest/2.2.0/cli`. A different token is refused even when everything else matches. |
| **At least one declared tool** | The name does not matter: a lone tool called anything passes. An empty `tools` array is refused. |
| **An `<env>` block in the system prompt** | A 177-byte prompt containing nothing but that block passes. The same prompt without it is refused. |

The last two are the interesting ones. Both are present in the official client no
matter how a user configures it, which is why they work as a client check: a user can
rewrite the system prompt and prune the tool list, but the client still appends an
`<env>` block and still declares at least one tool.

### What is not checked

Each of these was assumed necessary at some point, then disproved:

- **The official tool manifest.** A custom agent with a single tool passes.
- **The official system prompt.** A user's own prompt passes.
- **The values inside `<env>`.** Anything works.
- **The Code Mode catalogue.** A catalogue synthesised from different tool names passes.
- **The runtime.** Bun 1.4.4 sending a zero-tool body is refused exactly like Node, so this is not a Bun versus Node.js issue.
- **The TLS fingerprint alone.** Aligning it byte for byte (cipher suites, curves, extension order, signature algorithms) did **not** fix the refusal — the real cause was the `<env>` block.

### Caveats

All of the above are dated observations from 2026-11-13. The full
evidence trail and the hypotheses that were ruled out are in the
[camouflage policy](CAMOUFLAGE.us.md).

## TLS and HTTP fingerprint camouflage

**Status: aligned; necessity unproven.**

It exists to cover fingerprint checks that may be added later, and to make this traffic
indistinguishable from the official client at those layers.

### TLS fingerprint

Node cannot express the official handshake: OpenSSL orders extensions itself and offers
no post-quantum key share, producing a different hello (roughly 270 bytes against 1482).
The plugin therefore delegates the handshake to
[`wreq-js`](https://github.com/sqdshguy/wreq-js), a Rust engine on BoringSSL — the same
underlying TLS library the official client uses.

| Element | Value |
|---|---|
| Cipher suites | The captured 17, in capture order, starting `TLS_AES_128_GCM_SHA256`, `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256` |
| Supported groups | `X25519MLKEM768`, `X25519`, `P-256`, `P-384` — the default profile also offers a bare `MLKEM768` group; the official client does not have it, so it is removed |
| Signature algorithms | The captured 11, in order. Two are easy to get wrong: `0x0807` is **ed25519**, not `rsa_pss_pss_sha256` (that is `0x0809`), and `0x0603` is `ecdsa_secp521r1_sha512`, written `ECDSA+SHA512` by BoringSSL |
| Extensions | The captured 12, in capture order, with GREASE, ECH and ALPS disabled |
| ALPN | `http/1.1` only — the official client never offers `h2`, so HTTP/2 settings are not part of its fingerprint |
| Result | A 1482-byte `ClientHello`; byte-identical to the capture once random fields, session id and key-share payloads are normalised |

### HTTP fingerprint

| Element | Detail |
|---|---|
| Header names and casing | `Authorization`, `Content-Type`, `User-Agent`, `Connection`, `Accept`, `Host`, `Accept-Encoding`, `Content-Length` are capitalised as captured; the custom `b3`, `traceparent` and `x-opencode-*` headers stay lowercase |
| Header order | The captured order, including `Host`, `Accept-Encoding` and `Content-Length` in positions 14–16 — supplied explicitly, because the transport would otherwise append them at the end |
| `Accept-Encoding` | `gzip, deflate, br, zstd`, Bun's default; Node's default omits `br` and `zstd` |
| `Connection` | `keep-alive`, over a persistent pooled connection reused across turns |
| Deliberately absent | No `sec-ch-ua*`, `sec-fetch-*`, `priority` or `accept-language` — browser emulation adds these by default and the official client never sends them, so they are explicitly suppressed |

The result is byte-identical to the captured request apart from `x-opencode-project`,
which is derived from the working directory.

`wreq-js` is an **optional** dependency. Without its native binding the plugin falls back
to plain `fetch`, losing the TLS alignment but still working — and in some proxy setups
plain `fetch` cannot connect at all, so the transport has value beyond fingerprinting.

## Install

### In DSH Desktop

1. Open **Plugins** in the sidebar, then click **Add plugin** in the top-right corner.
2. Enter:

   ```text
   dsh-opencode-bridge@1.0.1
   ```

3. Prefer the official npm registry under **Installation source**; mirrors may lag.
4. Click **Install** and wait for completion.

### From the command line

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@1.0.1
```

Replace `desktop` with your profile. If `dsh` is not on your `PATH`:

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@1.0.1
```

Then pick a model under **OpenCode Bridge** in the model picker. If none appears,
restart that DSH profile.

No API key or hand-edited configuration is needed. Model-list changes reach the picker
without restarting the plugin. Refresh intervals and the rest of the configuration are
in the [configuration reference](TECHNICAL.us.md#7-configuration).

## Optional context trimming

Open **Settings → OpenCode Bridge → Context trimming** and enable **Trim reasoning from
completed turns**. Off by default (full replay).

Only reasoning from confirmed successful turns is cleared; the current tool chain and
uncertain or interrupted history stay intact, and required `reasoning_content` fields
are still sent. The setting affects new requests only, leaves local history untouched, and
does not interrupt a running request. Savings depend on the upstream, and DSH's local
estimate may still count the full history — turn it off if continuity suffers.

## Optional egress rotation

Without configuration the plugin connects directly.

1. Open **Settings → OpenCode Bridge → Egress rotation (optional)**.
2. Add proxies one at a time, such as `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`. `direct` (this machine) can stay in the list.
3. Use **Test all** to check connectivity. Cooling entries are skipped so no early request is made. Adding or removing an entry saves and applies immediately.

Entries are tried in list order. Explicit egress-quota errors and connection failures
cool an entry temporarily; a server-requested wait prevents immediate failover, and a
fully cooling pool sends nothing early. Model-backend trouble and unexplained 429s are
*not* treated as exhausted proxy quota.

DSH performs at most two automatic retries; long waits return an error for you to retry
later. Replies that have already started streaming are never replayed.

**HTTP(S), SOCKS4/4a and SOCKS5/5h** are supported.

## Important notes

- **Unofficial project.** Not affiliated with OpenCode or DeepSeek. Upstream protocols, models and free quotas can change; continued availability is not guaranteed.
- **Third-party processing.** Model requests go to OpenCode's service and, if configured, through your proxy. Do not send content you would not entrust to those parties.
- **Attachments.** Image input follows each model's declared capability. DSH prepares request versions and applies the image budgets and offload decisions; ordinary files travel as text handles. Image bytes and data URLs never reach the diagnostic logs.
- **Credentials and logs.** Proxy passwords are stored in plaintext locally. SOCKS authentication is not encrypted by SOCKS itself — use proxies and networks you trust, do not publish the configuration file, and check logs and screenshots before sharing them.

## Troubleshooting

| Problem | What to try |
|---|---|
| No models after installation | Check the target profile, confirm the plugin is enabled, restart DSH, verify network access. |
| HTTP 429 | Retry later. With proxies configured, check their status in Settings. A 429 also appears when the egress quota is spent, which no request shape can change. |
| HTTP 403 or 503 | Check for plugin updates and upstream status, then retry. These do not trigger proxy failover. Report persistent cases. |
| Tool calls fail | Check the **Diagnostic log** tab; a call DSH never declared cannot be dispatched. |

For bugs or feature requests, [choose an Issue form](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/issues/new/choose)
and include versions, reproduction steps and expected versus actual behaviour. Redact
logs first — never include API keys, proxy passwords or private conversations.

## Development and documentation

<details>
<summary>Build and install from source</summary>

Requires **Node.js ≥ 20.18.1** and pnpm; Node.js 22 or 24 LTS is recommended.

```sh
git clone https://github.com/Vikrant-Aleph/dsh-opencode-bridge.git
cd dsh-opencode-bridge
pnpm install
pnpm build
pnpm test
```

Build output is not committed. To install a local build:

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-opencode-bridge-1.0.1.tgz
```

</details>

[Technical documentation](TECHNICAL.us.md) ([中文](TECHNICAL.md)) covers the wire
protocol, module layout, full configuration, testing and maintenance rules.

## Credits and license

Protocol research drew on the official OpenCode client, its public source, and
community projects that documented the same restriction. The captures and the policies
derived from them are summarised in the [camouflage policy](CAMOUFLAGE.us.md).

Licensed under [MIT](LICENSE).
