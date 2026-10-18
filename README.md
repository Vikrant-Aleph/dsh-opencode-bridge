# dsh-opencode-bridge

[中文](README.zh.md) | English

Use the **free models of [OpenCode](https://opencode.ai)** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — no account, no API key.

The plugin is a DSH **LLM adapter** bundle that simulates the official OpenCode
client wire protocol, which the opencode.ai free tier ("Zen" relay) requires:
`big-pickle`, `mimo-v2.6-flash-free`, `glm-5.3-flash-free`,
`deepseek-v4.1-flash-free`, `nemotron-3.5-lightning-free`, `space-bunny-free`
and friends become selectable DSH models.

## How it works

The relay rejects non-OpenCode callers with `403 FreeTierError`. This plugin
reproduces the official client's request fingerprint (verified live, 2026-10):

| Layer | What the plugin sends |
|---|---|
| User-Agent | `opencode/<version> ai-sdk/provider-utils/... runtime/bun/...` plus DSH's attribution with its `/<version>` stripped (a versioned foreign product token is rejected) |
| Session identity | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` = one stable `ses_` id per conversation, and `x-opencode-request` = `msg_` id per call, both minted with the CLI's descending/ascending `~(ms*0x1000+counter)` 48-bit encoding + 14 base62 chars. The upstream decodes the time field and rejects fake counters. |
| Client headers | `x-opencode-client: cli`, `x-opencode-project: global` |
| Tool fingerprint | The request body declares OpenCode's built-in `read`/`shell` tools with their **verbatim** schemas plus `bash`/`glob`/`grep` stubs; conflicting DSH tools travel under `*_client` aliases and calls to the added tools are translated onto DSH's `pwsh`/`read`/`glob`/`grep`, so they remain functional |
| Streaming | `stream: true`, `tool_choice: "auto"` |

Models and their limits/reasoning levels are discovered from the public
[models.dev](https://models.dev) registry (zero-cost entries) intersected with
the relay's live `GET /models` listing.

## Install

**From npm** (after publishing):

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge
```

**From source** (this directory):

```sh
pnpm install && pnpm build && pnpm pack

# install the tarball into your profile (example: "desktop")
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-opencode-bridge-0.2.1.tgz
```

Restart the profile, then pick any `opencode-free/*` model in the model
selector. No configuration is required — the plugin is keyless.

## Configuration (optional)

All settings have working defaults; change them in `cordis.patch.yml`:

```yaml
- id: dsh-opencode-free
  config:
    baseUrl: https://opencode.ai/inference/v1   # relay base
    apiKey: public                              # signed-out sentinel
    userAgent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
    client: cli                                 # x-opencode-client
    project: global                             # x-opencode-project
    providers: [opencode-free]                  # provider route(s)
    includeDeprecated: false                    # also offer deprecated models still listed live
    extraModels: []                             # force-add model ids
    requestTimeoutMs: 600000
    toolFingerprint: true                       # send the tool fingerprint
    toolTranslation: true                       # map fingerprint tools onto DSH tools
    logLevel: info                              # debug|info|warn|error|off
    logDir: ''                                  # empty = ~/.dsh/logs/dsh-opencode-free
    logMaxBytes: 524288                         # per-file size cap before rotation
    logMaxFiles: 5                              # total files kept; oldest deleted first
```

## Logging & diagnostics

A leveled diagnostic log (`debug`/`info`/`warn`/`error`) records adapter
activity — metadata only, never prompt content or credentials. Lines are
scrubbed of secrets before writing, and disk usage is bounded: when the log
grows past `logMaxBytes × logMaxFiles`, the **oldest files are deleted first**.

- **Agent tool** `opencode_free_log`: `action: read|stat|clear|level` for
  self-service debugging.

## Notes & limits

- **Rate limits**: the free tier throttles per IP (`429 FreeUsageLimitError`).
  Heavy use can exhaust a quota for a while; the plugin surfaces the upstream
  message verbatim.
- **Text + tools first**: images/files in prompts are sent as placeholders on
  this path; most free models are text-in anyway. Reasoning deltas from models
  that emit `reasoning_content` are surfaced as thinking blocks.
- **Live with the relay**: the upstream gate evolves (it gained the session
  counter and tool checks within days in 2026-10). If `403 FreeTierError`
  returns, update `userAgent`/fingerprint in `src/opencode-protocol.ts`.
- Only zero-cost models are offered. Paid OpenCode models require an OpenCode
  Console account and are out of scope here.

## Development

```sh
pnpm build       # tsc -> lib/
pnpm test        # node --test tests/*.test.mjs
node tests/smoke.mjs [model-id]   # live end-to-end probe
```

`tests/smoke.mjs` validates the id encoding, tool planning, live catalog and a
real streaming completion against the relay.

For the protocol internals — the three-layer gate, the identifier bit layout,
tool cloaking/translation, and the update playbook for when the upstream
changes — see [TECHNICAL.md](TECHNICAL.md) ([中文](TECHNICAL.zh.md)).

## Credits

Protocol details were reconstructed from the official client source
(`sst/opencode`), and cross-checked against community reports (sub2api,
9router, hermes-oc-free-provider, cpa-plugin-opencodezen). This project is not
affiliated with OpenCode or DeepSeek.

## License

MIT
