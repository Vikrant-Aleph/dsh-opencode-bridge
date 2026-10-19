# OpenCode Bridge

[中文](README.zh.md) | English

A plugin for using [OpenCode](https://opencode.ai) free models in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
No OpenCode account or API key is required by default.

## Features

- **Model integration**: automatically updates the free-model list and makes models available in DSH's model picker.
- **Streaming and tool calls**: adapts DSH's native tools and rejects unverified conversions rather than treating Bash commands as PowerShell.
- **Optional proxy failover**: configure multiple HTTP(S) or SOCKS proxies and try another egress when one is rate-limited or a connection fails.

## Install and get started

Install from npm into your DSH profile:

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.5.0
```

Replace `desktop` with the profile you use. If `dsh` is not available in your terminal, use:

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@0.5.0
```

Restart that DSH profile, then select a model under **OpenCode Bridge** in the model picker.
Normal use requires no API key or manual configuration-file edits. The model list follows upstream changes.

## Optional proxy setup

Without proxy configuration, the plugin uses a direct connection from your machine.

1. Open **Settings → OpenCode Bridge → Egress rotation (optional)**.
2. Add your existing proxy addresses one at a time, such as `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`. You can keep `direct` (this machine) as an egress.
3. Use **Test all** to check connectivity. Adding or removing an entry saves and applies the change automatically.

The plugin prefers available entries in list order. HTTP 429 or a connection failure temporarily cools that entry and triggers an attempt through the next one. A reply that has already started streaming is not replayed through another egress.

**HTTP(S), SOCKS4/4a and SOCKS5/5h** proxies are supported. Use only authorized proxies and respect upstream service limits.

## Important notes

- **Unofficial project**: not affiliated with OpenCode or DeepSeek. Upstream protocols, models and free quotas may change; continued availability is not guaranteed.
- **Third-party processing**: model requests are sent to OpenCode's service and, when configured, traverse your proxy. Do not send content you would not entrust to those third parties.
- **Input limitations**: this path primarily supports text and tool calls; images and attachment contents are not fully forwarded to the model.
- **Credentials and logs**: proxy passwords are stored in plaintext locally. SOCKS username/password authentication is not encrypted by SOCKS itself; use trusted proxies and networks. Do not publish the configuration file; inspect logs and screenshots for sensitive information before sharing.

## Troubleshooting

| Problem | What to try |
|---|---|
| No models after installation | Check the target profile, confirm the plugin is enabled, restart DSH and check network connectivity. |
| HTTP 429 | Retry later. If proxies are configured, inspect their status in Settings. |
| HTTP 403 or 503 | Check for plugin updates and upstream service issues, then retry later. These errors do not trigger proxy failover. Report persistent problems. |
| Tool calls fail | Check the **Diagnostic log** tab, or ask the agent to run `opencode_bridge_audit` for tool compatibility. |

For bugs or feature requests, [choose an Issue form](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/issues/new/choose) and fill in the requested versions, reproduction steps and expected/actual behavior. Redact logs first; do not include API keys, proxy passwords or private conversations.

## Development and technical documentation

<details>
<summary>Develop and install from source</summary>

Requires **Node.js ≥ 20.18.1** and pnpm. Node.js 22 or 24 LTS is recommended.

```sh
git clone https://github.com/Vikrant-Aleph/dsh-opencode-bridge.git
cd dsh-opencode-bridge
pnpm install
pnpm build
pnpm test
```

Build output is not committed to Git. To install a local build in DSH:

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.5.0.tgz
```

</details>

See the [technical documentation](TECHNICAL.md) ([中文](TECHNICAL.zh.md)) for implementation details, full configuration, testing and maintenance rules.

## Credits and license

Protocol research drew on the official OpenCode source and open-source projects including sub2api, 9router, hermes-oc-free-provider and cpa-plugin-opencodezen. Sources and comparison records are documented in the technical documentation.

Licensed under [MIT](LICENSE).
