# OpenCode Bridge

[![npm 最新版本](https://img.shields.io/npm/v/dsh-opencode-bridge?logo=npm)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![npm 累计下载量](https://img.shields.io/npm/dt/dsh-opencode-bridge?logo=npm&label=Downloads)](https://www.npmjs.com/package/dsh-opencode-bridge)
[![许可证](https://img.shields.io/github/license/Vikrant-Aleph/dsh-opencode-bridge)](LICENSE)
[![GitHub 最新 Release](https://img.shields.io/github/v/release/Vikrant-Aleph/dsh-opencode-bridge)](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/releases/latest)
[![Node.js 版本要求](https://img.shields.io/node/v/dsh-opencode-bridge?logo=node.js)](https://www.npmjs.com/package/dsh-opencode-bridge)

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中使用
[OpenCode](https://opencode.ai) 免费模型的插件，默认无需 OpenCode 账号或 API Key。

## 主要功能

- **模型列表自动刷新**：启动时获取免费模型列表，默认每 10 分钟重新获取一次，跟随上游增删模型；刷新失败时保留上次成功的列表。
- **流式对话与工具调用**：保留多步工具调用中的思考历史，适配 DSH 原生工具，拒绝无法验证的工具转换，避免将 Bash 命令直接当作 PowerShell 执行。
- **可选代理轮换**：配置多个 HTTP(S) 或 SOCKS 代理，在明确的出口配额限制或连接失败时尝试其他可用出口，并遵守服务端等待提示。

## 安装与开始使用

### DSH Desktop 界面安装

1. 打开左侧 **插件** 页面，点击右上角 **添加插件**。
2. 在输入框中填写：

   ```text
   dsh-opencode-bridge@0.5.3
   ```

3. **安装源**建议选择 npm 官方源；如果使用镜像源，新版本可能需要等待同步。
4. 点击 **安装**，等待安装完成。

### 命令行安装

从 npm 安装到你的 DSH profile：

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.5.3
```

`desktop` 是示例 profile 名称，请按实际使用的名称替换。如果终端找不到 `dsh`，可使用：

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@0.5.3
```

安装完成后，在模型选择器中选择 **OpenCode Bridge** 下的模型即可开始对话；如果未显示，请重启对应的 DSH profile。
日常使用无需手动填写 API Key 或修改配置文件；列表变化会通知 DSH 模型选择器重新读取，无需重启插件。刷新间隔的高级配置见[配置参考](TECHNICAL.zh.md#8-配置参考)。

## 可选代理配置

不配置代理时，插件默认使用本机直连。

1. 打开 **设置 → OpenCode Bridge → 出口代理轮换（可选）**。
2. 逐个添加已有的代理地址，例如 `http://127.0.0.1:7890` 或 `socks5h://127.0.0.1:1080`。可保留 `direct`（本机直连）作为一个出口。
3. 点击 **测试全部** 检查连通性；冷却中的出口会跳过，避免提前发出请求。新增、删除操作会自动保存并应用。

插件按列表顺序优先使用可用出口。明确的出口配额错误或连接失败会使该出口暂时冷却；有服务端等待提示时不立即切换出口，全部出口冷却时也不会提前请求。模型后端暂不可用或原因不明的 429，不直接当作代理额度耗尽。

自动重试由 DSH 统一执行，最多重试两次；过长的等待会交还错误，供你稍后重试。已经开始输出的回复不会自动重放。

支持 **HTTP(S)、SOCKS4/4a 和 SOCKS5/5h** 代理。请仅使用获授权的代理并遵守上游服务限制。

## 注意事项

- **非官方项目**：与 OpenCode、DeepSeek 无隶属关系。上游协议、模型和免费额度可能变化，不保证服务持续可用。
- **第三方数据处理**：模型请求会发送给 OpenCode 服务；使用代理时，请求还会经过所配置的代理。不要发送不愿交给第三方处理的内容。
- **输入限制**：当前以文本对话和工具调用为主，图片与附件内容不会完整发送给模型。
- **凭据与日志**：代理密码在本地配置文件中以明文保存；SOCKS 用户名/密码认证本身不加密，请使用可信代理与网络。不要公开配置文件，分享日志或截图前请检查并移除敏感信息。

## 常见问题

| 问题 | 建议 |
|---|---|
| 安装后没有看到模型 | 确认安装到了正在使用的 profile，插件已启用，然后重启 DSH 并检查网络连接。 |
| 思考模式在工具返回后报 reasoning_content 缺失 | 更新插件；0.5.3修复了assistant历史回传，空思考也会带上必要字段。 |
| 出现 HTTP 429 | 稍后重试；如已配置代理，可在设置中查看出口状态。 |
| 出现 HTTP 403 或 503 | 检查插件更新与上游服务状态，稍后重试；这类错误不会触发代理轮换。仍有问题时请反馈。 |
| 工具调用失败 | 在“诊断日志”标签查看错误，也可让 Agent 调用 `opencode_bridge_audit` 检查工具兼容性。 |

问题反馈或功能建议请[选择 Issue 表单](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/issues/new/choose)，按表单填写版本、复现步骤及预期/实际行为；日志请先脱敏，勿提交 API Key、代理密码或私人聊天内容。

## 开发与技术文档

<details>
<summary>从源码开发与安装</summary>

需要 **Node.js ≥ 20.18.1** 和 pnpm，建议使用 Node.js 22 或 24 LTS。

```sh
git clone https://github.com/Vikrant-Aleph/dsh-opencode-bridge.git
cd dsh-opencode-bridge
pnpm install
pnpm build
pnpm test
```

构建产物不会提交到 Git。要在 DSH 中安装本地构建：

```sh
pnpm pack
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.5.3.tgz
```

</details>

实现原理、完整配置、测试方法与维护规约见[技术文档](TECHNICAL.zh.md)（[English](TECHNICAL.md)）。

## 致谢与许可

协议研究参考 OpenCode 官方源码，以及 sub2api、9router、hermes-oc-free-provider、cpa-plugin-opencodezen 等开源项目；来源与对照记录见技术文档。

本项目采用 [MIT 许可证](LICENSE)。
