# dsh-opencode-bridge — 技术设计文档

[English](TECHNICAL.md) | 中文

`dsh-opencode-free` 插件的工程文档：免费层闸门如何被逆向、线上协议如何被复刻、
适配器如何映射到 DSH 的 LLM 契约，以及上游变化时该怎么办。

读者：本插件的维护者，以及想找一个"厂商线上协议型 `LlmAdapter`"完整范例的 DSH 插件作者。

> 快照声明：下文所有闸门结论均于 **2026-10** 在 `https://opencode.ai/inference/v1`
> 上实测得出，并对照官方客户端源码（`sst/opencode`，`dev` 分支，v2.0.26）核实。
> 上游闸门仍在持续演进——请把所有常量当作**带日期的快照**而非永久规范。
> 第 10 章是更新手册。

---

## 0. 文档维护规约（对人和 AI 同等生效）

**本文档是活文档。** 每当发生下列任一变化时，必须在同一次改动中更新本文档
（`TECHNICAL.zh.md`）及其英文对照（`TECHNICAL.md`），并保持两份内容一致：

1. 增加或删除任何用户可见功能（含配置项、UI、工具、日志行为）；
2. 修改任何技术原理（协议、闸门绕过方式、数据流、模块边界、错误分类）；
3. 更换任何被文档化的常量（UA、指纹工具、端点、默认值、阈值）；
4. 改变构建/打包/安装方式或 DSH 依赖版本。

变更时同步维护第 14 章"变更记录"——先记后改，一行一变更。
**不要留"代码已改、文档未改"的提交。**

### AI 接手指引（先读这里）

你是接手本仓库的 AI？按此顺序建立上下文，不要一上来就改代码：

1. **读完本节与第 1、2 章**——知道插件做什么、挂在 DSH 哪里。
2. **读第 3 章模块地图**——`opencode-protocol.ts` 是闸门常量唯一所在地，
   **改协议行为只改它**；adapter/catalog/logger 各司其职，不要跨界塞逻辑。
3. **动手前读第 4 章（闸门）与第 5 章（线上协议）**——这是本插件的核心风险区：
   改错任何一个常量都会让所有请求吃 403。
4. **改动后必跑**：`node node_modules/typescript/bin/tsc -p tsconfig.json`（编译）、
   `node --test tests/*.test.mjs`（单测）、`node tests/smoke.mjs`（实时探针，
   需网络；429/403 的含义见第 10 章）。
5. **收尾前对照本节顶部的维护规约**，更新本文档与变更记录。
6. 日志/诊断相关的问题先看第 15 章；设置界面 UI 在 `client.js`（非 TypeScript，
   是浏览器端 `__ModuleLoader__` 模块，见第 15.3 节）。
7. **改 `client.js` 前必读 15.6**：`apply()` 抛未捕获异常会让 DSH Desktop
   整个崩掉（web-boot 判定激活失败为致命错误）。改动后必跑
   `node --test tests/client-boot.test.mjs`。

---

## 1. 范围与定位

| | |
|---|---|
| **目标** | 让无密钥的 OpenCode 免费模型成为 DSH 中的一等模型。 |
| **非目标** | OpenCode 付费模型（需 Console 账号与签发的 key）。 |
| **手段** | 一个 `LlmAdapter`，对 opencode.ai relay 说官方客户端的线上协议。 |
| **凭据** | 无。relay 接受未登录哨兵值 `Bearer public`。 |
| **分发** | npm bundle + `cordis.patch.yml` 层补丁。 |

插件不做本地代理，是纯进程内适配器。

---

## 2. 系统上下文

```
┌─ DSH 宿主进程 ────────────────────────────────────────────────────┐
│                                                                   │
│  dsh-agent-loop ──► LlmRuntime ──► OpenCodeFreeAdapter            │
│       │                  │              │                         │
│       │  GenerateOptions │              │ StreamChunk             │
│       └──────────────────┴──────────────┘                         │
│                                    │                              │
│  ctx.llm ◄── registerAdapter ──────┘                              │
│      ▲                                                            │
│      └── FreeModelCatalog ──► models.dev  （元数据）               │
│                           └─► GET /models （实时可用性）           │
└───────────────────────────────────┬───────────────────────────────┘
                                    │ HTTPS + SSE
                                    ▼
                    https://opencode.ai/inference/v1
```

插件只占用 DSH LLM 服务的两个接缝：

1. **`ctx.llm.registerAdapter(providers, adapter)`** —— 提供 provider 路由
   （`opencode-free`）与流式实现。
2. **`ctx.llm.registerModelDiscovery(id, fn)`** —— 提供 GUI 的模型列表。

它不触碰会话、工具或 agent loop。

---

## 3. 模块地图

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/index.ts` | 174 | Cordis 插件入口：`name`、`inject`、Schemastery `Config`、`apply()`、注册、清理器。 |
| `src/opencode-protocol.ts` | 375 | **全部闸门敏感常量。** ID 生成、请求头配方、逐字指纹工具、工具遮蔽/翻译、消息投影。 |
| `src/adapter.ts` | 361 | `OpenCodeFreeAdapter`：模型元数据、请求组装、SSE 解析、`StreamChunk` 发射、错误分类。 |
| `src/catalog.ts` | 143 | `FreeModelCatalog`：models.dev ∪ 实时列表，缓存与降级。 |
| `src/logger.ts` | 326 | `PluginLogger`：分级、脱敏、按大小轮转（最旧优先清理）、内存兜底。见第 15 章。 |
| `src/log-service.ts` | 245 | `LogService` + RPC 路由 + `opencode_free_log` agent 工具（一套实现两个调用方）。 |
| `client.js` | 321 | 设置界面日志查看/复制面板（浏览器端模块，非 tsc 产物）。见 15.3、15.6。 |
| `cordis.patch.yml` | 4 | 把插件行插入配置层的 bundle 补丁。 |
| `tests/logger.test.mjs` | — | 日志模块密闭单测（分级/脱敏/轮转/读取）。 |
| `tests/client-boot.test.mjs` | — | 客户端模块激活回归测试（apply 永不抛错，敌对 ctx 8 例）。 |
| `tests/smoke.mjs` | — | 实时端到端探针（ID → 工具规划 → 目录 → 流式完成）。 |
| `tests/wire-dump.mjs` | — | 打印当前构建实际发出的请求头与指纹。 |

**设计不变量：** 上游闸门可能考察的每个常量都只存在于
`opencode-protocol.ts`。代码库其余部分不硬编码任何协议细节。闸门变化时，
理论上只需要改这一个文件。

---

## 4. 上游闸门

relay 会拒绝它认为不是官方客户端的调用者：

```json
HTTP/1.1 403 Forbidden
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode.
            Download it at https://opencode.ai and keep building."}}
```

朴素尝试（`Bearer public` + 普通 User-Agent + `x-opencode-client: cli`）正是以
此响应失败。通过它需要同时满足三个彼此独立的层次。

### 4.1 第一层 —— User-Agent

值中必须包含足够新的产品令牌 `opencode/<major>.<minor>[.<patch>]`
（不同来源报告为 ≥1.17 或 ≥1.18；本插件发送 1.19.0）。

陷阱在于：**值中任何位置出现带版本的第三方产品令牌都会被拒绝。**
DSH 强制的归属头是 `deepseek-harness/<version> (+url)`；原样发送会直接触发闸门。

修正做法——保留归属信息，只剥掉版本号：

```ts
// src/opencode-protocol.ts
export function attributionSuffix(): string {
  const ua = attributionHeaders()['user-agent']
  return ua ? ` ${ua.replace(/^([\w-]+)\/\S+/, '$1')}` : ''
}
```

最终发出的值：

```
opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14 deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)
```

这既满足 DSH 的归属契约（产品名与项目 URL 仍然公开），又移除了被拒绝的版本段。
理由见第 12 章。

### 4.2 第二层 —— 会话与请求标识

四个请求头携带会话 id，一个携带每次调用的请求 id（见 5.1）。它们不是不透明字符串
——上游会解码：

```
ses_<12 位 hex><14 位 base62>   x-opencode-session、-session-id、x-session-affinity、x-session-id
msg_<12 位 hex><14 位 base62>   x-opencode-request
```

那 12 位 hex 是 **`ms * 0x1000 + counter` 截断到 48 位** 的结果：

- `ses_` 使用**按位取反**（`~value`）——官方 `Identifier.descending()` 方案，
  使更新的会话排在前面。
- `msg_` 直接使用该值——`Identifier.ascending()`。

`counter` 是位于低 12 位的亚毫秒去重计数。实测表明其取值范围会被校验：
**计数器 0–16 通过；计数器 ≥ 100 以 `FreeTierError` 被拒绝。**
伪造大计数器或固定计数器的调用者会被识别出来。

因此本插件按 CLI 的方式生成 id（`opencode-protocol.ts` 中的 `nextIdValue()`）：
每个新毫秒重置计数器，每个 id 递增一次，并在 16 处封顶，
使同一毫秒内的突发也永远到不了被拒绝的区间。

可校验的不变量：当 `counter == 1` 时 `~1 & 0xFFF == 0xFFE`，
所以新生成的 `ses_` id 其 hex 字段必定以 `ffe` 结尾。

### 4.3 第三层 —— 工具指纹

请求体必须声明 OpenCode 自己的内置工具。该要求发生过迁移：

- 早期闸门：`bash`/`glob`/`grep`/`read` 四件套
- v2.0.26：对 `read` 与 `shell` 的**描述与参数 schema** 做精确比对

插件同时发送两套：来自 CLI 的逐字 `read` 与 `shell`（`READ_TOOL`、`SHELL_TOOL`），
外加 `bash`/`glob`/`grep` 桩定义。二者如何与调用方工具共存而不破坏工具执行，
见 6.4。

### 4.4 请求体层面的要求

`stream: true` 与取值非 `"none"` 的 `tool_choice` 在某些路由上属于指纹的一部分。
插件始终流式请求，并发送 `tool_choice: "auto"`。

### 4.5 端点拓扑

| 路径 | 作用 |
|---|---|
| `/inference/v1` | **默认。** OpenAI 兼容 relay。 |
| `/inference/openai/v1` | console 代理的映射目标；对话请求实际由此提供。 |
| `/inference/anthropic/v1` | Anthropic 系模型（注册表 `provider.api` 指向此处）。 |
| `/zen/v1` | 旧别名。 |
| `/inference/systemone/v1` | SystemOne 评测路由——非对话端点。 |

`GET {baseUrl}/models` **可匿名访问**——模型发现不需要指纹，只需要一个像样的 UA。

由于注册表可以按模型覆盖 base（`provider.api`），适配器按请求解析对话端点：
`meta.api ?? config.baseUrl`，再拼接 `/chat/completions`。

### 4.6 实测证据

针对 `/inference/v1/chat/completions` 的实时探针矩阵：

| 探针 | 变化 | 结果 |
|---|---|---|
| A | 逐字 `read` + `shell`，四件套桩，counter = 1 | **200** |
| B | 仅四件套桩（无逐字 schema） | 200 |
| C | counter = 100 | **403 FreeTierError** |
| D | `User-Agent: curl/8.4.0` | **403 FreeTierError** |
| E | `tool_choice: "none"` | 200 |

由此得出的设计结论：

- UA 版本令牌与会话计数器编码是**硬闸门**（探针 C、D）。
- 在该路由、该时间点，精确工具 schema 与 `tool_choice` **并非独立决定性因素**
  （探针 B、E）。
- 插件仍然保留第三、四层，因为源码显示新闸门会比对 schema，且其他路由/版本会强制执行。
  代价是 5 条工具声明，收益是对闸门收紧的抵抗力。

---

## 5. 线上协议参考

### 5.1 请求头

由 `buildHeaders(recipe, sessionId, requestId)` 产生：

| 请求头 | 值 |
|---|---|
| `content-type` | `application/json` |
| `authorization` | `Bearer public` |
| `user-agent` | `<userAgent> deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | `global` |
| `x-opencode-session` | `ses_…` |
| `x-opencode-session-id` | `ses_…` |
| `x-session-affinity` | `ses_…` |
| `x-session-id` | `ses_…` |
| `x-opencode-request` | `msg_…` |

四个会话头携带同一个值；`config.extraHeaders` 最后合并，
因此部署方可以覆盖或扩展任何一项。

### 5.2 标识符位布局

```
value    = (Date.now() * 0x1000 + counter) & 0xFFFF_FFFF_FFFF      // 48 位
counter  ∈ [0, 16]，每个毫秒刻重置
ses_id   = "ses_" + hex48(~value) + base62(随机, 14)
msg_id   = "msg_" + hex48( value) + base62(随机, 14)
```

```
 位 47                位 12  位 11        位 0
┌───────────────────────────┬──────────────────┐
│   时间戳（已截断）         │    counter       │
└───────────────────────────┴──────────────────┘
```

说明：

- 48 位装不下完整的毫秒时间戳（`ms << 12` 今天已超出 48 位），
  因此时间戳实际是 `ms mod 2^36`——约 795 天的循环。
  这无害：上游以同样的位宽解码同一字段，**一致性**才是关键，绝对时间不是。
- 校验正则：`/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`（`SESSION_ID_RE`）。
- 14 位 base62 ≈ 83 位熵，与 CLI 的后缀宽度一致。

### 5.3 指纹工具定义

`FINGERPRINT_NAMES = ['bash', 'glob', 'grep', 'read', 'shell']`。

`READ_TOOL` 与 `SHELL_TOOL` 从官方客户端**逐字**转录，不得改写。
插件自身判断"调用方工具是否已是规范定义"的比较是精确比较：

```ts
tool.description === want.description &&
JSON.stringify(tool.parameters) === JSON.stringify(want.parameters)
```

`bash`/`glob`/`grep` 是廉价桩（`{type:'object', properties:{}}`）——
只为满足早期的四件套检查。

### 5.4 请求体

在 `OpenCodeFreeAdapter.stream()` 中构造：

```jsonc
{
  "model": "glm-5.3-flash-free",
  "messages": [ /* 见 6.5 */ ],
  "stream": true,
  "tools": [ /* plan.tools —— 见 6.4 */ ],
  "tool_choice": "auto",
  "prompt_cache_key": "<去掉 ses_ 前缀的会话 id>",

  // 条件字段
  "max_tokens": 8192,          // options.maxTokens
  "temperature": 0.7,          // options.temperature
  "stop": ["..."],             // options.stop，非空时
  "reasoning_effort": "high"   // 仅当目录为该模型列出此档位时
}
```

`reasoning_effort` 有守卫：只有模型的注册表条目发布了该档位值才会发送，
因此不受支持的档位永远不会到达线上。

---

## 6. 适配器设计

### 6.1 DSH LLM 契约

`LlmAdapter`（来自 `@deepseek-ai/dsh-llm`）只要求：

```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

插件额外覆写四个可选钩子：

| 钩子 | 目的 |
|---|---|
| `providerInfo(provider)` | GUI 显示名 `OpenCode Free`。 |
| `listModels(provider)` | 目录驱动的模型选择器。 |
| `resolveModel(provider, model, signal)` | 发布 `context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts`。 |
| `prepareCall(provider, model, signal)` | 把元数据与流入口绑定到同一代实现。 |

`stream()` 是异步生成器：运行时会把抛出的错误包装成终止性的 `error`/`aborted`
finish，但本适配器同时做内部捕获，以便附加稳定的失败码。

### 6.2 注册与生命周期

```ts
export const name = 'dsh-opencode-free'
export const inject = ['llm']
export function apply(ctx: Context, config: Config): void
```

三项注册，各自独立守卫，使较旧宿主缺少某可选 API 时降级而非抛错：

1. `ctx.llm.registerAdapter(providers, adapter)` → 返回清理器。
2. `ctx.llm.registerConfigurableProviders(...)` → 设置界面元数据
   （`displayName: 'OpenCode Free'`、`settingsNs: 'opencode-free'`）。
3. `ctx.llm.registerModelDiscovery('opencode-free', fn)` → 每个模型的
   `id`、`name`、`contextWindow`、`maxTokens`。

清理交给 Cordis 管理：

```ts
ctx.effect(() => () => { registration?.() })
```

目录的首次加载以即发即忘方式启动，因此插件激活永不阻塞在网络 I/O 上。

### 6.3 流块协议映射

发射顺序遵循 DSH 契约（usage 在 finish 之前，finish 在最后）：

```
block-start{index, blockType:'text'|'reasoning'}
  text-delta{index, text} | reasoning-delta{index, text}
block-end{index, block:{type:'text'|'reasoning', text}}

block-start{index, blockType:'tool-call'}
  tool-call-delta{index, id, name, argumentsDelta}
block-end{index, block:{type:'tool-call', id, name, arguments}}

usage{usage}
finish{reason}
```

细节：

- **交错。** `reasoning_content` 与 `content` 会交错到达。适配器只保持一个打开块；
  类型切换时关闭当前块并打开下一个，因此块索引严格单调，且不会有块被发射两次。
- **工具调用。** 增量按 `tool_calls[].index` 累积（id、name 以及拼接的参数片段），
  在文本流结束后按 index 排序、作为完整块发射。`tool-call-delta` 携带完整参数字符串，
  因为上游只发一次 id/name，其余都是片段。
- **结束原因。** 有工具调用则为 `tool-calls`；`finish_reason === 'length'` 时为
  `max-tokens`；否则 `stop`。中止呈现为 `aborted`；失败呈现为带稳定 `code` 的 `error`。

### 6.4 工具遮蔽与翻译

这是插件最微妙的部分：请求体必须包含 OpenCode 的工具，同时又必须让 DSH 的工具保持可调用。

`planTools(callerTools)` 产出四样东西：

```ts
{ tools, aliasToOriginal, decoys, callerNames }
```

算法：

1. 对每个调用方工具：
   - 不在 `FINGERPRINT_NAMES` 中 → 原样发送；
   - 在 `FINGERPRINT_NAMES` 中**且**完全规范 → 原样发送（它本身就充当指纹，
     不再追加同名诱饵）；
   - 在 `FINGERPRINT_NAMES` 中但定义不同 → **遮蔽**：以 `<name>_client`
     发送（若被占用则 `_client2`、`_client3`……）并记录别名。
     DSH 的 `read` 工具 schema 与 OpenCode 的不同，因此实践中 DSH 的 `read`
     总是以 `read_client` 传输。
2. 追加所有尚未满足的指纹名，标记为 `decoys`。

响应侧 `normalizeToolCall(call, plan)`：

- **别名 → 原名**：`read_client` 恢复为 `read`，
  于是 DSH 用自己的参数执行自己的工具，参数完全未被改动。
- **诱饵 → 调用方工具**：模型若调用了追加的 `read`/`shell` 等，
  会被改道到调用方的对应工具，并翻译参数：

  | 诱饵 | 调用方目标（优先级顺序） | 参数映射 |
  |---|---|---|
  | `read` | `read` | `path`→`file_path`、`offset`、`limit` |
  | `shell`、`bash` | `pwsh` → `bash` → `shell` | `command`、`description`（命令前 120 字符）、`workdir`、`timeout`→`timeoutMs` |
  | `glob` | `glob` | `pattern`、`path` |
  | `grep` | `grep` | `pattern`、`path`、`include` |

**安全属性：** 仅当 `plan.decoys` 包含该名字时才做翻译。
调用方自己声明的工具永远不会被重新映射——其参数本来就符合调用方的 schema。
这避免了静默篡改与指纹工具同名的调用方工具的参数。

**优先级说明：** shell 诱饵优先 `pwsh`，其次 `bash`，再次 `shell`。
DSH 桌面 profile 提供 `pwsh`（并禁用 `bash`），
因此 CLI 模型发出的 Linux 风格 `shell` 调用会落到 PowerShell 工具上。

**辅助调用：** 当 `options.purpose` 有值（`compaction`、`session-title`）时，
调用方工具被丢弃——`planTools([])`——只留 5 条指纹声明。
既满足闸门，又不向辅助调用提供工具。

若关闭 `config.toolTranslation`，`normalizeToolCall` 会被跳过：
此时诱饵调用会带着 OpenCode 的参数名（`path`、`command`）到达 DSH 并因 schema 校验失败。
这就是它默认为 `true` 的原因；该开关的存在是为了应对"未来闸门只需指纹即可"的情形。

### 6.5 消息投影

`buildChatMessages(options, plan)` 把 DSH 的消息模型映射为 OpenAI 对话消息：

| DSH | 线上 |
|---|---|
| `options.system` | 前置 `{role:'system'}` |
| `role:'system'` | `{role:'system'}`（仅文本） |
| `role:'developer'` | **丢弃** —— 工具的增删已投影进 `options.tools`，线上请求携带完整声明 |
| `role:'tool'` | `{role:'tool', tool_call_id, content}`；空内容变为 `'(no output)'` |
| `role:'assistant'` | `{role:'assistant', content: 文本|null, tool_calls: [...]}`；工具名经别名表重新遮蔽 |
| 用户内容 | 文本拼接；`image` → `[image omitted: the free-tier chat path is text-only]`；`file` → `[attached file]` |

由于该通路是纯文本的，图片与文件以显式占位符表示而非静默丢弃
——模型知道那里曾有内容，用户也能看出内容缺失的原因。

### 6.6 会话亲和

`sessionIdFor(options)` 把一个 DSH `sessionId` 映射为一个生成的 `ses_` id 并缓存，
使一段对话在多轮之间保持稳定的会话身份（因而 `prompt_cache_key` 也稳定）。
缓存上限 64 条，淘汰最早插入的键。没有会话 id 的请求每次都获得新 id。

### 6.7 用量口径

```ts
inputTokens  = prompt_tokens - cached_tokens        // 下限为 0
outputTokens = completion_tokens
cacheReadTokens = prompt_tokens_details.cached_tokens              // 非零时
reasoningTokens = completion_tokens_details.reasoning_tokens       // 非零时
```

这个减法很重要：DSH 把 `inputTokens` 计为**新增**输入，
因此缓存命中的 prompt token 单独上报，而不是重复计入。
`usage` 始终在 `finish` 之前发射。

### 6.8 错误分类

HTTP 失败转成带稳定 `code` 的 `LlmError`（`httpError()`）：

| 条件 | Code |
|---|---|
| HTTP 401 | `AUTH` |
| HTTP 403 且 `error.type == "FreeTierError"` | `FREE_TIER_GATE` |
| HTTP 429 | `RATE_LIMIT` |
| 其他 | `PROVIDER_HTTP_ERROR` |

同时提取：上游的 `error.message`（原样透出——它会说明配额重置时间）、
`retry-after` / `retry-after-ms`（作为 `providerRetryAfterMs`）、
以及 `x-opencode-log-id`（作为 `requestId`，便于向上游提工单）。

流级失败：

| 条件 | 结果 |
|---|---|
| `options.signal` 已中止 | `finish{kind:'aborted', failure:{code:'ABORTED'}}` |
| `DOMException.name === 'TimeoutError'` | code `TIMEOUT` |
| 其他抛出 | code `STREAM_FAILED` |
| 流中 `{"error":…}` 帧 | `LlmError`，code `PROVIDER_STREAM_ERROR` |

超时通过 `AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])`
实现，因此调用方取消与请求截止时间都生效，且调用方的 signal 永不被忽略。

---

## 7. 目录设计

`FreeModelCatalog` 从两个独立来源回答"现在有哪些免费模型"：

| 来源 | 提供 | 缓存 |
|---|---|---|
| `https://models.dev/api.json` → `.opencode.models` | 限额、模态、推理档位、按模型的 API base、弃用状态 | 内存中 10 分钟 |
| `GET {baseUrl}/models`（匿名） | 实时可用性 | 同一刷新周期 |

两个来源一起抓取，共用同一个 10 分钟内存缓存（`fetchedAt`）。
没有磁盘缓存：宿主重启会重新抓取。注册表自身上游的刷新节奏与本插件无关，
因为它只读取已发布的快照。

合并规则——模型被提供的条件是**同时**满足：

1. `cost.input === 0`（注册表中零成本），且
2. `status !== 'deprecated'`（除非开启 `includeDeprecated`），且
3. 出现在实时列表中（当该列表可达时）。

两个逃生通道：

- `config.extraModels` 中的 id 始终被强制加入。
- 实时存在且匹配 `/(-free$|^big-pickle$)/` 的未知 id 会被呈现，
  使注册表尚未跟上就已上线的模型仍可使用。

`list()` **永不抛出**。刷新失败时记录日志并继续提供缓存；
若缓存为空，则把时间戳回拨 5 分钟，避免一批调用者反复冲击故障端点。

字段映射：

```
limit.context            → contextWindow   → resolveModel().context.contextWindow
limit.output             → maxOutputTokens → resolveModel().defaultMaxTokens
modalities.input         → inputModalities
reasoning_options[type=effort].values → efforts → resolveModel().reasoning.efforts
provider.api             → api             → 按请求覆盖对话端点
```

---

## 8. 配置参考

经 Schemastery 校验；每一项都有可用默认值，因此插件开箱即用、无需配置、无需密钥。

| 配置项 | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `baseUrl` | string | `https://opencode.ai/inference/v1` | 目录与对话的 relay 基址。 |
| `apiKey` | string | `public` | 作为 `Bearer <key>` 发送；未登录哨兵值。 |
| `userAgent` | string | `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` | 必须包含足够新的 `opencode/<版本>`。 |
| `client` | string | `cli` | `x-opencode-client`。 |
| `project` | string | `global` | `x-opencode-project`。 |
| `providers` | string[] | `['opencode-free']` | 本适配器服务的 provider 路由。 |
| `includeDeprecated` | boolean | `false` | 是否提供已弃用但在线的模型。 |
| `extraModels` | string[] | `[]` | 强制追加模型 id。 |
| `requestTimeoutMs` | number | `600000` | 单请求截止时间。 |
| `toolFingerprint` | boolean | `true` | 是否发送 OpenCode 工具声明。 |
| `toolTranslation` | boolean | `true` | 是否把指纹工具调用翻译到 DSH 工具。 |
| `logLevel` | string | `info` | 写盘最低级别：`debug`\|`info`\|`warn`\|`error`\|`off`（`off` 关闭文件日志）。 |
| `logDir` | string | `''` | 日志目录；空 = `<DSH_PROFILE_DIR 或 ~/.dsh>/logs/dsh-opencode-free`（实测 Host 进程通常没有 `DSH_PROFILE_DIR`，因此多为 `~/.dsh/logs/dsh-opencode-free`）。 |
| `logMaxBytes` | number | `524288` | 单个日志文件大小上限（字节），超出即轮转。 |
| `logMaxFiles` | number | `5` | 保留文件总数（当前 + 轮转）；溢出时**最旧的先删**。 |

在 profile 中覆盖配置是**整行替换**（无深合并），
因此覆盖行必须重述它想保留的每一个键。

---

## 9. 兼容性

已针对以下框架版本验证：

| 包 | 版本 |
|---|---|
| `@deepseek-ai/dsh-llm` | `0.2.0-rc.2` |
| `@deepseek-ai/cordis` | `4.0.4` |
| `@deepseek-ai/schemastery` | `3.18.4` |

peer 依赖通过 `peerDependenciesMeta.optional = true` 声明，
使 bundle 能装入 profile 而不会提升出第二份框架副本。

本插件已经踩到过的 API 差异——框架升级时值得复查：

1. **`CallId` → `ToolCallId`。** 品牌类型改名；`ToolCallId(v)` 是构造函数。
2. **工具结果是消息，不是内容块。** 在 0.2.0-rc.2 中内容块联合为
   `text | image | reasoning | file | tool-call | tool-addition | tool-removal`；
   工具结果是一等的 `role: 'tool'` 消息（`ToolResultMessage`，含 `toolCallId`
   与 `isError`）。按旧的"块形态"模型编写的适配器无法编译。
3. **`GenerateOptions.system`** 供一次性调用者使用；
   而 loop 构造的请求把系统提示作为前置 system 角色消息携带。适配器两者都处理。

---

## 10. 运维手册

### 症状 → 原因 → 处置

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 重新出现 `403 FREE_TIER_GATE` | 闸门变了（UA 下限、id 方案、schema 比对） | 更新 `src/opencode-protocol.ts` 中的常量（见下），再重新构建与打包。 |
| `401 AUTH` | `Bearer public` 哨兵值改变 | 检查客户端的未登录路径；更新 `apiKey`。 |
| `429 RATE_LIMIT` | 按 IP 的免费层配额，或上游容量（`Upstream request failed: Endpoint is unavailable.`） | 等待重置；上游消息会说明。这不是插件缺陷。 |
| 模型未出现在选择器中 | 注册表/实时列表不匹配 | 把 id 加入 `extraModels`，或开启 `includeDeprecated: true`。 |
| 工具调用 schema 校验失败 | 关闭了 `toolTranslation`，或映射漂移 | 重新开启；对照当前 DSH 工具 schema 复查 `translations()`。 |

### 如何重新推导闸门

1. 直接探测端点，并与可用配方做差分——从 `tests/smoke.mjs` 开始，
   它覆盖了完整链路。
2. 阅读当前客户端源码：`packages/core/src/plugin/provider/opencode.ts`、
   `packages/core/src/session/model-request.ts`、
   `packages/ai/src/providers/opencode.ts`。
3. 一次只改一个变量（UA 版本 → id 方案 → 工具 schema）并记录状态码。
   4.6 节的探针矩阵就是模板。
4. 更新 `opencode-protocol.ts`，运行 `tests/wire-dump.mjs` 确认线上值，
   再用 `tests/smoke.mjs` 做一次真实补全。

---

## 11. 测试与验证

| 命令 | 作用 |
|---|---|
| `pnpm build` | `tsc -p tsconfig.json` → `lib/`（ESM + `.d.ts`）。 |
| `pnpm typecheck` | 同一编译器，`--noEmit`。 |
| `pnpm test` | `node --test tests/*.test.mjs` —— 密闭单测。目前覆盖日志模块 8 例（分级/脱敏/轮转/读取）。 |
| `node tests/wire-dump.mjs` | 打印 `attributionSuffix()`、`buildHeaders()`、`SESSION_ID_RE` 与规划出的工具名——不产生网络 I/O 即可确认线上指纹的最快方式。 |
| `node tests/smoke.mjs [模型id]` | 完整实时链路：id 正则 + 低 12 位不变量、工具规划/别名/翻译、实时目录、真实流式补全。 |

**当前状态：** `tests/logger.test.mjs` 是密闭单测；`tests/smoke.mjs` 与
`tests/wire-dump.mjs` 是实时探针。协议纯函数的密闭单测仍在路线图（第 13 章），
在补齐之前请把 smoke 探针当作线上验收测试——4.6 节的配方正是由它验证的。

端到端验收分两部分：

1. **线上层** —— `tests/smoke.mjs` 返回 `finish{kind:'stop'}`，
   文本非空，`ses_` id 合法。
2. **宿主层** —— 在运行中的 DSH profile 内，经 provider `opencode-free`
   路由的一次性模型调用返回预期答案，证明适配器已注册、被发现，
   且能通过 `LlmRuntime` 抵达。

---

## 12. 安全、隐私与归属

- **无凭据。** 插件不读取钥匙串、环境变量或配置密钥。
  它唯一能发送的 `Authorization` 是 `Bearer public`（或运维方显式设置的值）。
- **归属是被保留而非移除的。** DSH 契约要求每个 provider 请求都标识本 harness。
  插件满足该要求——产品名与项目 URL 都已公开——只剥离版本段，
  因为带版本的第三方产品令牌会被闸门拒绝。
  这是在两个约束下最小的偏离，也是代码中 `attributionHeaders()`
  被**导入并变换**而不是被绕过的原因。
- **无额外遥测。** 插件除请求本身外不发送任何东西：无埋点、无回传、
  不记录提示内容。`prompt_cache_key` 是去掉前缀的会话 id
  ——一个稳定的按会话缓存令牌，而非用户标识。
- **内容会离开本机。** 提示会发往 `opencode.ai`，受其条款与保留策略约束。
  用户不应发送不愿交给第三方 relay 的材料。
- **服务条款。** 本插件有意把自己呈现为官方客户端，以使用一个被限定给该客户端的层级。
  这既是项目的全部意义，也是它最大的注意事项：它面向个人实验用途，
  受上游限流约束，且与 OpenCode、DeepSeek 均无关联。
  需要受支持路径的运维方应改用付费 console API。
- **上游可见性。** 闸门在服务端，随时可能改变或以不同方式执行；
  插件自身的诊断（`FREE_TIER_GATE`、原样透出的上游消息）正是为了让失败自解释
  而非神秘难解。

---

## 13. 已知缺口与路线图

1. **协议层密闭单测仍缺。** `tests/logger.test.mjs` 覆盖了日志模块
   （分级/脱敏/轮转/读取，8 例全过），但协议纯函数还没有对应单测：
   - id 编码：正则形态、`ffe` 低 12 位不变量、计数器封顶、升序 vs 降序
   - `planTools`：原样透传、规范匹配（不追加诱饵）、遮蔽、
     别名冲突（`_client2`）、诱饵集合内容
   - `normalizeToolCall`：别名恢复、各诱饵翻译、
     "已声明工具永不被重映射"这一安全属性、畸形 JSON
   - `buildHeaders`：精确请求头集合与剥离版本后的 UA
   - `buildChatMessages`：assistant 工具调用重新遮蔽、`role:'tool'` 映射、
     图片/文件占位、developer 消息丢弃
2. **纯文本内容通路。** 图片与文件是占位符。部分免费模型在注册表中声明
   `image` 输入；当 relay 提供多模态对话时，`buildChatMessages`
   应发出真实内容分片。注册表已发布 `inputModalities`，适配器可按模型决策。
3. **响应侧推理内容。** 目前只识别 `reasoning_content`。
   其他提供方的写法（`reasoning`、`thinking`）未解析。
4. **重试/退避已委托出去。** 适配器透出 `providerRetryAfterMs`，
   但自身不实现重试，依赖 `dsh-llm-retry`。
5. **单一层级默认。** 只提供零成本模型；没有切换到付费 console 模型的开关。
6. **会话缓存是进程内的。** 宿主重启后，既有对话会获得新的 `ses_` id，
   因此跨重启会失去上游 prompt 缓存亲和。

---

## 14. 变更记录

每次功能增删或技术原理修改都必须在此追加一行（见第 0 章规约）。

| 日期 | 版本 | 变更 | 影响章节 |
|---|---|---|---|
| 2026-10-18 | 0.2.1 | **发布准备**：npm 包名定为 `dsh-opencode-bridge`（无 scope 的 `dsh-opencode-free` 已被他人占用；scoped 名辨识度不足，改为桥接寓意的独立名字）；`client.js` 模块 id 与 `cordis.patch.yml` 的 `name` 同步包名（行 `id` 不变）；新增 LICENSE、`.gitignore`、`prepack` 构建钩子；插件介绍移除设置日志查看器的宣传文案。 | 3、14、附录 A |
| 2026-10-18 | 0.2.1 | **修复 DSH Desktop 启动崩溃**：`client.js` 的 `apply()` 抛未捕获异常 → web-boot 模块激活失败 → 桌面壳判为致命错误退出。加固：`apply()` 永不抛错（每步独立 try/catch）、全部服务可选链访问、locale 先注册后绑定、移除 `immediately: true`（避免在设置插槽声明前强制激活）；新增敌对 ctx 回归测试 8 例。 | 3、15.6 |
| 2026-10-18 | 0.2.0 | 新增分级日志（脱敏 + 按大小轮转自动清理最旧）、DSH 设置界面日志查看/复制 UI、`opencode_free_log` agent 工具；建立文档维护规约。 | 0、3、8、11、13、14、15 |
| 2026-10-17 | 0.1.0 | 首版：三层闸门复刻、`OpenCodeFreeAdapter`、免费模型目录、工具遮蔽/翻译。 | 1–13 |

---

## 15. 日志与诊断

目标：**debug 可观测、零敏感信息、磁盘占用有界**。三者按此优先级取舍——
日志再有用，也不允许包含凭据或用户消息内容。

### 15.1 分级与输出

`src/logger.ts` 的 `PluginLogger` 提供 `debug / info / warn / error` 四级
（配置 `logLevel` 设定写盘下限，`off` 关闭文件输出）。每行格式：

```
2026-10-18T02:17:05.003Z [INFO ] [adapter] completed {"model":"glm-5.3-flash-free",...}
```

时间戳（ISO）+ 级别 + scope + 消息 + 可选 JSON 数据。scope 取值：
`plugin`（入口/注册）、`adapter`（每次模型调用）、`catalog`（模型目录）、
`log-service`（日志自身操作）。

调用点约定：**只记元数据**——模型名、消息数、工具数、token 用量、状态码、
耗时、会话/请求 id。绝不记录消息内容、工具参数、完整请求体。

### 15.2 脱敏（防泄漏三道闸）

即使调用点失误，以下兜底也会拦截敏感材料（`PluginLogger.redact()`）：

1. **字面秘密**：构造时注入的 `secrets`（当前为 `config.apiKey`）逐字替换为
   `[redacted]`；
2. **令牌形态**：`Bearer <token>`、`sk-…`/`key-…`/`token-…`/`secret-…` 形状的
   长字面量替换为 `[redacted]`；
3. **截断**：单个字符串超 2000 字符截断并标记 `…[truncated]`。

数据字段（`data` 参数）的每个值同样过 `redact()`。这套规则有单测覆盖
（`tests/logger.test.mjs` "redaction" 两例）。

### 15.3 轮转与自动清理

单个日志文件达到 `logMaxBytes`（默认 512 KiB）即轮转：`dsh-opencode-free.log`
→ `.1` → `.2` …，**溢出时先删除最旧的**，总文件数恒 ≤ `logMaxFiles`（默认 5），
磁盘占用上界为 `logMaxBytes × logMaxFiles`。启动时清理超出保留数的历史文件。
写盘失败不抛错（降级到 200 行内存环，`read()` 仍可服务）。

### 15.4 一套实现，两个调用方

`src/log-service.ts` 的 `LogService` 是唯一的读/清/改级操作实现：

- **设置界面 UI**（`client.js`）：注册进 `settings.section` 插槽
  （设置页 "OpenCode Free"），提供级别过滤、刷新、**复制全部**（Clipboard API
  带 `execCommand` 兜底）、清空（带确认）。数据经包私有 JSON RPC
  `/api/opencode-free-logs/{read,stat,clear,level}` 获取——与已验证的
  `connection.fetch.register` / `connection.rpc.call` 通道同款（见
  `dsh-tool-antigravity` 的实现）。
- **agent 工具 `opencode_free_log`**：`action: read|stat|clear|level`，
  走同一 `LogService`。模型可自行拉取诊断日志；日志已被脱敏，可安全回传上下文。

UI 是纯浏览/复制操作（不改配置），因此未给 agent 暴露"改配置"路径——
`level` 只改运行时级别，重启后由配置恢复。

### 15.5 显示资源

`locale/{en,zh}.json` 提供插件标题与描述，`icon.svg` 为原创图标
（两节点 + 桥弧 + 星芒，寓意"协议桥"）。`package.json` 的 `exports`/`files`
包含 `client.js`、`locale/*.json`、`icon.svg`；`dsh.client` 声明
`platform: web` 及 4 个客户端依赖包。**注意：`dsh.client` 不设
`immediately: true`**——它会让模块在 web-boot 早期强制激活，此时
`settings.section` 插槽可能尚未声明（见 15.6）。

### 15.6 客户端模块健壮性规则（0.2.1 崩溃修复）

**事故**：0.2.0 安装后 DSH Desktop 启动即崩溃。崩溃日志
（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`）显示
`web boot: 1 entry did not activate / dsh-opencode-free: failed`——
**桌面壳把客户端模块激活失败视为致命错误**，`apply()` 抛出的任何未捕获
异常都会杀死整个应用（10-15 的 `dsh-session-mover` 是同款死法）。

**根因**（两个叠加）：

1. `locale.bind(NS)` 在 `locale.register(NS, …)` 之前调用——对未注册的
   命名空间，`bind` 可能抛异常；
2. `ctx.slots.inject('settings.section', …)` 无保护直调——`immediately: true`
   使模块在设置插槽声明前激活，服务属性访问/调用直接抛 TypeError。

**防御规则**（修改 `client.js` 时必须遵守，`tests/client-boot.test.mjs` 强制）：

1. **`apply()` 永不抛错**——每一步（locale / rpc / slots 注册）各自
   try/catch，失败只 `console.error`，绝不向上传播；
2. **所有服务访问用可选链 + 兜底**——`ctx.slots`、`ctx.locale`、
   `ctx.get('connection')` 都可能缺失或时序未到；界面在 rpc 缺失时显示
   "日志服务不可用" 而不是崩溃；
3. **locale 先注册后绑定**；注册失败时回退到内置 zh/en 词典翻译器；
4. **不设 `immediately: true`**——按需激活可避免与宿主插槽声明的时序竞争；
5. 组件自身对 props 与静态属性双重取值（`props.t || LogPanel.t || fallback`）。

回归测试模拟敌对 ctx（服务全部缺失、`bind`/`register`/`inject`/`get` 各自
抛异常），断言 `apply()` 不抛且设置页仍尽量注册。**改动 client.js 后必跑**：
`node --test tests/client-boot.test.mjs`。

---

## 附录 A —— 仓库清单

```
package.json              清单；dsh.bundle.patch → cordis.patch.yml；dsh.client → client.js
tsconfig.json             ES2022 / Node16 / strict，src → lib
cordis.patch.yml          bundle 层补丁（插入插件行）
.npmrc                    auto-install-peers=false
src/index.ts              插件入口（Config、apply、注册、日志装配）
src/opencode-protocol.ts  闸门常量、id、请求头、工具、消息
src/adapter.ts            LlmAdapter 实现
src/catalog.ts            免费模型目录
src/logger.ts             分级日志（脱敏、轮转、内存兜底）
src/log-service.ts        LogService + RPC 路由 + agent 工具
client.js                 设置界面日志查看/复制面板（浏览器端模块）
locale/en.json, zh.json   插件标题/描述（显示清单）
icon.svg                  原创插件图标
lib/                      tsc 产物（发布内容）
tests/logger.test.mjs     日志模块密闭单测
tests/smoke.mjs           实时端到端探针
tests/wire-dump.mjs       离线线上指纹转储
research/                 逆向工程资料（不发布）
README.md / README.zh.md  用户文档
TECHNICAL.md / .zh.md     本文档
```

构建产物为带声明的 ESM；`package.json` 的 `main`/`types` 指向
`lib/index.js` / `lib/index.d.ts`，`files` 把 tarball 限制为 `lib/`、
`client.js`、补丁、locale、图标与文档。注意 `client.js` **不是** tsc 产物，
它是手写的浏览器端 `__ModuleLoader__` 模块，直接随包发布。

## 附录 B —— 实测免费模型（2026-10 快照）

```
beam-free                        mimo-v2.6-flash-free
big-pickle                       nemotron-3.5-lightning-free
deepseek-v4.1-flash-free         nemotron-3.5-super-vl-free
glm-5.3-flash-free               space-bunny-free
jev-1.13-free                    longcat-2.5-preview-free
```

该集合是易变的：2026-10 早些时候的探针见到 13 个 id，稍后为 10 个
（`ll-alpha-free`、`muse-spark-1.2-contributor-free`、
`muse-spark-1.3-contributor-free` 已消失）。不要硬编码该列表——始终向目录查询。

relay 列出的非 `-free` id（例如裸的 `test` 条目）会被第 7 章的未知 id
模式过滤掉，除非通过 `extraModels` 显式配置。

实时探针还证实了按模型的端点覆盖（第 4.5 节）：
`glm-5.3-flash-free` 的注册表条目把其对话路径解析为
`/inference/openai/v1/chat/completions`，而非配置的默认值。

## 附录 C —— 术语表

| 术语 | 含义 |
|---|---|
| **relay** | 位于免费与付费模型之前的 opencode.ai 推理代理。 |
| **免费层（free tier）** | 无密钥模型集合，被限定给官方客户端。 |
| **指纹（fingerprint）** | 闸门会考察的客户端识别特征集合（UA、id 编码、工具声明、请求体标志）。 |
| **诱饵（decoy）** | 追加进请求、但调用方并未要求的指纹工具声明。 |
| **遮蔽（cloaking）** | 以别名（`read_client`）发送调用方工具，以避开与指纹名冲突。 |
| **翻译（translation）** | 把诱饵工具调用改写为调用方工具，含参数名。 |
| **StreamChunk** | 适配器发出的 DSH 原始流式协议词汇。 |
| **档位（effort）** | 注册表发布的具名推理级别，按模型选择。 |
