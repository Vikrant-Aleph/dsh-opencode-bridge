# OpenCode Bridge

[![npm version](https://img.shields.io/npm/v/dsh-opencode-bridge?logo=npm)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![Total npm downloads](https://img.shields.io/npm/dt/dsh-opencode-bridge?logo=npm&label=Downloads)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![License](https://img.shields.io/github/license/Vikrant-Aleph/dsh-opencode-bridge)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Vikrant-Aleph/dsh-opencode-bridge)](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/latest)
[![Node.js requirement](https://img.shields.io/node/v/dsh-opencode-bridge?logo=node.js)](https://www.npmjs.com/package/dsh-opencode-bridge)

中文 | [English](README.us.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里使用
[OpenCode](https://opencode.ai) 的免费模型——无需 OpenCode 账号或 API Key。
另含可选的上下文精简与出口轮换。

## 主要功能

**伪装成官方 OpenCode 客户端，让 DSH 能使用 OpenCode 的免费模型。** 

具体来说，它复刻了官方 OpenCode 客户端的请求头、网关要求的请求形态，以及 TLS 与 HTTP 指纹。它是一个 `LlmAdapter`，接入 DSH 既有循环：agent loop、权限与工具执行仍由 DSH 负责，每次工具调用也由 DSH 自行解析。网关究竟检查什么、不检查什么，见[下文](#免费档如何判定客户端)。

同时还支持：

- **模型自动刷新** —— 启动时读取免费模型列表，默认每 10 分钟刷新；上游目录变化时自动增删模型，刷新失败则保留上一份可用列表。
- **流式输出与思考连续性** —— 流式返回响应，并在多步工具调用间保留思考，包括部分模型回放时要求的 `reasoning_content` 字段。
- **可选上下文精简** —— 只清除已确认成功完成轮次中的思考，默认关闭。
- **可选出口轮换** —— 按顺序配置多个 HTTP(S) 或 SOCKS 代理，遇到明确的出口配额错误或连接失败时切换，并始终遵守服务端要求的等待。

## OpenCode 如何判定客户端

以下结论全部来自实测——单变量、同一运行时、对真实网关验证。

### 会检查的部分

| 要求 | 实测结果 |
|---|---|
| `User-Agent` | 必须是官方标识 `opencode/latest/2.2.0/cli`。换成其它标识，即使其余全部一致也会被拒。 |
| **至少声明一个工具** | 名字无所谓：单独一个任意名字的工具即可通过。`tools` 为空数组会被拒。 |
| **系统提示含 `<env>` 块** | 仅含该块的 177 字节提示即可通过；同样的提示去掉该块就会被拒。 |

后两条才是关键。它们都是官方客户端中无论如何用户配置都会有的特征，所以能充当客户端检查：用户可以
改写系统提示、裁剪工具清单，但客户端仍会追加 `<env>` 块、仍会声明至少一个工具。

### 不检查的部分

下面每一条都曾被当作必需，随后被实验否定：

- **官方工具清单。** 只带一个工具的自定义 agent 可以通过。
- **官方系统提示。** 用户自己的提示可以通过。
- **`<env>` 里的值。** 无论写什么可以。
- **Code Mode 目录。** 用不同工具名合成的目录同样通过。
- **运行时。** Bun 1.4.4 发送零工具请求体时，被拒的方式与 Node 完全相同，所以这不是 Bun 和 Node.js 的问题。
- **单独的 TLS 指纹。** 逐字节对齐（加密套件、曲线、扩展顺序、签名算法）**并没有**解决拒绝——因为真正的原因是 `<env>` 块。

### 注意事项

以上均为 2026-11-13 的观测，不是规范。
完整证据链与被排除的假设见[伪装原则](CAMOUFLAGE.md)。

## TLS 与 HTTP 指纹伪装

**状态：已对齐，但未被证明是必需的。**

目前只是用来应对将来可能加入的指纹检查，让这些流量在对应层面**无法区分**于官方客户端。

### TLS 指纹伪装

Node 无法表达官方握手：OpenSSL 自行排列扩展顺序，也不提供后量子 key share，产生的 hello 与官方客户端不同（约 270 字节，而官方是 1482）。因此插件把握手交给[`wreq-js`](https://github.com/sqdshguy/wreq-js)——基于 BoringSSL 的 Rust 引擎，与官方客户端使用同一套底层 TLS 库。

| 元素 | 值 |
|---|---|
| 加密套件 | 抓包中的 17 个，顺序一致，以 `TLS_AES_128_GCM_SHA256`、`TLS_AES_256_GCM_SHA384`、`TLS_CHACHA20_POLY1305_SHA256` 开头 |
| 支持的曲线组 | `X25519MLKEM768`、`X25519`、`P-256`、`P-384`——默认配置还会额外提供一个 `MLKEM768` 组；官方客户端没有这个组，因此要去掉 |
| 签名算法 | 抓包中的 11 个，顺序一致。其中两个容易搞错：`0x0807` 是 **ed25519**，不是 `rsa_pss_pss_sha256`（后者是 `0x0809`）；`0x0603` 是 `ecdsa_secp521r1_sha512`，BoringSSL 中写作 `ECDSA+SHA512` |
| 扩展 | 抓包中的 12 个，顺序一致，并关闭 GREASE、ECH 与 ALPS |
| ALPN | 仅 `http/1.1`——官方客户端从不提供 `h2`，所以 HTTP/2 设置不属于它的指纹 |
| 结果 | `ClientHello` 为 1482 字节；归一化随机数、会话 ID 与 key_share 载荷后，与抓包逐字节相同 |

### HTTP 指纹伪装

| 元素 | 细节 |
|---|---|
| 头名称与大小写 | `Authorization`、`Content-Type`、`User-Agent`、`Connection`、`Accept`、`Host`、`Accept-Encoding`、`Content-Length` 按抓包大写；自定义的 `b3`、`traceparent`、`x-opencode-*` 保持小写 |
| 头顺序 | 按抓包顺序，包括把 `Host`、`Accept-Encoding`、`Content-Length` 放在第 14–16 位——它们被显式提供，否则传输层会把它们追加到末尾 |
| `Accept-Encoding` | `gzip, deflate, br, zstd`，即 Bun 的默认值；Node 的默认值缺少 `br` 与 `zstd` |
| `Connection` | `keep-alive`，并使用跨轮次复用的持久连接池 |
| 刻意不发送 | 不发送 `sec-ch-ua*`、`sec-fetch-*`、`priority`、`accept-language`——浏览器模拟会默认加上这些，而官方客户端从不发送，因此显式抑制 |

最终伪装结果与官方客户端抓包请求逐字节一致，唯一例外是 `x-opencode-project`——它由工作目录推导。

`wreq-js` 目前是**可选**依赖。缺少其原生绑定时，插件回退到普通 `fetch`，失去 TLS 对齐但仍能工作；
而在某些代理环境下普通 `fetch` 根本连不上，所以该传输层的价值不止于指纹。

## 安装

### 在 DSH 桌面端安装

1. 侧边栏打开 **插件**，点右上角 **添加插件**。
2. 输入：

   ```text
   dsh-opencode-bridge@1.0.1
   ```

3. **安装源**优先选官方 npm registry；镜像可能滞后。
4. 点 **安装** 并等待完成。

### 命令行安装

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@1.0.1
```

把 `desktop` 换成你的 profile。若终端里没有 `dsh`：

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@1.0.1
```

然后在模型选择器里选 **OpenCode Bridge** 下的模型。若没有出现，重启该 DSH profile。

日常使用无需 API Key，也无需手改配置文件。模型列表变化会通知选择器重新读取，无需重启插件。
刷新间隔等完整配置见[配置参考](TECHNICAL.md#7-配置)。

## 可选上下文精简

打开 **设置 → OpenCode Bridge → 上下文精简**，启用 **精简已完成轮次的思考**。默认关闭（完整回放）。

只清除已确认成功完成轮次的思考；当前工具链与不确定、被中断的历史保持不变，必需的
`reasoning_content` 字段仍会发送。该设置只影响新请求，不删除本地历史，也不打断进行中的请求。
节省幅度取决于上游，DSH 的本地估算可能仍按完整历史计算——若影响连续性请关闭。

## 可选出口轮换

不做配置时，插件直接连接。

1. 打开 **设置 → OpenCode Bridge → 出口轮换（可选）**。
2. 逐个添加代理，例如 `http://127.0.0.1:7890` 或 `socks5h://127.0.0.1:1080`。`direct`（本机）可以保留在列表里。
3. 用 **全部测试** 检查连通性。冷却中的条目会被跳过，避免提前发请求。增删条目会立即保存并生效。

条目按列表顺序尝试。明确的出口配额错误与连接失败会让该条目短暂冷却；服务端要求的等待会阻止
立即切换；整个池都在冷却时不会提前发送任何请求。模型后端故障与无法解释的 429 **不**会被当作
代理配额耗尽。

DSH 统一最多自动重试两次；等待过久会返回错误，稍后重试。已经开始流式输出的回复不会自动重放。

支持 **HTTP(S)、SOCKS4/4a、SOCKS5/5h**。

## 重要说明

- **非官方项目。** 与 OpenCode、DeepSeek 均无隶属关系。上游协议、模型与免费额度都可能变化，不保证持续可用。
- **第三方处理。** 模型请求会发送到 OpenCode 的服务；配置代理后会经过你的代理。请勿发送你不愿交给这些第三方的内容。
- **附件。** 图片输入取决于每个模型声明支持的能力。DSH 负责准备请求版本并执行图片预算与卸载决策；普通文件以文本句柄表示。图片字节与 data URL 不会写入诊断日志。
- **凭据与日志。** 代理密码以明文保存在本地。SOCKS 自身不加密用户名/密码认证——请使用可信代理与网络，不要公开配置文件，分享日志与截图前先检查敏感信息。

## 排查

| 现象 | 处理 |
|---|---|
| 安装后没有模型 | 确认目标 profile、确认插件已启用、重启 DSH、检查网络。 |
| HTTP 429 | 稍后重试。已配置代理时在设置里查看状态。出口配额耗尽也会返回 429，这种情况任何请求形态都无法改变。 |
| HTTP 403 或 503 | 检查插件更新与上游状态后重试；这类错误不会触发代理轮换。持续出现请反馈。 |
| 工具调用失败 | 查看 **诊断日志** 标签；DSH 从未声明的调用无法被派发。 |

发现 bug 或想提需求，请[选择 Issue 表单](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/issues/new/choose)，
并附上版本、复现步骤与预期/实际行为。提交前请先脱敏——不要包含 API Key、代理密码或私人对话。

## 开发与文档

<details>
<summary>从源码构建并安装</summary>

需要 **Node.js ≥ 20.18.1** 与 pnpm；建议 Node.js 22 或 24 LTS。

```sh
git clone https://github.com/Vikrant-Aleph/dsh-opencode-bridge.git
cd dsh-opencode-bridge
pnpm install
pnpm build
pnpm test
```

构建产物不提交到 Git。安装本地构建：

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-opencode-bridge-1.0.1.tgz
```

</details>

[技术文档](TECHNICAL.md)（[English](TECHNICAL.us.md)）涵盖线上协议、模块结构、完整配置、
测试与维护规则。

## 致谢与许可

协议研究参考了 OpenCode 官方客户端、其公开源码，以及记录同一限制的社区项目。抓包与据此得出的
原则汇总在[伪装原则](CAMOUFLAGE.md)。

基于 [MIT](LICENSE) 许可。
