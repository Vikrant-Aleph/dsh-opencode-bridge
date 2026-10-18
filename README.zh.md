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
| 工具指纹 | 声明规范 `read`/`shell` 及 `bash`/`glob`/`grep`；先预留全部调用方名字再分配无碰撞别名。新增 shell 工具不可执行；仅经保守验证的只读/搜索映射可到达调用方已提供的工具。 |
| 流式 | `stream: true`、`tool_choice: "auto"` |

模型清单来自公共 [models.dev](https://models.dev) 注册表（零成本条目）与 relay 实时
`GET /models` 列表的交集，含上下文窗口、输出上限和推理档位元数据。

## 安装

**从 npm 安装**（发布后），建议像 `dshmarket@1.66.35` 那样带上版本号，便于复现：

```sh
dsh plugin --profile desktop add dsh-opencode-bridge@0.4.0
```

`dsh` 来自你的 DSH 安装；如果它不在 `PATH` 里，同一条命令换成
`npx @deepseek-ai/dsh plugin ...` 即可。

**从源码安装**（本目录）：

```sh
pnpm install && pnpm build && pnpm pack

# 把 tarball 装入你的 profile（以 "desktop" 为例）
dsh plugin --profile desktop add ./dsh-opencode-bridge-0.4.0.tgz
```

重启 profile 后，在模型选择器里选任意 `opencode-bridge/*` 模型即可，无需任何配置。

## 配置（可选）

所有配置项均有可用默认值，可在 `cordis.patch.yml` 中覆盖（覆盖行需写在顶层并重述全部键）：

```yaml
- id: dsh-opencode-bridge
  config:
    baseUrl: https://opencode.ai/inference/v1   # relay 地址
    apiKey: public                              # 未登录哨兵值
    userAgent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
    client: cli                                 # x-opencode-client
    project: global                             # x-opencode-project
    providers: [opencode-bridge]                  # 提供方路由
    includeDeprecated: false                    # 是否提供仍在线的 deprecated 模型
    extraModels: []                             # 强制附加的模型 id
    requestTimeoutMs: 600000
    proxies: []                                 # 仅直连；如 [direct, 'http://127.0.0.1:7890']
    proxyCooldownMs: 60000                       # HTTP 429 后的基础冷却
    proxyStorePath: ''                           # 空 = $DSH_PROFILE_DIR（未设置则 ~/.dsh）+ /data/dsh-opencode-bridge/proxies.json
    toolFingerprint: true                       # 发送工具指纹
    toolTranslation: true                       # 允许已验证的只读/搜索诱饵；不映射 shell
    logLevel: warn                              # debug|info|warn|error|off
    logDir: ''                                  # 空 = ~/.dsh/logs/dsh-opencode-bridge
    logMaxBytes: 524288                         # 单文件大小上限，超出即轮转
    logMaxFiles: 5                              # 保留文件总数，最旧的先删
```

`toolFingerprint: false` 原样保留调用方工具且不注入诱饵。
`toolTranslation: false` 仍恢复调用方别名，但拒绝注入工具，
不会再把未验证的 OpenCode 参数直接交给 DSH。

## 安全工具桥与离线当前作用域审计（0.3.0）

工具桥按**实际请求的调用方工具**规划，而不是从全局注册表扩权。
它恢复调用方别名，拒绝新增 `bash`/`shell` 诱饵，不猜测 Bash→PowerShell；
新增 `read`/`glob`/`grep` 仅在当前调用方有目标且 schema 属于可保守验证的子集时映射。
`$ref`、`pattern` 等未知约束默认拒绝。调用方原有 `pwsh`、规范 shell 等工具仍由
DSH 自身校验并执行。原生/别名调用也要求参数是 JSON 对象（保留原始字节），
完整原生 schema/权限仍归宿主。“只读”指桥接路线，不保证任意同名工具实现无副作用。

响应中**全部工具调用通过校验后才发出任何 tool-call 块**，一个拒绝则整批不放行。
工具片段若以 EOF、`length` 或 `stop` 而非 `tool_calls` 结束，返回
`TOOL_BRIDGE_INCOMPLETE`；策略拒绝返回 `TOOL_BRIDGE_REJECTED` 与固定原因，不含入参。
这是桥接层原子放行，不是执行事务/副作用回滚；已流出的文本/思考保留，
宿主后续仍执行自身原生 schema 与权限检查。

可让 agent 调用 `opencode_bridge_audit`：

```json
{ "limit": 12 }
```

也可传 `{}`，默认 limit=80，范围 1–200。它仅读取当前 agent 的原生工具 schema，
输出名字、别名、路线决定和原因码，不输出 schema 描述/default、工具入参或聊天历史。
不联网、不执行工具；缺少 agent 作用域时拒绝，绝不退回全局注册表。
报告 basis 为 `current-agent-scoped-native-registry`，Code Mode/PTC 或辅助请求的工具集
可能不同。它**不是**会话调用历史、HTTP/模型健康测试或权限授权；每次真实请求仍按
`GenerateOptions.tools` 重新规划。既有替代方案与证据边界见[源码比较](docs/COMPARISON.zh.md)。

## 出口代理轮换（0.4.0）

`proxies: []` 表示仅直连；`direct`（也接受 `none` 或空条目）表示本机 IP，
其它条目可用 HTTP(S) 代理 URL 或裸 `host:port`。去重后保留顺序，SOCKS/其它协议拒绝。
HTTP 代理凭据可写 `http://user:password@host:port`，特殊字符需 URL 编码。

设置 → **OpenCode Bridge** → **出口代理轮换（可选）**标签可添加/删除、刷新状态、**测试全部**。
每行显示去掉凭据的地址、就绪/冷却（剩余秒）及 lastCode。测试逐条访问 relay
`GET /models`，不发提示词或补全请求，但仍产生受上游规则约束的网络流量；429 会冷却该条。
离线测试本身不证明浏览器渲染或真实 RPC 已验收。

每次请求按**配置顺序优先复用健康出口**，不为每个会话独立绑定；该出口冷却才顺延，
靠前出口恢复后重新优先。单次请求仅 HTTP 429 或流开始前传输失败触发改道，
401、FreeTierError/403、503 不轮换。优先用数值 Retry-After 提示，否则 429 从
`proxyCooldownMs`（默认60秒）指数冷却，通常上限30分钟；传输失败短期冷却（最多15秒）。
全池冷却时仍尽力尝试最早恢复者，不在本地直接硬失败；流响应体中途失败直接报错，不重试。

UI 保存列表在启动时优先于 config，默认存于
`(DSH_PROFILE_DIR || ~/.dsh)/data/dsh-opencode-bridge/proxies.json`，可由 `proxyStorePath` 覆盖。
health/UI 读取去掉 userinfo；删除/重置不回传已有密码，但添加必然将新输入 URL 发给 Host。
**代理密码在本地 JSON 中明文保存，未加密。**仅支持 HTTP(S) CONNECT，不 patch 全局 fetch/dispatcher。
不同代理不一定有不同公网 IP，上游配额也未证实只由 IP 决定。只使用获授权代理并遵守服务限制。

## 日志与诊断

`opencode_bridge_log` 支持 `action: read|stat|clear|level`。调用点力求只记元数据，
并提供 best-effort 秘密脱敏、最旧优先轮转；这不是完美隐私或严格字节上限保证。
错误正文与元数据仍可能敏感，单次写入可能超出轮转阈值，清理也可能失败。分享前请复核日志。

## 说明与限制

- **限流**：HTTP 429（`FreeUsageLimitError`）冷却当前出口，其它已配置出口可能有用但
  不保证新配额。全池耗尽仍报告限流；服务端也可能使用非 IP 配额信号。
- **文本 + 工具优先**：此通道的图片/文件以占位文本发送；多数免费模型本身也是纯文本输入。
  会输出 `reasoning_content` 的模型，其思考内容会以 thinking 块呈现。
- **随 relay 演进**：上游闸门变化很快（2026-10 数天内连续增加了会话计数器和工具校验）。若重新出现
  `403 FreeTierError`，请更新 `src/opencode-protocol.ts` 中的 `userAgent`/工具指纹。
- 仅提供零成本模型。OpenCode 的付费模型需要 OpenCode Console 账号，不在本插件范围内。

## 开发

需要 **Node ≥ 20.3**（适配器用到 `AbortSignal.any`）和 pnpm：

```sh
pnpm install
pnpm build       # tsc -> lib/（lib/ 是构建产物，未提交到仓库）
pnpm test        # node --test tests/*.test.mjs
node tests/smoke.mjs [模型id]   # 实测端到端探针
```

离线测试覆盖工具规划、桥/schema 拒绝、作用域审计、响应整批校验、客户端激活与日志；
`tests/wire-dump.mjs` 是离线指纹转储。`tests/smoke.mjs` 验证 ID/规划/目录并发起真实流式对话，
会消耗网络/额度；它不验证所有模型、Desktop 启动或全部工具执行路径。

关于协议内部细节——三层闸门、标识符位布局、工具遮蔽/翻译，以及上游变化时的更新手册
——见 [TECHNICAL.zh.md](TECHNICAL.zh.md)（[English](TECHNICAL.md)）。

## 致谢

协议细节来自官方客户端源码（`sst/opencode`）的逆向分析，并与社区报告交叉验证
（sub2api、9router、hermes-oc-free-provider、cpa-plugin-opencodezen）。本项目与
OpenCode、DeepSeek 均无关联。

## 许可

MIT
