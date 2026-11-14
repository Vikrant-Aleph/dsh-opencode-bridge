# dsh-opencode-bridge — 技术设计

中文 | [English](TECHNICAL.us.md) · [伪装原则](CAMOUFLAGE.md)

记录 OpenCode 免费档门禁如何被逆向、线上协议如何复刻、适配器如何映射到 DSH
LLM 契约，以及上游变化时如何应对。也涵盖可选的上下文精简及其安全约束。

读者：本插件维护者，以及想参考一个 provider 线上协议 `LlmAdapter` 实现的 DSH 插件作者。

> **带日期的快照。** 本文所有上游事实均于 2026-10/11 通过实测建立：`https://opencode.ai/inference/*`、
> 已安装的官方 CLI（2.2.0）实测，以及阅读 `anomalyco/opencode` 源码。门禁会演进，
> 所有常量都是有日期的观测，不是规范。§8 是更新手册。

## 0. 文档维护

本文件与其[英文版](TECHNICAL.us.md)必须同步修改。凡属以下变化，须在同一次改动中更新两份：
用户可见功能（配置键、UI、工具、日志）、协议原则、已记录常量（UA、请求头、工具声明、端点、默认值）、
构建/打包/发布流程，或版本号。版本号变更还须同步 `README.us.md` 与 `README.md` 中的安装命令，
使其与 `package.json` 的 `version` 一致；`tests/readme-version.test.mjs` 会强制校验。

README 面向访客（概览、安装、限制、故障排查），本文件面向维护者（协议、内部实现、配置、测试）。
每次变更记录在 §11。代码已改而文档滞后不可接受。

**两条引用证据的规则。** 由 `tests/evidence-links.test.mjs` 强制：

1. **文档引用的每个文件都必须随本仓库发布。** 证据不可得的结论无法被核查，引用也就失去意义。
   把抓包放到 [`docs/evidence/`](docs/evidence/README.md) 并链接过去。
2. **绝不在文档中提及任何未发布的内容。** 不要描述哪些内容被保留、存放在哪里、以及为什么。
   读者无法访问的东西只会带来困惑。

---

## 1. 插件定位

一个 `LlmAdapter`，复刻官方 OpenCode 客户端的线上协议，让 DSH 无需账号即可使用
`opencode.ai` 的 `-free` 模型。

它**不**修改 agent loop、不自行执行工具、不 patch 全局 HTTP 入口。工具执行、权限与
schema 校验都留在 DSH。

两条贯穿全项目的原则：

1. **只伪装官方无法让用户改变的部分。** 上游的工具清单与系统提示可由用户配置，
   复刻它们不携带身份信息。见[伪装原则](CAMOUFLAGE.md)。
2. **以带日期的证据取代假设。** 常量只在有抓包支持时保留；§8 说明如何重新推导每一条。

## 2. 架构

```
DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
OpenCodeFreeAdapter            src/adapter.ts
   ├── planTools               src/opencode-protocol.ts   声明调用方工具（必要时加占位）
   ├── buildChatMessages       src/opencode-protocol.ts   DSH 消息 → OpenAI 对话
   ├── buildHeaders            src/opencode-protocol.ts   身份头 + 追踪头
   ├── prepareImageProjection  src/image-input.ts         官方附件接口
   └── fetchWithPool           src/proxy-pool.ts          出口池、冷却、故障切换
          │
          ├── bunFetch        src/bun-transport.ts        Bun 形态 TLS（wreq-js）
          └── plain fetch                                 不可用时的回退
   ▼
https://opencode.ai/inference/...
```

支撑模块：

| 模块 | 职责 |
|---|---|
| `src/catalog.ts` | 免费模型发现：models.dev 注册表 ∩ 实时 `/models`，含 TTL 与重试。 |
| `src/project-identity.ts` | 按真实目录推导官方 `x-opencode-project`。 |
| `src/request-waits.ts` | 按模型持久化服务端重试截止时间，跨重载保留。 |
| `src/http-errors.ts` | 上游错误分类；安全、有界的诊断信息。 |
| `src/retry-after.ts` | 严格解析 `Retry-After`（毫秒、秒、HTTP-date）。 |
| `src/reasoning-policy.ts` | 仅 Host 侧的已完成轮次思考投影，供可选精简使用。 |
| `src/context-service.ts` | 上下文精简偏好（RPC 与 agent 工具共用同一操作）。 |
| `src/logger.ts`, `log-service.ts` | 分级、脱敏的诊断日志。 |
| `src/proxy-service.ts` | 设置页使用的出口池编辑与探测。 |
| `client.js` | 设置页（浏览器模块，非 tsc 产物）。 |

## 3. 实测到的门禁

识别出三层。其中第三层后来被实验**否定**——仍记录在此，因为这次否定正是当前
代码形态的原因。

### 3.1 User-Agent

`opencode/<channel>/<version>/<name>`，例如 `opencode/latest/2.2.0/cli`。按抓包值
逐字节发送。带版本号的外部产品标记（如 `deepseek-harness/<n>`）会被拒绝，因此
DSH 署名是可选项（`userAgentAttribution`），默认关闭。

### 3.2 会话与请求身份

`ses_` id 编码 48 位时间字段：CLI 的降序编码 `~(ms * 0x1000 + counter)`，配小计数器，
后接 14 位 base62 字符。同一 id 同时作为 `x-opencode-session`、`x-opencode-session-id`、
`x-session-affinity`、`x-session-id` 发送。

`x-opencode-project` 由调用方目录推导，与抓包验证过的官方规则一致：

- Git 检出 → `sha1("git-remote:" + 规范化远端)`
- 其它目录 → `sha1("directory:" + 真实路径)`

### 3.3 工具声明——已被否定

早期版本会注入 OpenCode 内置工具清单，并把冲突的调用方工具改名为 `*_client`。
**实验推翻了该前提**（`docs/evidence/user-customization-round2-2026-11-13.json`、
`docs/evidence/user-add-tools-2026-11-13.json`）：

| 方式 | 结果 |
|---|---|
| `agents.<name>.system` | 完全替换系统提示 |
| `agents/<name>.md`（全局或项目） | 完全替换系统提示 |
| 不带工具的自定义 agent | 工具清单从 12 个降到 1 个 |
| 插件注册自造工具 | 请求中携带任意名称与 schema |

也就是说，用户可以借助官方客户端本身发出任意工具清单与系统提示，两者都无法标识客户端。
现在桥接只声明调用方自己的工具。

### 3.4 唯一需要桥接补上的声明

多个独立项目的社区报告声称必须存在名为 `read` 的工具。这一具体说法**未能复现**：在同一运行时下
只改变工具数组，一个名为 `dsh_probe_tool` 的单一工具同样通过
（`docs/evidence/any-tool-vs-read.json`）。真正被要求的是**至少声明一个工具**——空清单会被拒
（`docs/evidence/bun-tool-minimum.json`）。

因此调用方自己的工具就能满足该要求，`planTools` 仅在调用方一个工具都没有时才补占位声明。
这样正常流量中不会出现 DSH 无法执行的工具；占位工具的描述明确劝阻调用，万一仍被调用，
适配器会**丢弃**该调用（记 `warn` 日志），该轮正常结束。

### 3.5 传输层

官方客户端运行在 Bun 上。Node 的 TLS 无法表达同样的 `ClientHello`：OpenSSL 自行排列
扩展顺序，且不提供后量子 key share。对照抓包实测，Node 的 `tls`/`tls-impersonate`
路径产生的扩展顺序不同、Hello 约 274 字节（官方 1482）。

`src/bun-transport.ts` 把握手交给 `wreq-js`（Rust + BoringSSL），参数取自抓包。
该库是**可选**依赖；缺少对应原生绑定时适配器回退到普通 `fetch`。

复刻抓包需要四处修正，每一处都由深度扩展对比发现：

| 修正 | 细节 |
|---|---|
| `curvesList` | 去掉多出的 `MLKEM768` 组；客户端只提供 `X25519MLKEM768`、`X25519`、`P-256`、`P-384`。 |
| `sigalgsList` | `0x0807` 是 **ed25519**，不是 `rsa_pss_pss_sha256`（后者是 `0x0809`）；`0x0603` 在 BoringSSL 中写作 `ECDSA+SHA512`。两者齐备才能凑出抓包中的 11 项。 |
| 头名称大小写 | `Authorization`、`Content-Type`、`User-Agent`、`Connection`、`Accept`、`Host`、`Accept-Encoding`、`Content-Length`——传输层的默认值是小写。 |
| 头位置 | `Host`、`Accept-Encoding`、`Content-Length` 显式提供，使其落在第 14–16 位；否则传输层会把它们追加到末尾。 |

完成上述修正后，`ClientHello` **扩展零差异**、记录长度与抓包同为 1482 字节；请求头除
`x-opencode-project`（由调用方目录推导）外逐字节一致
（`docs/evidence/clienthello-deep-2026-11-13.json`、`docs/evidence/byte-exact-2026-11-13.json`）。

持久化的 `wreq` Transport 跨轮次复用一条连接，与官方客户端一致；只有响应体被完整读取后，
连接才会归还连接池。

客户端**只提供 `http/1.1`**，没有 `h2`，因此 HTTP/2 SETTINGS 指纹不属于本客户端的流量特征。

### 3.6 两项结构要求

模型被调用之前有两项属性会被检查，且官方客户端无论如何配置都会追加：

| 要求 | 结论 |
|---|---|
| **至少声明一个工具** | 任意工具名均可满足；空清单被拒（`FreeUsageLimitError`）（`docs/evidence/bun-tool-minimum.json`、`docs/evidence/any-tool-vs-read.json`）。 |
| **系统提示含 `<env>` 块** | 仅含该块的 177 字节提示即可通过；不含则被拒（`docs/evidence/bun-env-hypothesis.json`）。 |

`<env>` 的值不被校验：改写路径或翻转 git 标志仍能通过
（`docs/evidence/bun-env-strictness.json`），因此该块由真实工作目录生成。
官方 harness 原文与 Code Mode 目录**不**需要——用 DSH 自己工具合成的目录同样通过
（`docs/evidence/bun-synthetic-catalog.json`）。

运行时不是差异来源：Bun 1.4.4 用零工具请求体同样被拒
（`docs/evidence/bun-runtime-test.json`）。

**工具名不能含分隔符。** 这是 2026-11-14 才定位的第三项要求，也是 UI 长期失败的原因。
网关对名称含下划线、连字符、点号或大写的工具声明返回 `FreeUsageLimitError`——外观与配额耗尽
完全相同，因此长期被误判为限流。实测对照：

| 请求体 | 工具名 | 结果 |
|---|---|---|
| 完整 UI 请求（46 工具、69 KB） | 原名（含下划线） | 429 |
| 同一请求体 | 去掉分隔符（`askuserquestion`） | **200** |
| 6 个极小工具 | `job_list`、`web_search`… | 429 |
| 同样 6 个对象 | `pwsh`、`read`、`glob`… | 200 |

官方客户端的 12 个工具全部无分隔符（`edit`、`glob`、`grep`、`question`、`read`、
`shell`、`skill`、`subagent`、`webfetch`、`websearch`、`write`、`execute`）。
此外，声明中至少要有一个网关认识的名称：一组纯自造名称即使无分隔符也会被拒。

`planTools` 因此把每个名称净化为 `[a-z0-9]`（冲突时追加序号），并保留
「净化名 → 真实名」的映射；模型返回调用时再映射回真实工具名，DSH 的派发不受影响。
调用方一个工具都没有时补一个占位声明，其描述明确劝阻调用，万一仍被调用则丢弃（记 `warn` 日志）。

### 3.5 与官方编码器的字段级差异

逐行读过官方 OpenAI Chat 编码器（`openai-chat.ts`，1288 行）后，只剩三处差异。每一条都在
同一开放窗口内测过，前后各有对照（`docs/evidence/tools-field-and-token-budget-2026-11-14.json`）：

| 差异 | 官方做法 | 桥接做法 | 实测 |
|---|---|---|---|
| `tools` 为空时 | 省略整个字段 | 补一个 `read` 占位声明 | **省略会被拒（429）**，占位是必需的 |
| `max_completion_tokens` | 发调用方给的值 | 抬到 `minOutputTokens`（默认 32000） | 小值（1000）**被接受**，抬高不是必需，但保留为配置选择 |
| `messages` 里的 system 消息 | 渲染成 user 消息 | 并入开头的 system 消息 | 网关接受两种形态，但**不采用官方做法**：DSH 唯一的 system 消息就是系统提示本身 |

第一条值得记下：官方客户端的 `Generate.text`（标题生成）确实发不含 `tools` 的请求体，而这类请求
会被网关拒绝——只是标题失败是静默的，所以从未被发现。

其余字段均已对齐：`store` 与 `prompt_cache_key` 都不发（官方仅在 provider 声明支持时发送），
`temperature`、`stop`、`reasoning_effort` 有则转发，助手消息的 `content: null`、
`reasoning_content` 空串、`tool_calls` 形状与官方一致。

适配器把 `environmentBlock()` 追加在 DSH 提示**之后**，与官方客户端的位置一致，
使 agent 自身的指令仍然主导。两者到位后，适配器自身路径可稳定返回 200
（`docs/evidence/verify-env-fix.json`、`docs/evidence/placeholder-verify.json`）。

## 4. 线上协议

### 4.1 请求头

| 头 | 值 |
|---|---|
| `authorization` | `Bearer public`（未登录哨兵值） |
| `content-type` | `application/json` |
| `accept` | `*/*` |
| `accept-encoding` | `gzip, deflate, br, zstd` |
| `user-agent` | `opencode/latest/2.2.0/cli` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | 推导值（§3.2） |
| `x-opencode-session`、`x-opencode-session-id`、`x-session-affinity`、`x-session-id` | 会话 id |
| `b3`、`traceparent` | 每次请求按抓包形态生成（`tracing: false` 可关闭） |
| `x-opencode-request` | **不发送**（2.x 不含；兼容 1.x 时设 `requestIdHeader: true`） |

`host`、`content-length`、`connection` 由传输层写入。

### 4.2 请求体

```jsonc
{
  "model": "deepseek-v4.1-flash-free",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [...],            // 调用方工具；若一个都没有则放一个占位
  "max_completion_tokens": 32000
}
```

**不发送** `tool_choice` 与 `prompt_cache_key`：抓包中的客户端两者皆无。
`max_completion_tokens` 提升到 `minOutputTokens`（默认 32000），与客户端按目录推导的预算一致。

### 4.3 消息映射

| DSH | 线上 |
|---|---|
| `options.system` | 首条 `{role:'system'}` |
| `role:'system'` | `{role:'system'}` |
| `role:'developer'` | 丢弃——工具变更已体现在 `options.tools` |
| `role:'tool'` | `{role:'tool', tool_call_id, content}`；空结果发 `''` |
| `role:'assistant'` | `{role:'assistant', content, reasoning_content?, tool_calls?}`；文本用 `''` 拼接，仅“有工具调用且无文本”时 `content` 为 `null`，`reasoning_content` 仅在存在思考或模型需要时发送 |
| 用户内容 | 视觉路由上按顺序保留 text/`image_url` |

返回的调用保留 id、名称与原始参数字节：查找与校验由 DSH 负责。整批缓冲至
`finish_reason: tool_calls`；被截断的批次返回 `TOOL_BRIDGE_INCOMPLETE` 且不派发任何调用。

## 5. 适配器行为

- **流式**：增量解析 SSE，文本、思考与工具调用增量映射为 DSH chunk。输出开始后的
  流失败不会重放（`PARTIAL_STREAM_ERROR`）。
- **重试**：适配器声明有界策略（`maxRetries: 2`、初始 2s、上限 120s、抖动 0.2），
  自身不启动定时器。服务端给出的等待按原值遵守，绝不被本地策略缩短、抖动或封顶。
- **按模型等待**：观测到的 `Retry-After` 按模型保存并持久化，并记录产生它的出口；
  设定的截止时间。其它模型与元数据请求不受影响。
- **免费额度拒绝**：类型化的 `FreeUsageLimitError` 转为 `FREE_USAGE_LIMIT`——不重试，
  这不构成整个出口已耗尽的证据。本地猜测不会成为服务端等待。等待文件每次检查前重读，外部清空立即生效；记录所属出口不再被配置时该等待自动失效；设置页提供「清除冷却」。

**重探策略**：网关的 `Retry-After` 指向 UTC 午夜，但实测它几分钟内就会恢复服务（17:24 被拒、17:27 同一模型可用）。因此冷却只阻塞一个指数退避窗口——60 秒起、逐次翻倍、上限 15 分钟——而不是服务端声称的时长；服务端截止时间仍记录，仅作上限与诊断。
- **取消**：POST 前、缓冲后、每个工具块前均检查。

### 5.1 图片

`src/image-input.ts` 只使用公开附件接口（`readImageRequest`），从不猜测存储路径。
是否读取由模型声明决定：只有声明 `image` 输入的路由才读取字节。默认预算为 4 MP、
单图 1 MiB、总计 20 MiB、20 次出现；超预算返回 `IMAGE_OFFLOAD_REQUIRED`，不会静默丢弃。
工具结果中的图片在整个连续的 tool-result 组**之后**作为一条关联 user 消息上提。

### 5.2 思考回放

每条 assistant 历史行在模型需要或确实存在思考时携带 `reasoning_content`。可选精简
（`trimCompletedReasoning`）只移除 Canonical **已完成**轮次的思考，通过消息 id 与
SHA-256 指纹校验；进行中、失败或中断的链条一律保留。仅影响新请求，不删除本地历史。

## 6. 模型目录

`src/catalog.ts` 取 models.dev 注册表（成本为 0 且未弃用）与实时 `/models` 的交集。
快照原子提交：单个源失败不会擦掉可用快照。默认每 10 分钟刷新，失败后退避 60s。
`modelRefreshIntervalMs: 0` 关闭周期刷新，但保留启动预取与按需缓存。

## 7. 配置

| 键 | 默认值 | 用途 |
|---|---|---|
| `baseUrl` | `https://opencode.ai/inference/v1` | relay 基址。 |
| `apiKey` | `public` | 未登录哨兵值。 |
| `userAgent` | `opencode/latest/2.2.0/cli` | 身份 UA，逐字发送。 |
| `userAgentAttribution` | `false` | 追加 DSH 署名标记。 |
| `client` | `cli` | `x-opencode-client`。 |
| `requestIdHeader` | `false` | 发送 `x-opencode-request`（仅 1.x 中继）。 |
| `tracing` | `true` | 发送 `b3`/`traceparent`。 |
| `bunTransport` | `true` | 可用时使用 Bun 形态 TLS 传输。 |
| `toolStrict` | `true` | 工具声明加 `strict: false`。 |
| `minOutputTokens` | `32000` | `max_completion_tokens` 下限。 |
| `project` | `global` | 显式 `x-opencode-project`，覆盖推导。 |
| `projectDirectory` | `''` | 推导用目录；空表示 cwd。 |
| `providers` | `['opencode-bridge']` | 服务的 provider 路由。 |
| `includeDeprecated` | `false` | 提供已弃用但在线的模型。 |
| `extraModels` | `[]` | 强制追加模型 id。 |
| `requestTimeoutMs` | `600000` | 单请求截止时间。 |
| `modelRefreshIntervalMs` | `600000` | 目录刷新；`0` 关闭轮询。 |
| `trimCompletedReasoning` | `false`（live） | 设置 → 上下文精简。 |
| `toolResultImages` | `true` | 视觉路由转发工具输出图片。 |
| `requestImagePixelBudget` | `4194304` | 请求图片像素。 |
| `requestImageMaxBytes` | `1048576` | 单图编码字节目标。 |
| `maxRequestImageBytes` | `20971520` | base64 总预算。 |
| `maxRequestImages` | `20` | 保留的图片出现次数。 |
| `proxies` | `[]` | 出口池，按顺序。 |
| `proxyCooldownMs` | `60000` | 本地兜底冷却；不缩短服务端等待。 |
| `proxyStorePath` | `''` | 设置页拥有的池存储。 |
| `logLevel` | `warn` | `debug`\|`info`\|`warn`\|`error`\|`off`。 |
| `logDir` | `''` | 默认使用 profile 日志目录。 |
| `logMaxBytes` / `logMaxFiles` | `524288` / `5` | 轮转。 |

## 8. 上游变化时

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `403 FreeTierError` | 身份形态被拒 | 检查 UA、会话头、是否至少声明了一个工具、以及 `<env>` 块是否存在（§3）。 |
| `429 FreeUsageLimitError` | 免费通道拒绝或真实配额 | 读诊断；不要重试、轮换或清空已保存的等待。 |
| `400 MissingSessionID` | 缺少会话头 | 会话生成失效。 |
| 端点 `404`/`426` | 路由迁移 | 重读目录的 `provider.api`。 |
| 目录为空 | 注册表或 `/models` 失败 | 查日志；上一份快照仍被保留。 |

重新推导某个常量：

1. 用**已安装的官方客户端**抓包，走本机回环端点（不要靠猜）：`--standalone`、
   隔离配置、本地假模型，然后记录头、请求体与 TLS `ClientHello`。
2. 与 `buildHeaders`/`buildChatMessages`/`BUN_TLS_EMULATION` 对比。
3. 只改抓包与之矛盾之处，且只按抓包所指方向改。
4. 在 `tests/` 中新增或更新固定该值的断言。
5. 在 §11 记录本次变更。

## 9. 测试

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json   # 构建
node --test tests/*.test.mjs                            # 全量离线测试
```

全部测试均为离线。`tests/*-live.mjs` 下的实测探针需显式加 `--run`，且拒绝覆盖既有报告。

| 套件 | 覆盖 |
|---|---|
| `current-protocol`、`alignment`、`gateway-requirements` | 线上形态、头、工具声明、`<env>` 块、占位工具处理。 |
| `bun-transport` | 抓包得到的加密套件/扩展配置。 |
| `bridge-integration`、`bridge-stream` | 批次原子性、不完整批次、流式组装。 |
| `reasoning-*` | 回放规则、精简资格、流探针。 |
| `image-*`、`vision-*` | 附件投影、预算、工具图片上提。 |
| `retry-integration`、`proxy-rotation` | 服务端等待、池冷却、不重放保证。 |
| `project-identity`、`request-waits` | 身份推导、持久化截止时间。 |
| `catalog-*`、`log-*`、`client-boot` | 目录生命周期、脱敏、设置页。 |

## 10. 安全、隐私与署名

- 除配置的 `apiKey` 外不读取任何凭据；代理 URL 在所有日志与 UI 中脱敏。
- 日志仅含元数据：不含提示、工具入参、结果或图片字节。
- 图片数据在任何级别都不会进入日志（由测试保证）。
- 插件不新增 `exec`/`spawn` 调用。对 DSH 的署名可通过 `userAgentAttribution` 开启，
  因协议原因默认关闭（§3.1）。

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-13 | **1.0.0** | **找到并满足网关的两项要求。** 两项结构要求现已满足：至少声明一个工具（名称任意）、系统提示含 `<env>` 块。`read` 占位仅在调用方没有任何工具时添加，其描述明确劝阻调用；万一被调用则丢弃该调用而不是让整轮失败。传输层：`wreq` 持久 Transport 与连接池、`Connection: keep-alive`、官方头大小写与位置、`curvesList` 裁剪、`sigalgsList` 补齐（`ed25519` + `ECDSA+SHA512`），以及此前导致传输层从未生效的接线缺失；选中的代理 URL 现在会传给非 undici 传输层，因此 Bun 形态传输下代理轮换仍有效。移除工具桥层、`opencode_bridge_audit` 与失效的 `harnessSystem` 选项。 |
| 2026-10-23 | 0.5.5 | 可选已完成轮次思考精简，含持久化设置标签页。 |
| 2026-10-22 | 0.5.4 | 官方附件图片（Issue #3）；工具结果图片上提。 |
| 2026-10-21 | 0.5.3 | assistant 思考回放（Issue #2）。 |
| 2026-10-19 | 0.5.2 | 有界重试、安全的 429 诊断、严格冷却。 |
| 2026-10-19 | 0.5.1 | 动态模型目录刷新。 |
| 2026-10-18 | 0.4.1 | SOCKS4/4a/5/5h、DNS 模式、凭据处理。 |
| 2026-10-18 | 0.3.0 | 出口代理池与轮换。 |
| 2026-10-17 | 0.1.0 | 首个版本：门禁复刻、`OpenCodeFreeAdapter`、模型目录。 |

## 12. 术语

| 术语 | 含义 |
|---|---|
| **免费档** | 向官方客户端提供的无 key 模型集合。 |
| **门禁** | 上游用于判定是否服务非官方客户端请求的检查机制。本项目把它当作带日期的观测。 |
| **身份头** | 官方客户端恒发、用户无法更改的请求头（§3）。 |
| **占位声明** | 仅在调用方没有任何工具时发送，用于满足网关“至少一个工具”的要求。 |
| **净化名** | 声明到线上的工具名，已去掉分隔符；返回调用时映射回调用方的真实工具名。 |
| **服务端等待** | 来自上游的 `Retry-After`；绑定到产生它的出口，只阻塞一个有上限的退避窗口，可手动清除。 |
| **出口** | 一条通往上游的配置路线（`direct` 或代理）。 |
| **Bun 形态传输** | 复刻官方客户端 `ClientHello` 的 wreq-js 握手。 |
