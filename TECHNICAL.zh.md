# dsh-opencode-bridge — 技术设计文档

[English](TECHNICAL.md) | 中文

`dsh-opencode-bridge` 插件的工程文档：免费层闸门如何被逆向、线上协议如何被复刻、
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
4. 改变构建/打包/安装方式或 DSH 依赖版本；
5. **升级版本号**——必须同时把两份 README 的安装命令
   （`dsh plugin ... add dsh-opencode-bridge@<版本>`）与本地 tarball 示例
   （`./dsh-opencode-bridge-<版本>.tgz`）改成新的 `package.json` 版本。
   两处版本必须与 `package.json` 的 `version` 完全一致；
   `tests/readme-version.test.mjs` 会校验，不要绕过它。

**按读者分层。** 两份 README 面向项目访问者，保留简短简介、用户能理解的功能、
可直接复制的安装/首次使用步骤、可选代理配置、必要限制与隐私风险、常见问题，
以及简短的开发入口。协议指纹、完整配置、schema/流处理原理、测试证据、
历史验证与维护流程放在技术文档中，不在项目首页重复展开；需要细节时提供链接。
不要让普通用户通过修改源码里的协议常量来进行常规排障。中英文结构与含义保持一致，
折叠的源码开发区同样遵守安装版本与包版本同步的规则。

变更时同步维护第 14 章"变更记录"——先记后改，一行一变更。
**不要留"代码已改、文档未改"的提交。**

### AI 接手指引（先读这里）

你是接手本仓库的 AI？按此顺序建立上下文，不要一上来就改代码：

1. **读完本节与第 1、2 章**——知道插件做什么、挂在 DSH 哪里。
2. **读第 3 章模块地图**——`opencode-protocol.ts` 管闸门常量与规划，
   `tool-bridge.ts` 管保守映射/校验，`bridge-audit.ts` 管作用域审计；
   adapter/catalog/logger 仍各司其职。
3. **动手前读第 4 章（闸门）与第 5 章（线上协议）**——这是本插件的核心风险区：
   改错任何一个常量都会让所有请求吃 403。
4. **改动后必跑**：`node node_modules/typescript/bin/tsc -p tsconfig.json`（编译）、
   `node --test tests/*.test.mjs`（单测）；仅当联网/额度使用明确适宜时运行
   `node tests/smoke.mjs`（实时探针，429/403 含义见第 10 章）。
   明确说明跳过的验证，不把离线测试当线上验收。
5. **收尾前对照本节顶部的维护规约**，更新本文档与变更记录。
6. 日志/诊断相关的问题先看第 15 章；设置界面 UI 在 `client.js`（非 TypeScript，
   是浏览器端 `__ModuleLoader__` 模块，见第 15.3 节）。
7. **改 `client.js` 前必读 15.6**：激活异常可能破坏客户端启动；回归单测
   不能证明 Desktop 崩溃已恢复。改后运行 `node --test tests/client-boot.test.mjs`，
   并报告实际客户端验证的范围。

---

## 1. 范围与定位

| | |
|---|---|
| **目标** | 让无密钥的 OpenCode 免费模型成为 DSH 中的一等模型。 |
| **非目标** | OpenCode 付费模型（需 Console 账号与签发的 key）。 |
| **手段** | 一个 `LlmAdapter`，对 opencode.ai relay 说官方客户端的线上协议。 |
| **凭据** | 无。relay 接受未登录哨兵值 `Bearer public`。 |
| **分发** | npm bundle + `cordis.patch.yml` 层补丁。 |

插件是进程内适配器，不创建本地代理服务器；可将 relay 请求经用户配置的
HTTP(S) CONNECT 或 SOCKS 代理发出（见6.9）。

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

主要的 DSH LLM 适配/发现接缝为：

1. **`ctx.llm.registerAdapter(providers, adapter)`** —— 提供 provider 路由
   （`opencode-bridge`）与流式实现。
2. **`ctx.llm.registerModelDiscovery(id, fn)`** —— 提供 GUI 的模型列表。

它不修改 agent loop、不执行工具。可选工具注册新增 `opencode_bridge_audit`
（仅当前 agent schema）及既有日志工具。适配器会变换请求/响应工具声明，
但不 patch 全局 HTTP 入口。

---

## 3. 模块地图

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/index.ts` | — | Cordis 插件入口：`name`、`inject`、Schemastery `Config`、`apply()`、注册、清理器。 |
| `src/opencode-protocol.ts` | — | **全部闸门敏感常量。** ID 生成、请求头配方、逐字指纹工具、工具遮蔽/翻译、消息投影。 |
| [src/adapter.ts](src/adapter.ts) | — | 模型元数据、SSE/工具校验、有界宿主重试策略、按模型保留等待与安全诊断。 |
| [src/http-errors.ts](src/http-errors.ts) | — | 保留 HTTP 状态的错误转换与合法诊断字段。 |
| [src/retry-after.ts](src/retry-after.ts) | — | 共用时长/HTTP-date 解析、向上取整与安全溢出处理。 |
| [tests/http-errors.test.mjs](tests/http-errors.test.mjs) | — | headers/body/错误转换、时钟偏差与凭据过滤回归。 |
| [tests/retry-integration.test.mjs](tests/retry-integration.test.mjs) | — | 严格池/模型等待、防重放、探测/并发/日志与明确标注的宿主策略模拟器。 |
| [src/tool-bridge.ts](src/tool-bridge.ts) | — | 纯函数保守映射/schema 子集；拒绝可执行诱饵，不做 I/O/执行。 |
| [src/bridge-audit.ts](src/bridge-audit.ts) | — | 当前 agent 注册表作用域审计，最小元数据输出、不联网不执行。 |
| [src/proxy-pool.ts](src/proxy-pool.ts) | — | 顺序出口/冷却、代理 store、pooled fetch 与 HTTP/SOCKS dispatcher 缓存。 |
| [src/socks-dispatcher.ts](src/socks-dispatcher.ts) | — | SOCKS4/4a/5/5h 隧道、DNS 模式、认证、TLS 校验与连接清理。 |
| [tests/socks-network.test.mjs](tests/socks-network.test.mjs) | — | 真实 loopback SOCKS/TLS、认证、轮换与 socket 生命周期测试。 |
| [tests/socks-config.test.mjs](tests/socks-config.test.mjs) | — | SOCKS URL、凭据边界、存储及禁止静默直连回归。 |
| [.github/workflows/release.yml](.github/workflows/release.yml) | — | tag 触发、构建与最小权限 Release 发布。 |
| [scripts/release-check.mjs](scripts/release-check.mjs) / [校验和脚本](scripts/release-checksum.mjs) | — | 版本、归档资源与 SHA256SUMS 校验；测试见 release-check.test.mjs。 |
| [tests/github-config.test.mjs](tests/github-config.test.mjs) | — | Issue Forms、工作流权限/触发器与 YAML/锁配置检查。 |
| [src/proxy-service.ts](src/proxy-service.ts) | — | 实时编辑/持久化、凭据脱敏health、relay GET探测与包私有RPC。 |
| [tests/proxy-pool.test.mjs](tests/proxy-pool.test.mjs) | — | 规范化、顺序健康复用、冷却、脱敏、BOM/store与传输测试。 |
| [tests/proxy-rotation.test.mjs](tests/proxy-rotation.test.mjs) | — | 适配器429/连接改道、池耗尽与流中途不重播。 |
| [tests/proxy-live.mjs](tests/proxy-live.mjs) | — | 按需真实CONNECT/直连relay探测与固定标记合成补全。 |
| [tests/readme-version.test.mjs](tests/readme-version.test.mjs) | — | 守卫：两份 README 的安装命令/tarball 版本必须等于 `package.json`。 |
| [tests/tool-bridge.test.mjs](tests/tool-bridge.test.mjs) | — | 规划/碰撞、开关、schema 子集、原生/诱饵拒绝回归。 |
| [tests/bridge-integration.test.mjs](tests/bridge-integration.test.mjs) | — | 审计执行作用域与 mock SSE 整批/结束/错误回归。 |
| [tests/bridge-cancellation.test.mjs](tests/bridge-cancellation.test.mjs) | — | POST 前、缓存调用及逐块取消回归。 |
| [docs/COMPARISON.zh.md](docs/COMPARISON.zh.md) | — | 六仓库固定 HEAD 源码比较及差异化边界。 |
| [docs/research-notes/](docs/research-notes/README.md) | — | 可公开的调研笔记（自研分析），仓库不含第三方源码。 |
| [src/catalog.ts](src/catalog.ts) | — | `FreeModelCatalog`：原子快照、定时刷新、请求合并、取消、旧缓存降级与免费筛选。 |
| [tests/catalog-refresh.test.mjs](tests/catalog-refresh.test.mjs) | — | 假时钟/来源夹具覆盖调度、故障、空快照、并发与筛选。 |
| [tests/catalog-lifecycle.test.mjs](tests/catalog-lifecycle.test.mjs) | — | 插件 effect、模型发现、同适配器路由更新与卸载清理。 |
| `src/logger.ts` | 326 | `PluginLogger`：分级、脱敏、按大小轮转（最旧优先清理）、内存兜底。见第 15 章。 |
| `src/log-service.ts` | 245 | `LogService` + RPC 路由 + `opencode_bridge_log` agent 工具（一套实现两个调用方）。 |
| [client.js](client.js) | — | 单个 OpenCode Bridge 设置页（order30），页内日志与代理轮换标签；浏览器模块非 tsc 产物。见6.9、15.4、15.6。 |
| `cordis.patch.yml` | 4 | 把插件行插入配置层的 bundle 补丁。 |
| `tests/logger.test.mjs` | — | 日志模块密闭单测（分级/脱敏/轮转/读取）。 |
| `tests/client-boot.test.mjs` | — | 客户端模块激活回归测试（apply 永不抛错，敌对 ctx 8 例）。 |
| `tests/smoke.mjs` | — | 实时端到端探针（ID → 工具规划 → 目录 → 流式完成）。 |
| `tests/wire-dump.mjs` | — | 打印当前构建实际发出的请求头与指纹。 |

**设计不变量：** 上游闸门可能考察的每个常量都只存在于
`opencode-protocol.ts`。其余部分不重复硬编码指纹常量；规划改变时仍需同步
复查 bridge、adapter、audit 与测试。新增上游声明绝不自动授予执行能力。

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
| `providerInfo(provider)` | GUI 显示名 `OpenCode Bridge`。 |
| `listModels(provider)` | 目录驱动的模型选择器。 |
| `resolveModel(provider, model, signal)` | 发布 `context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts`。 |
| `prepareCall(provider, model, signal)` | 把元数据与流入口绑定到同一代实现。 |

`stream()` 是异步生成器：运行时会把抛出的错误包装成终止性的 `error`/`aborted`
finish，但本适配器同时做内部捕获，以便附加稳定的失败码。

### 6.2 注册与生命周期

```ts
export const name = 'dsh-opencode-bridge'
export const inject = ['llm']
export function apply(ctx: Context, config: Config): void
```

三项注册，各自独立守卫，使较旧宿主缺少某可选 API 时降级而非抛错：

1. `ctx.llm.registerAdapter(providers, adapter)` → 返回清理器。
2. `ctx.llm.registerConfigurableProviders(...)` → 设置界面元数据
   （`displayName: 'OpenCode Bridge'`、`settingsNs: 'opencode-bridge'`）。
3. `ctx.llm.registerModelDiscovery('opencode-bridge', fn)` → 每个模型的
   `id`、`name`、`contextWindow`、`maxTokens`。

清理交给 Cordis 管理：

```ts
ctx.effect(() => () => { registration?.() })
```

通过 `ctx.effect(() => catalog.start())` 持有启动预取与定时器，插件激活不等待网络。
内容变化时使用现有注册的公开原子 `replace(providers)`，相同快照不通知。
卸载会取消元数据请求与定时器，并清理注册及代理资源；并发与 Client 缓存语义见第 7 章。

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
- **工具调用。** 名字/参数按 `tool_calls[].index` 缓冲，不把片段流式交给执行端。
  直至 `finish_reason:'tool_calls'`，全部调用通过桥接检查后才按 index 发出任何工具块，
  此时 `tool-call-delta` 携带每条完整参数字符串。
- **结束原因。** 整批通过并发出后为 `tool-calls`。存在工具调用但没有
  `finish_reason:'tool_calls'`（EOF/length/stop）则为 `TOOL_BRIDGE_INCOMPLETE`，不能当可用批次。
  无调用时 length 为 `max-tokens`，否则 `stop`；中止为 `aborted`，失败为 `error`。
  拒绝工具不会回滚此前流出的文本/思考。

### 6.4 安全工具桥与无碰撞规划（0.3.0）

`planTools(callerTools, { fingerprint })` 返回：

```ts
{ tools, aliasToOriginal, decoys, callerNames, callerTools }
```

分配前先**预留全部调用方名字**，包括输入中较晚出现的名字，避免把原有
`read_client` 当成另一个工具的别名。重复调用方名字会被拒绝。指纹开启时，
非规范冲突使用 `<name>_client`、`_client2`……；完全规范的调用方定义仍是原生工具，
只有缺少的指纹名才被注入并标为诱饵。`toolFingerprint:false` 原样保留调用方工具，
不新增别名或诱饵，修正了旧开关路径丢弃调用方工具却仍注入声明的问题。

真实请求按 `GenerateOptions.tools` 规划；有 `options.purpose` 的辅助调用使用空调用方集合，
绝不从全局注册表扩权。指纹开启时仍可含准入声明，但没有当前调用方目标就不能执行；
关闭时辅助集合保持为空。

`normalizeToolCall` 始终执行，包括 `toolTranslation:false`：

| 返回名字 | 策略 |
|---|---|
| 调用方别名 | 恢复原名；要求参数为 JSON 对象，保留原始参数字节。 |
| 调用方原名（含规范 `bash`/`shell`） | 要求参数为 JSON 对象；其余交 DSH 自身 schema/权限检查。 |
| 注入 `bash`/`shell` | 拒绝 `EXECUTABLE_DECOY`，不猜测 Bash→PowerShell 或其它运行时转换。 |
| 注入 `read` | 仅当前调用方 `read`；`path`→`file_path`，可带 `offset`/`limit`。 |
| 注入 `glob` / `grep` | 仅同名调用方目标；映射 `pattern`/`path`，grep 可带 `include`。 |
| 未知名字 | 拒绝 `UNKNOWN_TOOL`。 |

只读/搜索映射要求目标是已知对象 schema、必填字段兼容。源参数必须是仅含已知键的对象，
路径/模式为字符串，offset/limit 为非负安全整数；映射值必须满足目标的**保守 JSON Schema 子集**。
支持类型、properties/required/additionalProperties、items、enum/const、oneOf/anyOf 及代码列出的
数值/字符串/容器边界。`$ref`、`pattern`、`format`、`allOf` 等未知约束拒绝而非静默丢失。
这不是完整 JSON Schema 校验器；调用方原生工具在此只检查 JSON 对象，完整 schema 与权限仍由 DSH 负责。

`toolTranslation:false` 对只读/搜索诱饵返回 `TRANSLATION_DISABLED`，可执行诱饵仍拒绝，
但**仍恢复调用方别名**。请求指导模型优先选调用方别名及 `pwsh` 等原生命令线上名字，
不要选注入 shell 声明。

适配器缓冲整批 toolcalls，直至 `finish_reason:tool_calls`，先规范化所有调用，再发送**任何**工具块。
一条桥接检查不通过，该响应整批工具块都不放行；有工具片段却以 EOF、`length` 或 `stop` 结束，
返回 `TOOL_BRIDGE_INCOMPLETE`。已经流出的文本/思考不会回滚。这是桥接层原子放行，
不是执行事务或副作用回滚；DSH 后续仍可能独立拒绝原生工具的 schema/权限约束。

全部执行仍在 DSH，插件不新增 exec/spawn 或全局 HTTP 补丁。
“只读”指 read/search 桥接路线，不保证任意调用方同名实现没有副作用。

请求 POST 前、流缓存后与每个工具块前均检查取消，取消后不得释放缓存工具调用。

### 6.4.1 离线当前 agent 作用域审计

`opencode_bridge_audit` 接受 `{}` 或 `{ "limit": 12 }`；limit 为 1–200 整数，默认 80。
它只调用 `tools.schemas(exec.agent)`；缺少 agent 返回 `AGENT_SCOPE_REQUIRED`，
绝不使用 `schemas(undefined)` 退回全局。结果含名字、别名、路线决定/原因及计数/截断元数据，
不含描述、default、工具入参或聊天；不联网、不执行工具。

报告 basis 为 `current-agent-scoped-native-registry`。Code Mode/PTC 和辅助调用的工具集可能不同，
真实请求始终按 `GenerateOptions.tools` 重新规划。审计不是会话调用历史、HTTP/模型健康测试、
完整 schema 证书或权限授权。取消、非法 limit、注册表不可用均返回固定 status/code，
不透出服务错误正文。替代实现与差异化声明的边界见[源码比较](docs/COMPARISON.zh.md)。

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

[http-errors.ts](src/http-errors.ts) 保留真实 HTTP 状态；“Endpoint is unavailable”
或响应体中的嵌套 code 不会把 429 改写为 503。
HTTP 错误文字去控制字符、限制为1000字符，仅用于界面错误上下文，**不复制到持久诊断日志**。
`UpstreamHttpError.diagnostics` 仅含状态、固定 reason 类别、合法上游类型/请求 ID 及正等待值；
请求 ID 可缺省，须通过长度/字符校验并排除凭据形态，绝不传 null；类型标识也受约束。
原始正文、headers、消息和工具参数都不作为诊断字段。

`endpoint_unavailable` 只表示匹配到已知固定文案，不推断根因。
推理请求仅明确的 `FreeUsageLimitError`（且无该不可用文案）可进入出口改道；
未知429、普通请求限流、模型/后端不可用均按请求作用域处理。
HTTP503仍为 `PROVIDER_HTTP_ERROR`，不换代理。
本地预检拒绝使用 `EGRESS_COOLING` 或 `REQUEST_COOLING` 并携带剩余等待，
**不为尚未发送的请求伪造 HTTP 状态**。输出前的传输耗尽仍为 TIMEOUT 或 STREAM_FAILED。

流级失败：

| 条件 | 结果 |
|---|---|
| `options.signal` 已中止 | `finish{kind:'aborted', failure:{code:'ABORTED'}}` |
| `DOMException.name === 'TimeoutError'` | code `TIMEOUT` |
| 桥接检查拒绝 | `TOOL_BRIDGE_REJECTED`，仅固定原因，不含入参 |
| 工具片段未以 `tool_calls` 完成 | `TOOL_BRIDGE_INCOMPLETE`，不发工具块 |
| 其他抛出 | code `STREAM_FAILED` |
| 流中 `{"error":…}` 帧 | 输出前为 `LlmError`，code `PROVIDER_STREAM_ERROR` |
| 已开始输出文本/推理/工具后的非策略失败 | `PARTIAL_STREAM_ERROR`，日志保留 originalCode，不自动重放 |

桥接原因码为 `UNKNOWN_TOOL`、`TRANSLATION_DISABLED`、`EXECUTABLE_DECOY`、
`NO_CALLER_TARGET`、`UNSUPPORTED_TARGET_SCHEMA`、`INVALID_ARGUMENTS`。
错误正文固定为 `Tool bridge rejected call: <reason>`，不拼入名字、schema 值或入参。
原生调用的畸形/非对象 JSON 同样为 `INVALID_ARGUMENTS`，合法原生 JSON 不重新序列化。

超时通过 `AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])`
实现，因此调用方取消与请求截止时间都生效，且调用方的 signal 永不被忽略。

### 6.8.1 单一且有界的重试执行者

适配器通过 DSH SDK 的公开 `resolveRetryPolicy(...)` 返回 normal 策略：
首次调用后**最多重试2次**，仅对 RATE_LIMIT、EGRESS_COOLING、REQUEST_COOLING 生效；
无提示时本地指数退避初始2000毫秒、±20%抖动，最大接受/调度等待120000毫秒。
自动重试依赖宿主标准重试插件，未启用时直接交回失败；本插件不会补一层自己的请求重试计时器或循环。
安装版 DSH 会原样等待有效 provider 提示，不抖动；normal 模式对超过上限的提示停止自动重试，
不是截短后提前发请求。没有提示才使用本地退避。

适配器还按模型在内存中保留正服务端等待，立即手动再调用也不得提前发送；
并发200不会清除该期限。Map最多256个模型键，溢出时保守添加全局等待下限，而非遗忘活动阻塞。
超大提示安全饱和，本插件不把超32位的大数直接交给 Node 定时器；状态仅在当前进程内。

DSH 通用重试执行器本身不检查是否已有输出，因此适配器在输出后失败时使用 PARTIAL_STREAM_ERROR
（本来就不可重试的工具策略/未完整结束代码保留），保留已输出文字并结束对应文本块。
取消仍为 ABORTED；这些代码不在本适配器的重试名单里。
用户手动重新提交、其他自定义恢复插件不属于这项策略；也不保证超时请求从未被上游计算。

### 6.9 出口代理池（0.4.0）

[ProxyPool](src/proxy-pool.ts) 负责顺序选择、逐出口冷却与存储辅助，
[ProxyService](src/proxy-service.ts) 负责编辑和探测。推理 POST 与 relay
`GET /models` 共用池，models.dev 公共元数据仍直连；插件不创建本地代理服务器。
HTTP(S) 代理惰性加载 `undici.ProxyAgent`；SOCKS 代理由
[src/socks-dispatcher.ts](src/socks-dispatcher.ts) 使用 `socks.SocksClient` 建立隧道，
再交给独立的 `undici.Agent`。每个规范化 URL 缓存一次初始化 Promise，
并发请求复用同一个 agent；插件卸载时销毁缓存连接与未完成的 SOCKS 协商。
不 patch 全局 fetch/dispatcher，也不新增全局 HTTP 钩子。

**条目与选择。** `proxies:[]` 默认直连；空串、`direct`、`none` 表示本机出口。
HTTP(S)、SOCKS4/4a、SOCKS5/5h URL 或裸 `host:port` 规范化、去重并保序；
裸地址按 HTTP 解释，SOCKS 未填端口时默认 1080，`socks://` 规范化为 `socks5h://`。
其它协议、有路径/查询/片段的代理 URL、非法凭据明确拒绝，原因不回显原始密码。
每次请求选配置中首个就绪出口，**不是 round-robin**；健康出口持续复用，利于额度/缓存亲和。
这不是逐会话绑定，靠前出口冷却结束会重新优先；不同代理也可能共享公网 IP。
显式仅代理列表不偷偷添加 direct，但池为空/删除最后条目时恢复直连；向仅直连池添加会保留直连。

| 事件 | 状态/动作 |
|---|---|
| 明确推理出口配额错误且没有等待提示 | 冷却该出口，流开始前尝试另一个就绪且本轮未尝试的出口。 |
| 有效服务端等待 | 结束本次池操作，不立即换代理；原始状态/提示交给宿主有界重试策略。 |
| 后端不可用或未知推理429 | 请求作用域，不将代理标为额度耗尽，也不改道。 |
| 流前 fetch/CONNECT/DNS/reset 失败 | 单调延长短冷却，尝试其它就绪、未尝试出口。 |
| 其它 HTTP（含401/403/503） | 不改道；并发响应不得清除尚未到期的冷却。 |
| 冷却到期 | 可重新选择，后续成功才可重置失败状态。 |
| 全部冷却 | 不给 lease、不发 HTTP；EgressCoolingError 以 EGRESS_COOLING 报告剩余等待。 |

一次池操作最多以初始池大小为预算；即使列表实时重排，每个稳定 ID 也只尝试一次。
响应按 ID 更新状态，不使用已失效的数组下标。池不启动重试计时器；
不再返回的拒绝响应体会取消，返回给调用者的错误响应仍可读取。

[retry-after.ts](src/retry-after.ts) 供 HTTP 诊断、池和探测共用：有效正十进制 `retry-after-ms`
优先，无效 ms 回退 `retry-after` 的十进制秒数或三种 HTTP-date 格式，毫秒向上取整。
0、过去日期、畸形值不关闭本地退避；日期提示优先用有效服务端 Date 避免本机时钟偏差。
正数溢出安全饱和，不变成短等待或直接溢出的 Node 定时器。

**服务端等待不受本地30分钟上限截断**。只有无提示兜底采用
`base * 2^(failures-1)` 加非负0–20%抖动，并以 max(base,30分钟)封顶；
默认base60秒、最小1秒，传输冷却为 min(15秒,base)。已有期限只延长不缩短，
并发成功、探测或连接失败都不能提前清除。冷却状态不跨重启持久化。

**安全重试边界。** 只在 fetch/响应状态阶段、将响应体交给 SSE reader 前改道。
429 已有 HTTP 响应，但尚未暴露成功的流响应体；一旦响应交回适配器，响应体/流中途失败
直接报错，不由池重播；适配器也将输出后故障标为自身宿主策略不可重试（6.8.1）。
这不证明超时 POST 从未在上游计算。

**持久化与凭据。** 启动时有效设置 JSON store 优先于 config，包括已保存空列表（解析为直连）；
文件缺失/不可读/非法才退 config；解析JSON前剥UTF-8 BOM以兼容PowerShell/编辑器。
默认位置为
`(DSH_PROFILE_DIR || ~/.dsh)/data/dsh-opencode-bridge/proxies.json`，可设 `proxyStorePath`。
编辑先作用于内存池再保存；保存失败会报告，内存变更不保证重启后保留。
文件含原始 URL 与**明文未加密代理密码**，用户账户可读；代码不构成专用安全 ACL 或秘密库。

health/日志/UI display 去掉 userinfo；稳定 id 形如 `proxy:host:port#<8位hex摘要>`，
不含字面密码。短摘要是标识，不是加密或普适匿名保证。UI 用 `{add}`、`{remove:id}`、
`{reset:true}` 操作，而非读取/回传已有凭据；添加必然把新输入 URL 发给 Host，输入框也非密码掩码。
不要截图敏感输入或发布 store；Host service 另接受持有原值者用 `{proxies}` 整体替换。

**管理与探测。** 设置里只有**一个** `settings.section`（id `opencode-bridge`，order 30，
导航名 “OpenCode Bridge”）；页内用两个浏览器式标签页区分“诊断日志”与“出口代理轮换（可选）”，
避免同一插件在设置里出现两处入口。代理标签可添加/删除、测试全部、刷新，显示脱敏地址、
就绪/冷却剩余秒与 lastCode。包私有 RPC 为 `/api/opencode-bridge-proxies/{read,write,test}`。
测试全部仅对就绪条目逐条 GET relay `/models`（默认每条8秒超时），不发提示词或补全请求；
冷却条目返回 EGRESS_COOLING 与等待时间，不发请求。响应按稳定 ID 更新，
并发成功不能清除未到期的限流；不使用的探测响应体会取消。它是可达性/状态检查，不是模型/工具/剩余额度验证，
仍有受上游规则约束的网络流量。UI 渲染和真实 RPC 需另验；任意 `/api` 路径都可返回
未授权401，不能据此证明注册或 handler 成功。

### 6.9.1 SOCKS 传输与 DNS

| URL 协议 | SOCKS 版本 | 目标域名解析 |
|---|---|---|
| `socks4://` | 4 | 本机解析为 IPv4 |
| `socks4a://` | 4a | 原始域名交给代理 |
| `socks5://` | 5 | 本机解析为 IP |
| `socks5h://` | 5 | 原始域名交给代理 |
| `socks://` | 5，规范化为 socks5h | 原始域名交给代理 |

代理自身的域名仍需本机解析。SOCKS4 不支持 IPv6 目标或密码认证，可填写 user ID；
SOCKS5 支持用户名/密码认证，先对 URL userinfo 做百分号解码，再按协议传送。
凭据禁止 NUL，SOCKS5 每个字段最多 255 字节，密码不能在缺少用户名时单独使用。
SOCKS 认证本身不加密；目标 HTTPS 的 TLS 并不保护此前的 SOCKS 认证握手，应使用可信代理与网络。

SOCKS connector 覆盖 DNS、TCP、SOCKS 协商、TLS 的总连接期限为 10 秒。
HTTPS 在隧道上建立 TLS，按原始目标主机名校验证书和发送 SNI；
不关闭 `rejectUnauthorized`，不把代理 IP 或本地 DNS 结果当作证书身份。
测试可以显式信任测试 CA，生产配置没有“关闭 TLS 校验”开关。
请求取消信号仍交给 fetch，插件卸载还会关闭未完成的协商及已建立的池连接。

协商/认证失败、DNS、TLS 或连接超时返回固定 `SOCKS_*` 错误码，不回传第三方错误对象或凭据。
这些属于出口状态，适配器外层仍按现有超时/流错误分类。
选中了代理但 dispatcher 初始化失败或缺失时，不会静默以直连发送该请求；
只有代理池明确配置了后续直连条目，才可能按正常顺序尝试直连。
同一套适配器 POST、目录 GET 与设置页探测均使用该 dispatcher。

不支持自动发现代理、UDP/BIND、逐会话亲和或付费/其它模型回退。
上游额度也可能由非 IP 信号决定；只使用获授权出口并遵守服务限制。

---

## 7. 目录设计

`FreeModelCatalog` 从两个独立来源回答"现在有哪些免费模型"：

| 来源 | 提供 | 缓存 |
|---|---|---|
| `https://models.dev/api.json` → `.opencode.models` | 限额、模态、推理档位、按模型的 API base、弃用状态 | 共享快照，默认10分钟 |
| `GET {baseUrl}/models`（匿名） | 实时可用性 | 同一刷新周期 |

两个来源并发抓取，作为**一个完整的内存快照**原子提交。
启动时预取一次，此后默认每 10 分钟后台刷新（`modelRefreshIntervalMs:600000`），
下一轮从本轮完成后计时。没有磁盘缓存，重载插件会重新抓取；注册表发布快照的节奏仍由上游决定。

### 7.1 刷新生命周期、并发与失败

- `start()` 即时预取，并启动单条不重叠的定时链；重复启动幂等。所属 `ctx.effect` 在卸载时清理。
- 正数间隔最小按 60 秒、最大按 2147483647 毫秒处理。`0` 关闭后台轮询，
  但保留启动预取和按需 10 分钟 TTL；正数时按需 TTL 同刷新间隔。
- `list()` 读取新鲜缓存，`refresh()` 绕过 TTL；多个查询、模型发现与定时器共享一轮在途请求，
  不并发争写快照。
- 两个请求及 JSON 响应体共用 30 秒总期限。任一来源的 HTTP/网络错误、超时或非法结构，
  都保留最后成功快照；首次失败返回空列表。失败后的按需查询退避 60 秒，
  已开启的后台刷新也在一分钟后重试，而非等待完整刷新周期。
- **有效空列表也缓存**，模型全部下架不会触发请求风暴；故障不伪装成成功的空列表。
- 单个调用者取消只拒绝自己的等待，不取消其他调用者共用的刷新。
  卸载则取消所属请求及定时器，等待中的操作以 AbortError 拒绝，迟到响应不得覆盖缓存或通知界面。
  因此 `list()` 会对来源故障降级，但不再笼统宣称“永不抛出”。
- `onUpdated` 仅首次成功或内容（含元数据）真正变化时调用；通知失败不丢弃已经提交的快照。

### 7.2 免费模型筛选

对注册表中已知型号，必须**同时**满足：

1. `cost.input === 0` **且** `cost.output === 0`（输出价格未知不视为免费）；
2. 非 deprecated，或显式开启 `includeDeprecated`；
3. 出现在本次成功获取的 relay 列表中。

`extraModels` 仍是强制附加的显式覆盖，可能带 `live:false`。
实时列表中注册表尚未知晓且匹配 `/(-free$|^big-pickle$)/` 的 ID，继续按既有命名约定补入，
以覆盖尚未同步到 models.dev 的新免费型号。已知付费、弃用或费用不完整的型号不能被后缀规则重新加回。
目录中的可用性是上游声明，不是实际推理健康探针；刷新不发送补全请求。

### 7.3 通知 DSH 模型选择器

适配器 `listModels`、模型元数据解析和模型发现共用同一个快照。
DSH Client 自身还有跨会话共享的目录缓存，仅修改插件内存不足以使界面重查，重新打开选择器也不保证刷新。
实际内容变化后，插件使用**公开注册句柄的 `replace(providers)`** 原子更新自有路由注册，
保持同样的路由名和适配器实例，由 DSH 自己发出契约中的 `llm/adapters-updated`，让界面重读目录。
这不是手工伪造事件，也不是周期 dispose/register；不会主动修改会话选择或取消已经准备好的请求。

该接口会重新获取提供商元数据/重试策略，并可能把本提供商移到注册顺序末尾，
因此不能称为“无副作用的纯模型失效 API”。较旧宿主若没有 handle.replace，
缓存仍会更新，但仅记录一次提醒，需刷新页面；不访问私有 Client 方法。

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
| `providers` | string[] | `['opencode-bridge']` | 本适配器服务的 provider 路由。 |
| `includeDeprecated` | boolean | `false` | 是否提供已弃用但在线的模型。 |
| `extraModels` | string[] | `[]` | 强制追加模型 id。 |
| `requestTimeoutMs` | number | `600000` | 单请求截止时间。 |
| `modelRefreshIntervalMs` | number | `600000` | 模型定时刷新间隔（毫秒）；`0` 关闭后台轮询，正数小于 60000 按 60000 执行。配置须为 0–2147483647 的整数；TTL、重试与界面通知见第 7 章。 |
| `proxies` | string[] | `[]` | 默认仅直连；有序 HTTP(S)/SOCKS/直连条目；启动时已保存 store 优先。 |
| `proxyCooldownMs` | number | `60000` | 出口配额本地兜底基础冷却，最小1秒，指数递增并有非负抖动；不截短服务端提示。 |
| `proxyStorePath` | string | `''` | 空时使用 `$DSH_PROFILE_DIR`（未设置则 `~/.dsh`）加 `/data/dsh-opencode-bridge/proxies.json`，URL/凭据明文存储。 |
| `toolFingerprint` | boolean | `true` | 注入指纹并遮蔽冲突；false 保留调用方工具且不加诱饵。 |
| `toolTranslation` | boolean | `true` | 允许保守校验的只读/搜索诱饵；false 拒绝诱饵但仍恢复别名。注入 shell 始终拒绝。 |
| `logLevel` | string | `warn` | 写盘最低级别：`debug`\|`info`\|`warn`\|`error`\|`off`（`off` 关闭文件日志）。 |
| `logDir` | string | `''` | 日志目录；空 = `<DSH_PROFILE_DIR 或 ~/.dsh>/logs/dsh-opencode-bridge`（实测 Host 进程通常没有 `DSH_PROFILE_DIR`，因此多为 `~/.dsh/logs/dsh-opencode-bridge`）。 |
| `logMaxBytes` | number | `524288` | 单个日志文件大小上限（字节），超出即轮转。 |
| `logMaxFiles` | number | `5` | 保留文件总数（当前 + 轮转）；溢出时**最旧的先删**。 |

在 profile 中覆盖配置是**整行替换**（无深合并），
因此覆盖行必须重述它想保留的每一个键。

**0.4.0 迁移注意（路由与标识改名）。** provider 路由由 `opencode-free` 改为
`opencode-bridge`，行 id 改为 `dsh-opencode-bridge`。迁移时：

1. 如果你的 profile 覆盖行里写过 `providers: [opencode-free]`，改成
   `providers: [opencode-bridge]`；不写就用新默认值。
2. 若把 `dsh-opencode-free` 当作默认模型 provider（例如 `agent-default-model`），
   把 provider 改成 `opencode-bridge`、模型 id 前缀改成 `opencode-bridge/`。
3. 历史会话里已选中的 `opencode-free/*` 模型不会自动跟随，需重新选择一次。
4. 日志目录默认从 `~/.dsh/logs/dsh-opencode-free` 变为 `.../dsh-opencode-bridge`；
   需要保留旧日志就手动移动目录（插件不会读旧路径）。
5. 代理池 store 同样改到 `~/.dsh/data/dsh-opencode-bridge/proxies.json`。

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

运行时要求 **Node ≥ 20.18.1**（由 `package.json` 的 `engines.node` 声明），
与代理依赖 `undici` 7.30.1 的最低要求一致。`AbortSignal.any` 单独只要求 Node 20.3，
但这个下限不足以覆盖代理依赖。源码开发建议使用 Node.js 22 或 24 LTS。
安装器可能按自身 engine 策略警告或拒绝不满足要求的运行时，不能以版本声明代替实测。

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
| `429 RATE_LIMIT` | 上游拒绝，作用域/原因需结合诊断 | 检查模型/状态/upstreamType/reason/等待并遵守期限；仅明确出口配额且无等待提示可改道。Endpoint不可用不证明IP额度耗尽。 |
| HTTP503 / Endpoint is unavailable | 推理端点不可用，根因未隔离 | 503不触发池轮换，不当作IP配额或承诺换代理能修好。 |
| 池lastCode ECONNREFUSED/TIMEOUT/TRANSPORT_ERROR | 流前连接/传输故障 | 检查代理可达性，短冷却后可用其它出口；响应体故障不重播。 |
| 模型未出现在选择器中 | 注册表/实时列表不匹配 | 把 id 加入 `extraModels`，或开启 `includeDeprecated: true`。 |
| `TOOL_BRIDGE_REJECTED` | 未知/可执行诱饵、翻译关闭、schema 不支持、目标缺失或 JSON/值非法 | 看固定原因，运行作用域 `opencode_bridge_audit`，优先调用方别名/原生 pwsh；不要猜另一种 shell 绕过拒绝。 |
| `TOOL_BRIDGE_INCOMPLETE` | 工具片段以 EOF/length/stop 而非 tool_calls 结束 | 未放行工具块，排查上游截断/结束处理。 |
| DSH 拒绝恢复后的原生调用 | 参数不满足宿主 schema/权限 | 核对实际调用方契约；桥的对象检查不替代宿主策略。 |

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
| `pnpm test` | `node --test tests/*.test.mjs` —— 离线桥/审计/整批/取消、代理池/轮换、日志和mock客户端激活回归。 |
| `node tests/proxy-live.mjs [代理URL] [模型id]` | 真实CONNECT/直连relay GET探测与固定标记合成补全，需网络与补全额度；不故意压满额度触发429。 |
| `node tests/wire-dump.mjs` | 打印 `attributionSuffix()`、`buildHeaders()`、`SESSION_ID_RE` 与规划出的工具名——不产生网络 I/O 即可确认线上指纹的最快方式。 |
| `node tests/smoke.mjs [模型id]` | 完整实时链路：id 正则 + 低 12 位不变量、工具规划/别名/翻译、实时目录、真实流式补全。 |

**验证范围：** [工具桥测试](tests/tool-bridge.test.mjs)与[桥集成测试](tests/bridge-integration.test.mjs)
覆盖调用方名字预留、配置开关、schema 拒绝、原生 JSON 对象检查、agent 作用域审计及
mock SSE 整批放行（含不完整结束）；[取消回归](tests/bridge-cancellation.test.mjs)
覆盖 POST 前、已缓存调用与工具发块期间取消。日志/客户端测试也属离线。
`tests/wire-dump.mjs` 是离线转储，`tests/smoke.mjs` 才是消耗网络/额度的实时探针。
存在测试或离线通过，不证明所有模型、真实工具分发或 Desktop 启动已通过。
发布验证结果应单独记录，不把历史闸门观察改写成新一轮全量验收。

### 0.5.2 限流/重试验证（2026-10-19）

- 编译/客户端语法及 **211/211 测试通过，无跳过**，新增HTTP/解析12例、重试接线28例；
  原改道/冷却夹具按有意收紧后的规则更新，不再保留冷却期间尽力发请求的旧预期。
- 覆盖全部冷却零网络、期限边界、并发状态不缩短、毫秒/秒/HTTP-date/超大提示，
  无服务端等待才尝试就绪出口、稳定ID实时编辑、模型手动重试保护与探测跳过冷却。
- 验证含秘密的错误正文不进结构日志、URL userinfo去除、取消，以及文本/推理输出后
  超时或传输失败变为不可重试的 PARTIAL_STREAM_ERROR。
- 测试中的宿主重试执行器明确是契约模拟器，不是直接调用安装版Host；
  另已读取其源码/API，核实策略、等待、预算、取消与部分输出行为。
- 未调用真实GLM推理，也未做重试压力测试。本次约束客户端恢复和完善诊断，
  不证明上游服务已经稳定或产生新的可用额度。

### 0.5.1 模型定时刷新验证（2026-10-19）

- 编译/客户端语法检查及完整回归 **171/171 通过，无跳过**，其中目录状态26例、插件生命周期7例。
  假时钟覆盖真实计时间隔，不必等待10分钟，也不调用模型推理。
- 覆盖增删/价格变更、有效空结果、容器及条目结构错误、两来源失败、退避、并发合并、
  调用者取消隔离、JSON 响应体超时、迟到结果、关闭/重复定时任务与卸载。
- 接线夹具验证同适配器/同路由原子 `replace`，不反复注册或提前清理，模型发现复用新快照，
  相同快照不通知及旧宿主降级。保留现有 Issue 表单描述，修正仍要求描述中出现 API Key
  的过时断言，改为检查已有 warn/error 提示及隐私确认项。
- 真实 models.dev 与 relay GET /models 的纯元数据刷新成功，本次快照返回10个模型；
  未发送补全请求或执行工具。
- 已读取当前安装版 Host 公共 replace 语义及 Client 目录监听代码；不等于已做视觉自动化，
  也不证明所有未来 DSH 版本。当前版本/tag 发布前置检查已通过 v0.5.1。

### 0.4.1 SOCKS 与发布准备验证（2026-10-19）

- 编译及客户端语法检查通过；完整回归 **138/138 通过，无跳过**。其中包含 14 个真实
  loopback SOCKS/TLS 测试、10 个 SOCKS 配置测试、33 个发布脚本测试与 6 个 GitHub YAML/策略测试。
- 本地网络测试实际走 SOCKS4/4a/5/5h 协商，覆盖百分号解码认证、正确/错误密码、
  本机/远端 DNS、HTTPS 信任链及主机名校验、超时/关闭清理和两个 SOCKS 出口的 429 切换。
  使用公开的测试证书与密钥，不修改全局 TLS 策略，不连接用户代理或上游模型服务。
- 设置 `RELEASE_TEST_PNPM` 指向本机 pnpm.mjs 后，真实 pnpm 打包 fixture 也通过；
  CI 的正常 `pnpm test` 可跳过该可选 fixture，随后必须对实际插件执行打包与归档校验。
- `pnpm install --frozen-lockfile`、`release-check --tag v0.4.1` 均通过。
  实际构建插件归档为 34 个文件，通过资源/版本检查及 `SHA256SUMS` 生成与复核；
  临时归档验证后已删除，研究目录、测试证书/密钥、工作流与开发脚本不进入插件包。
- 未推送 commit/tag、未运行远端 GitHub Actions、未创建 Release、未发布 npm。
  本轮不声称公网 SOCKS、实际浏览器保存流程、所有 Node 版本或上游推理已验收。

### 0.4.0 本轮验证记录（2026-10-18）

- 编译通过，离线 **66/66**（proxy-pool 11例、适配器proxy-rotation 6例）。
  它们验证受控输入下的策略，不是线上429额度耗尽实验。
- 经获授权本机HTTP CONNECT代理访问真实relay `GET /models` 为200、847ms，
  直连亦为200、2384ms，证明隧道真实承载relay流量；不证明补全可用或代理认证已实测。
- 真实Host重挂`0.4.0`返回`application: applied`。该Host未设置`DSH_PROFILE_DIR`，
  默认store基目录为`~/.dsh`。按UI相同格式写store并重载，日志`egress pool ready`
  出现`source:settings-store`与测试代理/直连条目，证明真实store→重载→池加载，
  不是浏览器保存操作测试。
- 此测试发现UTF-8 BOM曾导致静默退回config；现加载先剥BOM，往返测试覆盖。
  验证后已删除store并重载，默认仍**仅直连**，没有预置本机代理或残留测试store。
- 直连和代理的固定`PROXY_OK`合成补全均返回 **HTTP503 / Endpoint is unavailable**，
  未得到PROXY_OK；未跨模型重试、未隔离根因，不能称端到端推理通过。
- 未为验证刻意触发真实429以免耗尽免费额度；轮换正确性由离线测试支持，非线上429实测。
  浏览器实际渲染未验证；Host对未知`/api`路径也先返回401，外部401探测不能证明RPC注册。

### 0.3.0 本轮验证记录（2026-10-18）

- 编译成功；离线测试 **49/49** 通过，包含桥接、取消、作用域、日志和 mock 客户端激活。
- 本机通过插件管理器重新挂载 `0.3.0`，返回 `application: applied`；真实执行
  `opencode_bridge_audit({limit:8})` 成功。该 Agent 当时为 41 个调用方工具、3 个别名、
  3 条候选映射、2 条可执行诱饵拒绝；这是观测样本，不是所有 Agent 的固定数量。
- 打包干跑退出码 0，包含新增模块与比较报告，不含 `research/`。
- 一次仅含固定测试文本的 `glm-5.3-flash-free` smoke：实时目录读到 10 个模型，
  推理 POST 返回 **HTTP 503 / Endpoint is unavailable**，未得到 `SMOKE_OK`，脚本退出码 1。
  未跨模型重试，也未做有/无策略指导的隔离对照，不能据此确认 503 的根因。
- 因而本轮**不声称端到端推理或完整 Desktop/UI 验收通过**；离线回归与真实审计入口已验证。

端到端验收分两部分：

1. **线上层** —— `tests/smoke.mjs` 返回 `finish{kind:'stop'}`，
   文本非空，`ses_` id 合法。
2. **宿主层** —— 在运行中的 DSH profile 内，经 provider `opencode-bridge`
   路由的一次性模型调用返回预期答案，证明适配器已注册、被发现，
   且能通过 `LlmRuntime` 抵达。

---

## 12. 安全、隐私与归属

- **默认无密钥。** 插件不从钥匙串/环境变量发现凭据。默认发送 `Bearer public`，
  也可发送显式配置的 `apiKey`；这类配置值仍必须视作秘密。
- **归属是被保留而非移除的。** DSH 契约要求每个 provider 请求都标识本 harness。
  插件满足该要求——产品名与项目 URL 都已公开——只剥离版本段，
  因为带版本的第三方产品令牌会被闸门拒绝。
  这是在两个约束下最小的偏离，也是代码中 `attributionHeaders()`
  被**导入并变换**而不是被绕过的原因。
- **无额外遥测。** 插件除请求本身外不发送任何东西：无埋点、无回传、
  不记录提示内容。`prompt_cache_key` 是去掉前缀的会话 id
  ——稳定的按会话缓存令牌，不主动嵌入用户标识；稳定 ID 与元数据仍可被关联，
  不构成匿名性保证。
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

1. **保守工具桥、有限证据。** 已有规划/桥/审计与 mock 流回归，但没有完整
   模型/Host/UI 验证矩阵或全协议形式验证。未知 schema 约束 fail-closed，会误拒绝
   合法工具；原生完整 schema/权限仍由宿主负责。工具需等整批响应，增加延迟。
   作用域审计不一定等于 PTC/辅助请求工具集，不查看实际调用历史，也不授予权限。
   read/search 路线名不证明任意同名实现无副作用。
2. **纯文本内容通路。** 图片与文件是占位符。部分免费模型在注册表中声明
   `image` 输入；当 relay 提供多模态对话时，`buildChatMessages`
   应发出真实内容分片。注册表已发布 `inputModalities`，适配器可按模型决策。
3. **响应侧推理内容。** 目前只识别 `reasoning_content`。
   其他提供方的写法（`reasoning`、`thinking`）未解析。
4. **窄边界出口改道，不是通用重试。** 推理仅对明确出口配额且无服务端等待、或流前传输失败改道，
   401/403/503、未知/模型作用域429及响应体失败不换出口；宿主使用6.8.1的有界策略。支持 HTTP(S) CONNECT 与 SOCKS4/4a/5/5h；
   按顺序健康复用，不逐会话绑定；靠前出口恢复后重新优先。凭据磁盘明文，
   Retry-After支持十进制时长及HTTP-date，上游额度不一定仅由IP决定。
5. **单一层级默认。** 只提供零成本模型；没有切换到付费 console 模型的开关。
6. **会话缓存是进程内的。** 宿主重启后，既有对话会获得新的 `ses_` id，
   因此跨重启会失去上游 prompt 缓存亲和。

---

## 14. 变更记录

每次功能增删或技术原理修改都必须在此追加一行（见第 0 章规约）。

| 日期 | 版本 | 变更 | 影响章节 |
|---|---|---|---|
| 2026-10-19 | 0.5.2 | **429诊断与有界恢复**：新增严格 Retry-After 时长/日期解析与安全 HTTP 元数据，保留实际状态、日志不抄原始错误正文。拒绝冷却出口，不缩短服务端期限，避免重复出口及重排错位，探测跳过冷却。区分请求/后端错误与明确出口配额，按模型记住服务端等待，仅由 DSH 执行 normal 最多2次重试；输出后故障用 PARTIAL_STREAM_ERROR 防重放。补充辅助模块/集成回归，同步双语文档并准备0.5.2，不执行发布。 | 3、6.8–6.9、11、13–16、README |
| 2026-10-19 | 0.5.1 | **简介完善**：中英文插件简介与 npm 包描述按“免费模型接入、模型列表动态刷新、可选代理出口轮换、工具桥与离线 Agent 作用域审计”排序，工具桥/审计说明置于最后。 | 15.5 |
| 2026-10-19 | 0.5.1 | **模型定时刷新**：新增 `modelRefreshIntervalMs`（默认10分钟，0关闭轮询），启动预取、两来源原子快照、请求合并、期限/退避及卸载清理；来源故障保留旧缓存，有效空列表也缓存。已知型号须输入/输出均零价，后缀规则不得重新加入付费/弃用项。内容变化时用同一适配器原子更新自有路由来通知 DSH，保留已准备请求，并说明注册顺序/策略重捕获副作用及旧宿主降级。新增目录/生命周期回归，同步包、README 和当前发布示例至0.5.1。 | 3、6.2、7、8、11、14、16、README |
| 2026-10-19 | 0.5.0 | **Bug 日志必填**：问题反馈表单的脱敏错误日志改为必填，增加从设置页诊断日志刷新/复制及手动脱敏的双语提示；同步表单测试。 | 16.1 |
| 2026-10-19 | 0.5.0 | **Desktop 安装指引**：两份 README 在命令行安装前新增“插件 → 添加插件”的界面操作、固定版本包名及镜像同步提示；保留 CLI 安装，改为模型未显示时再建议重启 profile。 | README |
| 2026-10-19 | 0.5.0 | **发布版本准备**：包版本由 0.4.1 升至 0.5.0，同步两份 README 的安装命令/tarball 版本及当前 tag 发布操作示例。保留历史变更与验证记录；此次文件编辑不创建 tag、提交或执行发布。 | 0、14、16、README |
| 2026-10-19 | 0.4.1 | **SOCKS 支持**：新增 SOCKS4/4a/5/5h 与 socks 别名、DNS 模式及用户名/密码校验；HTTPS 保留证书/主机名校验；并发共享初始化、卸载销毁连接，代理 dispatcher 缺失不静默直连。同步设置页提示与双语 README，删除指定的连通性/额度提示句。新增本地真实 SOCKS/TLS 和配置回归。 | 3、6.9、8、11、13、README |
| 2026-10-19 | 0.4.1 | **贡献与发布自动化**：新增问题/功能 Issue Forms、固定 SHA 的 tag 触发 Release 工作流、版本/归档/校验和脚本与回归测试；构建只读、发布 job 才有 contents:write，不自动发布 npm。增加项目 pnpm 11 配置并同步锁文件，使冻结安装可用。 | 0、3、11、16、附录 A |
| 2026-10-18 | 0.4.1 | **面向访问者的文档整理**：两份 README 改为功能、安装/首次使用、可选代理、必要风险与常见问题；协议/完整配置/schema/验证细节保留在技术文档，以链接替代首页长篇说明，源码开发步骤折叠。新增读者分层维护规约；`engines.node` 修正为 `>=20.18.1`，与当前 undici 依赖一致。安装命令与 tarball 示例仍固定 0.4.1。 | 0、9、14、README |
| 2026-10-18 | 0.4.1 | **补丁版本发布准备**：升级包版本，同步两份 README 的固定版本安装命令与本地 tarball 示例；保留历史功能版本及验证记录。 | 0、14、README |
| 2026-10-18 | 0.4.0 | **设置界面合并与改名**：原“日志/代理”两处 settings.section 合成一个 `opencode-bridge` 页（页内两个标签），插件显示名由 “OpenCode Free” 改为 “OpenCode Bridge”（`locale` 标题、`providerInfo`、`displayName`、设置导航）。 | 3、6.2、6.9、15.4 |
| 2026-10-18 | 0.4.0 | **路由与标识统一改名**：provider 路由 `opencode-free` → `opencode-bridge`（默认 `providers`、model discovery、`settingsNs`），插件行 id 与导出名 → `dsh-opencode-bridge`，RPC 命名空间 → `/api/opencode-bridge-{logs,proxies}/*`，工具 `opencode_free_log` → `opencode_bridge_log`，日志目录/文件名与代理 store → `dsh-opencode-bridge`。旧会话里已选的 `opencode-free/*` 模型需重新选择；磁盘上没有需要迁移的 profile 配置（迁移说明见第 8 章）。 | 0、3、6.2、6.9、8、11、15 |
| 2026-10-18 | 0.4.0 | **默认日志级别改为 `warn`**（原 `info`）：`Config.logLevel` 默认值与非法值兜底同步改为 `warn`，设置页下拉默认也显示 `warn`，减少默认写盘量。 | 8、15 |
| 2026-10-18 | 0.4.0 | **仓库整理**：`research/` 确认不上传（第三方源码/二进制）；把两份自研调研笔记整理到 `docs/research-notes/` 并加入版本库；删除重复的上游 tarball 与未使用的 `bun.exe`（约 92 MiB）。 | 附录 A |
| 2026-10-18 | 0.4.0 | **运行时要求**：声明 `engines.node: ">=20.3"`（`AbortSignal.any` 所需），两份 README 的开发段写明 Node 版本与 `lib/` 未提交、需先 `pnpm build`。 | 9、附录 A |
| 2026-10-18 | 0.4.0 | **发布规约**：第 0 章新增“升版本必须同步两份 README 的安装命令与 tarball 示例版本”，并加 `tests/readme-version.test.mjs` 守卫（命令/tarball 版本必须等于 `package.json`）。同时把 README 安装命令改为 `dsh plugin --profile desktop add dsh-opencode-bridge@<版本>`。 | 0、11、附录 A |
| 2026-10-18 | 0.4.0 | **出口代理轮换**：顺序健康复用、逐出口429/传输冷却、仅流前改道、惰性undici CONNECT；代理设置页与URL明文store持久化，加载容忍UTF-8 BOM。修复缺少x-opencode-log-id时传requestId:null给LlmError，429/401不再被误报STREAM_FAILED而保留RATE_LIMIT/AUTH。新增池/适配器回归与按需实测脚本，不patch全局HTTP。 | 1–3、6.8–6.9、7–14、附录A |
| 2026-10-18 | 0.3.0 | **安全工具桥**：先预留全部调用方名；关闭指纹仍保留调用方工具；始终恢复别名；拒绝可执行/未知诱饵与不支持 schema；原生参数要求 JSON 对象；完整响应整批校验后才发工具块，不提供执行回滚。 | 0、3、6、8、10–13 |
| 2026-10-18 | 0.3.0 | **离线作用域审计**：可选 `opencode_bridge_audit` 只用 `tools.schemas(exec.agent)`，有界输出名字/别名/路线决定；不退全局，不导出聊天/入参/schema 描述，不联网不执行。新增桥/审计回归及固定 HEAD 比较；收窄隐私/轮转与 Desktop 验证声明。 | 3、6.4.1、11–15、附录 A |
| 2026-10-18 | 0.2.1 | **发布准备**：npm 包名定为 `dsh-opencode-bridge`（无 scope 的 `dsh-opencode-free` 已被他人占用；scoped 名辨识度不足，改为桥接寓意的独立名字）；`client.js` 模块 id 与 `cordis.patch.yml` 的 `name` 同步包名（行 `id` 不变）；新增 LICENSE、`.gitignore`、`prepack` 构建钩子；插件介绍移除设置日志查看器的宣传文案。 | 3、14、附录 A |
| 2026-10-18 | 0.2.1 | **客户端激活加固**：每步 try/catch、可选服务访问、locale 先注册后绑定、不设 `immediately:true`，新增敌对 ctx 回归测试。测试仅覆盖 mock 激活，不证明 Desktop 崩溃已复现、根因已确认或真实恢复已通过。 | 3、15.6 |
| 2026-10-18 | 0.2.0 | 新增分级日志（脱敏 + 按大小轮转自动清理最旧）、DSH 设置界面日志查看/复制 UI、`opencode_bridge_log` agent 工具；建立文档维护规约。 | 0、3、8、11、13、14、15 |
| 2026-10-17 | 0.1.0 | 首版：三层闸门复刻、`OpenCodeFreeAdapter`、免费模型目录、工具遮蔽/翻译。 | 1–13 |

---

## 15. 日志与诊断

目标：有用的元数据诊断、best-effort 脱敏与轮转。调用点不得主动记录凭据、
用户消息或工具入参。这是工程约束，不证明零敏感信息或严格磁盘字节上限；
分享前请复核日志，尤其是上游错误正文。

### 15.1 分级与输出

`src/logger.ts` 的 `PluginLogger` 提供 `debug / info / warn / error` 四级
（配置 `logLevel` 设定写盘下限，`off` 关闭文件输出）。每行格式：

```
2026-10-18T02:17:05.003Z [INFO ] [adapter] completed {"model":"glm-5.3-flash-free",...}
```

时间戳（ISO）+ 级别 + scope + 消息 + 可选 JSON 数据。scope 取值：
`plugin`（入口/注册）、`adapter`（每次模型调用）、`catalog`（模型目录）、
`log-service`（日志自身操作）。

调用点约定：**只记元数据**——合法模型 ID、消息/工具数、token 用量、状态、耗时与请求 ID；
不记消息内容、工具参数、请求体或任意上游错误正文。debug 请求只记 URL origin，
不含 userinfo、查询或路径；HTTP 诊断使用有界且过滤凭据形态的类型/ID及固定 reason 摘要。

输出前限流/冷却改记 WARN `request deferred`，不表示整段对话已经失败。
字段含 model、code、真实观察到的 status、upstreamType/reason、实际 retryAfterMs、
有提示时的 serverRetryAfterMs、本地 request/上游 requestId、脱敏 egress、
outputStarted、retryEligible。后者仅表示代码符合重试类别，**不保证剩余预算或已调度重试**。
不可重试/部分输出错误仍记 ERROR；部分输出保留 originalCode，并保留安全传输码/工具桥原因。

### 15.2 脱敏（防泄漏三道闸）

`PluginLogger.redact()` 提供以下启发式兜底，但不是穷尽敏感信息检测：

1. **字面秘密**：构造时注入的 `secrets`（当前为 `config.apiKey`）逐字替换为
   `[redacted]`；
2. **令牌形态**：`Bearer <token>`、`sk-…`/`key-…`/`token-…`/`secret-…` 形状的
   长字面量替换为 `[redacted]`；
3. **截断**：单个字符串超 2000 字符截断并标记 `…[truncated]`。

`data` 中字符串/序列化值经过 `redact()`；少于四字符的已知秘密不注册，
任意敏感文字也可能不匹配规则。截断不是脱敏。[日志测试](tests/logger.test.mjs)
覆盖规则示例，不是普适隐私证明。

### 15.3 轮转与自动清理

追加前按 `logMaxBytes`（默认 512 KiB）检查阈值并触发轮转：`dsh-opencode-bridge.log`
→ `.1` → `.2` …，按 `logMaxFiles`（默认 5）尝试最旧优先清理。这是 best-effort 保留，
**不是** `logMaxBytes × logMaxFiles` 的严格上限：超大行可越过阈值，轮转/删除可能失败，
单文件配置还有 `.1` 边界问题。启动仅在固定扫描范围内清理数字后缀。
写盘异常被吞，仍可读取 200 行内存环；不要将其当存储配额或安全擦除机制。

### 15.4 一套实现，两个调用方

`src/log-service.ts` 的 `LogService` 是唯一的读/清/改级操作实现：

- **设置界面 UI**（`client.js`）：注册进 `settings.section` 插槽
  （设置页 “OpenCode Bridge” → “诊断日志”标签），提供级别过滤、刷新、**复制全部**（Clipboard API
  带 `execCommand` 兜底）、清空（带确认）。数据经包私有 JSON RPC
  `/api/opencode-bridge-logs/{read,stat,clear,level}` 获取——与已验证的
  `connection.fetch.register` / `connection.rpc.call` 通道同款（见
  `dsh-tool-antigravity` 的实现）。
- **agent 工具 `opencode_bridge_log`**：`action: read|stat|clear|level`，
  走同一 `LogService`。模型可自行拉取诊断日志；仅 best-effort 脱敏，分享/回传上下文前仍需复核。

UI 是纯浏览/复制操作（不改配置），因此未给 agent 暴露"改配置"路径——
`level` 只改运行时级别，重启后由配置恢复。

### 15.5 显示资源

`locale/{en,zh}.json` 提供插件标题与描述，`icon.svg` 为原创图标
（两节点 + 桥弧 + 星芒，寓意"协议桥"）。`package.json` 的 `exports`/`files`
包含 `client.js`、`locale/*.json`、`icon.svg`；`dsh.client` 声明
`platform: web` 及 4 个客户端依赖包。**注意：`dsh.client` 不设
`immediately: true`**——它会让模块在 web-boot 早期强制激活，此时
`settings.section` 插槽可能尚未声明（见 15.6）。

### 15.6 客户端模块健壮性规则（0.2.1 激活加固）

激活异常可能破坏客户端启动。以下防御针对服务缺失/抛错与激活时序；mock 回归
**不能**确定某次 Desktop 崩溃根因，也不能证明真实 Desktop 重启/恢复已通过。
此类结论需要真实客户端日志与受控复现。

**已防御的风险：**

1. 对未注册 locale 命名空间 bind 可能抛错，因此先注册再绑定。
2. 插槽/服务不可用时无保护访问可能失败；强制早期激活可能与插槽声明竞争，
   因此不使用 `immediately:true`。

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

## 16. Issue 规范与按 tag 发布 Release

### 16.1 Issue Forms

[.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/) 定义问题反馈与功能建议两种表单。
问题反馈必填 DSH/插件版本、系统、复现步骤、预期与实际行为，以及脱敏错误日志；
日志字段说明获取方法：复现问题后在“设置 → OpenCode Bridge → 诊断日志”刷新并复制全部，手动移除敏感信息后粘贴。
功能建议必填问题目标与建议方案。两者均要求确认未包含 API Key、带密码的代理 URL 或私人聊天。
`config.yml` 禁止网页新建空白 Issue，并提供文档入口；表单提交后由 GitHub 生成 Markdown。
这是网页提交规范，不是限制所有 API 客户端的服务端规则。文件需提交到仓库默认分支才会在新建 Issue 页面生效。

### 16.2 自动发布条件与权限

[.github/workflows/release.yml](.github/workflows/release.yml) 仅由推送 `v*` tag 触发，
随后要求 tag **严格等于 `v` + `package.json.version`**，并验证两份 README 安装命令和 tarball 版本。
例如包版本 `0.5.2` 对应 `v0.5.2`；`v0.5.3-rc.1` 这类预发行 tag 对应同名预发行包版本。
错误 tag 会失败，不会自动修改源码版本，也不会发布 npm。

工作流使用 Node 24、pnpm 11.28.5；按固定 SHA 引用 Actions。
当前 pnpm 的项目配置由 [pnpm-workspace.yaml](pnpm-workspace.yaml) 声明 `autoInstallPeers:false`，
与旧 [.npmrc](.npmrc) 及锁文件一致，保证 `pnpm install --frozen-lockfile` 可复现；不要通过关闭冻结安装绕过漂移。

流水线分两步：

1. **构建 job（contents:read）**：检查 tag/README/锁配置 → 冻结安装 → 编译 → 离线测试
   （含本地 TCP/SOCKS/TLS，不发送上游模型请求）→ `pnpm pack`。
   [scripts/release-check.mjs](scripts/release-check.mjs) 检查只有一个 `.tgz`、包版本/入口/资源齐全、
   文件与构建工作树一致，拒绝研究资料、开发源码、测试、凭据文件等非发布内容，
   并做有限的凭据模式扫描（仅放行少量明确的公开占位示例）；此扫描不能证明包内绝无秘密。
   [scripts/release-checksum.mjs](scripts/release-checksum.mjs) 生成并复核 `SHA256SUMS`，再传递构建产物。
2. **发布 job（contents:write）**：固定到构建 commit，复核校验和、确认远端完整 tag ref 未移动，
   再用 `GITHUB_TOKEN` 创建公开 Release，上传 `.tgz` 与 `SHA256SUMS`，自动生成更新说明。
   预发行版本自动标记 prerelease，且不设为 latest；已有同名 Release 时拒绝覆盖，需人工处理。

不需要 PAT、npm token 或额外的 npm 发布凭据。仓库必须允许 GitHub Actions 及这些固定版本 Actions，
组织策略须允许发布 job 的 `contents:write`。建议保护版本 tag，不强制移动已经发布的 tag。

### 16.3 维护者操作

先选**未使用**的版本号，同步包版本与两份 README；提交所有源码、工作流、模板、测试与锁文件。
以当前 `0.5.2` 为例（若该 tag 已用，先升到新的版本再替换下面的值）：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
node scripts/release-check.mjs --tag v0.5.2
# 通过后自行提交并推送 main，再创建并推送该提交的 tag：
git tag -a v0.5.2 -m "Release v0.5.2"
git push origin v0.5.2
```

到 GitHub **Actions → Tagged plugin release** 看结果，再到 **Releases** 下载资产。
普通分支 push、只改版本文件、只在本地创建 tag 都不会发布；必须把 tag 推到 GitHub。
这是 GitHub Release 自动化，npm 仍需单独发布；不要把 GitHub 自动生成的 Source code 压缩包当作已构建插件。
构建或发布失败时先看日志修正原因，勿用强推 tag/覆盖资产掩盖问题。

## 附录 A —— 仓库清单

```
package.json              清单；dsh.bundle.patch → cordis.patch.yml；dsh.client → client.js
tsconfig.json             ES2022 / Node16 / strict，src → lib
cordis.patch.yml          bundle 层补丁（插入插件行）
.npmrc                    旧版 pnpm 配置，auto-install-peers=false
pnpm-workspace.yaml       pnpm 11 项目配置，autoInstallPeers=false（需与锁文件一致）
.github/ISSUE_TEMPLATE/   问题反馈/功能建议表单及空白 Issue 策略
.github/workflows/release.yml tag 触发的构建与 Release 资产发布
scripts/release-check.mjs 版本/归档资源检查
scripts/release-checksum.mjs SHA256SUMS 生成与验证
src/index.ts              插件入口（Config、apply、注册、日志装配）
src/opencode-protocol.ts  闸门常量、id、请求头、工具、消息
src/adapter.ts            LlmAdapter；工具批次、有界重试与安全诊断
src/http-errors.ts        HTTP 状态/类型/reason 与安全诊断转换
src/retry-after.ts        共用严格 Retry-After 时长/日期解析
src/tool-bridge.ts        保守 schema 子集、只读/搜索映射、可执行诱饵拒绝
src/bridge-audit.ts       离线当前 agent 原生注册表作用域审计
src/proxy-pool.ts         顺序出口/冷却/store与HTTP/SOCKS dispatcher缓存
src/socks-dispatcher.ts   SOCKS握手、DNS/认证、TLS与连接清理
src/proxy-service.ts      实时代理编辑、health、GET探测与RPC
src/catalog.ts            定时、原子快照、请求合并的免费模型目录
src/logger.ts             分级日志（脱敏、轮转、内存兜底）
src/log-service.ts        LogService + RPC 路由 + agent 工具
client.js                 设置界面日志与代理管理面板（浏览器端模块）
locale/en.json, zh.json   插件标题/描述（显示清单）
icon.svg                  原创插件图标
lib/                      tsc 产物（发布内容）
tests/logger.test.mjs     日志模块密闭单测
tests/tool-bridge.test.mjs 规划、碰撞、开关、schema/JSON 与诱饵拒绝测试
tests/bridge-integration.test.mjs 作用域审计与 mock 流原子整批测试
tests/bridge-cancellation.test.mjs 请求前/缓存批次/发块时取消回归
tests/proxy-pool.test.mjs  条目/health/顺序选择/store/冷却测试
tests/http-errors.test.mjs HTTP 转换、等待提示与安全诊断
tests/retry-integration.test.mjs 严格冷却/防重放与宿主契约模拟
tests/socks-config.test.mjs SOCKS URL/凭据/存储与取消边界
tests/socks-network.test.mjs 真实loopback SOCKS/TLS/认证/轮换/关闭测试
tests/helpers/socks-server.mjs 仅loopback测试服务器
tests/fixtures/socks-tls-* 公开测试证书/密钥（不可用于生产，不进入插件包）
tests/release-check.test.mjs tag/归档/校验和与打包回归
tests/github-config.test.mjs Issue/工作流YAML、权限及锁配置校验
tests/proxy-rotation.test.mjs 适配器改道与流中途不重播测试
tests/proxy-live.mjs      按需真实CONNECT/直连元数据与合成推理探针
tests/readme-version.test.mjs README 安装命令/tarball 版本一致性守卫
tests/catalog-refresh.test.mjs 假时钟刷新/缓存/故障/取消测试
tests/catalog-lifecycle.test.mjs 模型发现/注册/effect 生命周期测试
docs/COMPARISON.zh.md     固定 HEAD 源码比较及证据边界
docs/research-notes/      可公开的调研笔记（自研分析；不含第三方源码）
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
