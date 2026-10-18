# OpenCode Bridge

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中使用
[OpenCode](https://opencode.ai) 免费模型的插件，默认无需 OpenCode 账号或 API Key。

## 主要功能

- **模型接入**：自动更新免费模型列表，在 DSH 模型选择器中直接使用。
- **流式对话与工具调用**：适配 DSH 原生工具，拒绝无法验证的工具转换，避免将 Bash 命令直接当作 PowerShell 执行。
- **可选代理轮换**：配置多个 HTTP(S) 代理，在出口被限流或连接失败时尝试下一个。

## 安装与开始使用

从 npm 安装到你的 DSH profile：

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.4.1
```

`desktop` 是示例 profile 名称，请按实际使用的名称替换。如果终端找不到 `dsh`，可使用：

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge@0.4.1
```

安装后重启对应的 DSH profile，在模型选择器中选择 **OpenCode Bridge** 下的模型即可开始对话。
日常使用无需手动填写 API Key 或修改配置文件；模型列表会随上游调整。

## 可选代理配置

不配置代理时，插件默认使用本机直连。

1. 打开 **设置 → OpenCode Bridge → 出口代理轮换（可选）**。
2. 逐个添加已有的代理地址，例如 `http://127.0.0.1:7890`。可保留 `direct`（本机直连）作为一个出口。
3. 点击 **测试全部** 检查连通性；新增、删除操作会自动保存并应用。

插件按列表顺序优先使用可用出口。遇到 HTTP 429 限流或连接失败时，会暂时冷却该出口并尝试下一个；已经开始输出的回复不会因切换出口而重新发送。

目前仅支持 **HTTP(S) 代理，不支持 SOCKS**。连通性测试不代表模型推理一定可用，切换代理也不保证获得新的额度。请仅使用获授权的代理并遵守上游服务限制。

## 注意事项

- **非官方项目**：与 OpenCode、DeepSeek 无隶属关系。上游协议、模型和免费额度可能变化，不保证服务持续可用。
- **第三方数据处理**：模型请求会发送给 OpenCode 服务；使用代理时，请求还会经过所配置的代理。不要发送不愿交给第三方处理的内容。
- **输入限制**：当前以文本对话和工具调用为主，图片与附件内容不会完整发送给模型。
- **凭据与日志**：代理密码在本地配置文件中以明文保存。不要公开该文件，分享日志或截图前请检查并移除敏感信息。

## 常见问题

| 问题 | 建议 |
|---|---|
| 安装后没有看到模型 | 确认安装到了正在使用的 profile，插件已启用，然后重启 DSH 并检查网络连接。 |
| 出现 HTTP 429 | 稍后重试；如已配置代理，可在设置中查看出口状态。代理不保证能解除服务端额度限制。 |
| 出现 HTTP 403 或 503 | 检查插件更新与上游服务状态，稍后重试；这类错误不会触发代理轮换。仍有问题时请反馈。 |
| 工具调用失败 | 在“诊断日志”标签查看错误，也可让 Agent 调用 `opencode_bridge_audit` 检查工具兼容性。 |

问题反馈请提交 [Issue](https://github.com/Vikrant-Aleph/dsh-opencode-bridge/issues)，附上插件版本、错误文字和必要的脱敏日志；请勿提交 API Key、代理密码或私人聊天内容。

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
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.4.1.tgz
```

</details>

实现原理、完整配置、测试方法与维护规约见[技术文档](TECHNICAL.zh.md)（[English](TECHNICAL.md)）。

## 致谢与许可

协议研究参考 OpenCode 官方源码，以及 sub2api、9router、hermes-oc-free-provider、cpa-plugin-opencodezen 等开源项目；来源与对照记录见技术文档。

本项目采用 [MIT 许可证](LICENSE)。
