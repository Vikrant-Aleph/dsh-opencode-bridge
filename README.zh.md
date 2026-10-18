# dsh-opencode-bridge

[English](README.md) | 中文

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）里直接使用
[OpenCode](https://opencode.ai) 的**免费模型**——无需账号、无需 API Key。

插件是一个 DSH **LLM 适配器** bundle，通过模拟官方 OpenCode 客户端的请求协议通过
opencode.ai 免费层（"Zen" relay）的客户端识别：`big-pickle`、`mimo-v2.6-flash-free`、
`glm-5.3-flash-free`、`deepseek-v4.1-flash-free`、`nemotron-3.5-lightning-free`、
`space-bunny-free` 等模型即可在 DSH 的模型选择器中使用。

## 工作原理

免费层对非 OpenCode 客户端返回 `403 FreeTierError`。本插件完整复刻官方客户端的请求指纹
（2026-10 实测验证）：

| 闸门层 | 插件发送的内容 |
|---|---|
| User-Agent | `opencode/<版本> ai-sdk/provider-utils/... runtime/bun/...`，并附加 DSH 归属信息（剥掉 `/<版本>`，带版本的第三方产品令牌会被拒绝） |
| 会话标识 | `x-opencode-session` / `x-opencode-session-id` / `x-session-affinity` / `x-session-id` 使用同一会话内稳定的 `ses_` id，`x-opencode-request` 用每次调用的 `msg_` id；两者都按 CLI 的 `~(ms*0x1000+counter)` 48 位降序/升序编码 + 14 位 base62 随机后缀生成，上游会解码校验计数器 |
| 客户端头 | `x-opencode-client: cli`、`x-opencode-project: global` |
| 工具指纹 | 请求体声明 OpenCode 内置 `read`/`shell` 工具的**逐字** schema 以及 `bash`/`glob`/`grep` 桩定义；DSH 同名工具改以 `*_client` 别名传输，对新增工具的调用会自动翻译到 DSH 的 `pwsh`/`read`/`glob`/`grep`，保持可用 |
| 流式 | `stream: true`、`tool_choice: "auto"` |

模型清单来自公共 [models.dev](https://models.dev) 注册表（零成本条目）与 relay 实时
`GET /models` 列表的交集，含上下文窗口、输出上限和推理档位元数据。

## 安装

**从 npm 安装**（发布后）：

```sh
npx @deepseek-ai/dsh plugin --profile desktop add dsh-opencode-bridge
```

**从源码安装**（本目录）：

```sh
pnpm install && pnpm build && pnpm pack

# 把 tarball 装入你的 profile（以 "desktop" 为例）
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-opencode-bridge-0.2.1.tgz
```

重启 profile 后，在模型选择器里选任意 `opencode-free/*` 模型即可，无需任何配置。

## 配置（可选）

所有配置项均有可用默认值，可在 `cordis.patch.yml` 中覆盖（覆盖行需写在顶层并重述全部键）：

```yaml
- id: dsh-opencode-free
  config:
    baseUrl: https://opencode.ai/inference/v1   # relay 地址
    apiKey: public                              # 未登录哨兵值
    userAgent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
    client: cli                                 # x-opencode-client
    project: global                             # x-opencode-project
    providers: [opencode-free]                  # 提供方路由
    includeDeprecated: false                    # 是否提供仍在线的 deprecated 模型
    extraModels: []                             # 强制附加的模型 id
    requestTimeoutMs: 600000
    toolFingerprint: true                       # 发送工具指纹
    toolTranslation: true                       # 把指纹工具调用映射到 DSH 工具
    logLevel: info                              # debug|info|warn|error|off
    logDir: ''                                  # 空 = ~/.dsh/logs/dsh-opencode-free
    logMaxBytes: 524288                         # 单文件大小上限，超出即轮转
    logMaxFiles: 5                              # 保留文件总数，最旧的先删
```

## 日志与诊断

分级诊断日志（`debug`/`info`/`warn`/`error`）记录适配器活动——仅元数据，
绝不包含提示词内容或凭据。每行写入前已脱敏；磁盘占用有界：超出
`logMaxBytes × logMaxFiles` 时**最旧的日志文件先被删除**。

- **Agent 工具** `opencode_free_log`：`action: read|stat|clear|level`，
  模型可自行拉取诊断日志。

## 说明与限制

- **限流**：免费层按 IP 限流（`429 FreeUsageLimitError`）。重度使用会暂时耗尽配额；插件原样
  转发上游错误信息。
- **文本 + 工具优先**：此通道的图片/文件以占位文本发送；多数免费模型本身也是纯文本输入。
  会输出 `reasoning_content` 的模型，其思考内容会以 thinking 块呈现。
- **随 relay 演进**：上游闸门变化很快（2026-10 数天内连续增加了会话计数器和工具校验）。若重新出现
  `403 FreeTierError`，请更新 `src/opencode-protocol.ts` 中的 `userAgent`/工具指纹。
- 仅提供零成本模型。OpenCode 的付费模型需要 OpenCode Console 账号，不在本插件范围内。

## 开发

```sh
pnpm build       # tsc -> lib/
pnpm test        # node --test tests/*.test.mjs
node tests/smoke.mjs [模型id]   # 实测端到端探针
```

`tests/smoke.mjs` 会验证 ID 编码、工具规划、实时模型目录，并向 relay 发起一次真实的流式对话。

关于协议内部细节——三层闸门、标识符位布局、工具遮蔽/翻译，以及上游变化时的更新手册
——见 [TECHNICAL.zh.md](TECHNICAL.zh.md)（[English](TECHNICAL.md)）。

## 致谢

协议细节来自官方客户端源码（`sst/opencode`）的逆向分析，并与社区报告交叉验证
（sub2api、9router、hermes-oc-free-provider、cpa-plugin-opencodezen）。本项目与
OpenCode、DeepSeek 均无关联。

## 许可

MIT
