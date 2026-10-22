# OpenCode Bridge

[![npm version](https://img.shields.io/npm/v/dsh-opencode-bridge?logo=npm)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![Total npm downloads](https://img.shields.io/npm/dt/dsh-opencode-bridge?logo=npm&label=Downloads)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![License](https://img.shields.io/github/license/Vikrant-Aleph/dsh-opencode-bridge)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Vikrant-Aleph/dsh-opencode-bridge)](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/latest)
[![Node.js requirement](https://img.shields.io/node/v/dsh-opencode-bridge?logo=node.js)](https://www.npmjs.com/package/dsh-opencode-bridge)

[中文](README.zh.md) | English

A plugin for using [OpenCode](https://opencode.ai) free models in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
No OpenCode account or API key is required by default.

## Features

- **Automatic model refresh**: fetches the free-model list at startup and every 10 minutes by default, adds/removes models as the upstream catalog changes, and retains the last successful list if a refresh fails.
- **Declared image input**: models that advertise image support receive uploaded/pasted images through DSH's official attachment interface. Tool-output images are forwarded with their result association; text-only models keep a clear fallback.
- **Streaming and tool calls**: preserves reasoning history across multi-step tool calls, adapts DSH's native tools, and rejects unverified conversions rather than treating Bash commands as PowerShell.
- **Optional proxy failover**: configure multiple HTTP(S) or SOCKS proxies, try another ready egress for explicit egress-quota errors or connection failures, and respect server-requested waits.

## Install and get started

Image input requires DSH's attachment request-version API; this version is built and verified against DSH SDK 0.2.1-rc.2.

### Install in DSH Desktop

1. Open **Plugins** in the sidebar, then click **Add plugin** in the top-right corner.
2. Enter:

   ```text
   dsh-opencode-bridge@0.5.4
   ```

3. Prefer the official npm registry under **Installation source**. Mirrors may take time to sync new versions.
4. Click **Install** and wait for completion.

### Install from the command line

Install from npm into your DSH profile:

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.5.4
```

Replace `desktop` with the profile you use. If `dsh` is not available in your terminal, use:

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@0.5.4
```

After installation, select a model under **OpenCode Bridge** in the model picker. If it does not appear, restart the corresponding DSH profile.
Normal use requires no API key or manual configuration-file edits. List changes are announced to DSH's model picker without restarting the plugin. Advanced refresh-interval configuration is documented in the [configuration reference](TECHNICAL.md#8-configuration-reference).

## Optional proxy setup

Without proxy configuration, the plugin uses a direct connection from your machine.

1. Open **Settings → OpenCode Bridge → Egress rotation (optional)**.
2. Add your existing proxy addresses one at a time, such as `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`. You can keep `direct` (this machine) as an egress.
3. Use **Test all** to check connectivity. Cooling entries are skipped to avoid early requests. Adding or removing an entry saves and applies the change automatically.

The plugin prefers ready entries in list order. Explicit egress-quota errors or connection failures temporarily cool an entry. A server-requested wait prevents immediate failover, and a fully cooling pool sends no early requests. Model-backend unavailability and unexplained 429s are not automatically treated as exhausted proxy quota.

DSH centrally performs at most two automatic retries; excessive waits return an error for you to retry later. Replies that have started streaming are not automatically replayed.

**HTTP(S), SOCKS4/4a and SOCKS5/5h** proxies are supported. Use only authorized proxies and respect upstream service limits.

## Important notes

- **Unofficial project**: not affiliated with OpenCode or DeepSeek. Upstream protocols, models and free quotas may change; continued availability is not guaranteed.
- **Third-party processing**: model requests are sent to OpenCode's service and, when configured, traverse your proxy. Do not send content you would not entrust to those third parties.
- **Attachments**: image input follows each model's declared capability. DSH prepares request versions and applies image budgets/offload decisions; ordinary files remain text handles rather than native file inputs. Image bytes and data URLs are not written to diagnostic logs.
- **Credentials and logs**: proxy passwords are stored in plaintext locally. SOCKS username/password authentication is not encrypted by SOCKS itself; use trusted proxies and networks. Do not publish the configuration file; inspect logs and screenshots for sensitive information before sharing.

## Troubleshooting

| Problem | What to try |
|---|---|
| No models after installation | Check the target profile, confirm the plugin is enabled, restart DSH and check network connectivity. |
| Thinking mode fails after a tool result with missing reasoning_content | Update the plugin; 0.5.3 restores the required assistant-history field, including empty reasoning. |
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
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.5.4.tgz
```

</details>

See the [technical documentation](TECHNICAL.md) ([中文](TECHNICAL.zh.md)) for implementation details, full configuration, testing and maintenance rules.

## Credits and license

Protocol research drew on the official OpenCode source and open-source projects including sub2api, 9router, hermes-oc-free-provider and cpa-plugin-opencodezen. Sources and comparison records are documented in the technical documentation.

Licensed under [MIT](LICENSE).
