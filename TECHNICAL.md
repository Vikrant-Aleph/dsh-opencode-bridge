# dsh-opencode-bridge — 技术设计

中文 | [English](TECHNICAL.us.md) · [伪装原则](CAMOUFLAGE.md)

面向本插件维护者，以及想参考一个 provider 线上协议 `LlmAdapter` 实现的 DSH 插件作者。也涵盖可选的上下文精简及其安全约束。

> **带日期的快照。** 上游事实于 2026-10/11 实测建立：对 `https://opencode.ai/inference/*` 的探针、
> 已安装官方 CLI（2.2.0）的抓包，以及阅读 `anomalyco/opencode` 源码（v2.2.0 交叉验证）。
> 「目前是否被检测」的口径为 **2026-11-17**（最后一次活体探针）。门禁会演进，常量都是有日期的观测，
> 不是规范；更新方法见 §9。

总原则：**保留与官方客户端一致、且用户设置改不了的细节。** 其中被网关检查的必须匹配；不被检查的保留作预防；本来就交给用户自由决定的内容不模仿。取舍清单见[伪装原则](CAMOUFLAGE.md)。

## 1. 架构

```
DSH agent loop
   │  GenerateOptions / messages / tools
   ▼
OpenCodeFreeAdapter              src/adapter.ts
   ├── planTools                 声明调用方工具（一个都没有时补占位）
   ├── code-mode（免费路由）      锚点 + execute + 已准入的 subagent；其余工具进 SDK
   ├── buildChatMessages         DSH 消息 → OpenAI 对话，追加环境指令
   ├── buildHeaders              身份头 + 可选追踪头
   ├── prepareImageProjection    官方附件接口
   └── fetchWithPool             出口池、冷却、故障切换
         ├── bunFetch            Bun 形态 TLS（wreq-js，可选）
         └── plain fetch         传输不可用时的回退
   ▼
https://opencode.ai/inference/...
```

工具声明有两条路径，模型看到什么在 §2.2 讲，调用之后谁执行在 §5 讲：

- **直接声明**：把调用方工具净化后直接放上线路。用于非免费路由，或宿主没有 PTC 运行时的回退。
- **Code Mode**：免费路由当前步骤准入 `execute` 时，线上声明锚点、`execute`，以及本步允许的 `subagent`。其余工具列进系统提示的 SDK。宿主没有 PTC 或本步未准入 `execute` 时，仍走直接声明。

其余模块：

| 模块 | 职责 |
|---|---|
| [catalog.ts](src/catalog.ts) | 免费模型发现：读官方目录，含 TTL 与重试（§3）。 |
| [opencode-protocol.ts](src/opencode-protocol.ts) | 头、消息、工具声明、环境指令的线上形态（§2）。 |
| [code-mode.ts](src/code-mode.ts) | Code Mode 的目录渲染与 `execute` 注册（§2.2、§5）。 |
| [project-identity.ts](src/project-identity.ts) | 按真实目录推导 `x-opencode-project`（§2.1）。 |
| [image-input.ts](src/image-input.ts) | 附件图片投影与预算（§4）。 |
| [reasoning-policy.ts](src/reasoning-policy.ts) | 已完成轮次思考投影，供可选精简（§4）。 |
| [http-errors.ts](src/http-errors.ts)、[retry-after.ts](src/retry-after.ts) | 上游错误分类、`Retry-After` 解析（§6）。 |
| [request-waits.ts](src/request-waits.ts) | 清理旧版冷却文件；当前请求不读写按模型等待（§6）。 |
| [proxy-pool.ts](src/proxy-pool.ts)、[proxy-service.ts](src/proxy-service.ts) | 出口池与设置页编辑（§6、§7）。 |
| [request-diagnostics.ts](src/request-diagnostics.ts)、[logger.ts](src/logger.ts) | 有界、无内容的请求摘要与脱敏日志（§6）。 |
| [context-service.ts](src/context-service.ts) | 上下文精简偏好（RPC 与 agent 工具共用）。 |
| `client.js` | 设置页（浏览器模块，非 tsc 产物）。 |

术语：**免费档**＝向官方客户端提供的无 key 模型集合；**门禁**＝上游判断是否服务非官方客户端的检查；**占位声明**＝调用方没有任何工具时才发的一个工具；**净化名**＝去掉分隔符的线上工具名，返回时映射回真实名；**出口**＝一条通往上游的路线（`direct` 或代理）。

## 2. 客户端伪装

按请求的组成分三节：头与会话信息、请求体与工具声明、传输层。每节先写插件具体怎么做，再交代为什么。每处标明三类之一：**【检测】**目前网关会检查，不匹配即被拒；**【预防】**目前不检查，复刻只为将来可能出现的检测；**【用户自由】**内容交给用户决定，网关无法通过其检测，故不模仿。

### 2.1 请求头与会话信息

桥接负责生成这些信息：

| 头 | 值 | 类别 |
|---|---|---|
| `user-agent` | `opencode/latest/2.2.0/cli`，逐字发送 | 【检测】 |
| `x-opencode-session-id` | 当前会话的线上 ID | 【检测】会话头形态 |
| `x-opencode-session` / `x-session-affinity` / `x-session-id` | 子会话用直接父会话的线上 ID；有来源记录的普通分叉用来源会话的线上 ID；其余用自己的 ID | 普通会话形态已实测；父子差异来自本地对照 |
| `x-opencode-parent-session-id` / `x-parent-session-id` | 仅在 DSH 确认直接父会话的子代理请求中发送，值相同 | 本地已验证，未确认网关是否检查 |
| `x-opencode-client` | `cli` | 【检测】形态 |
| `authorization` | `Bearer public`（未登录哨兵） | 【检测】形态 |
| `x-opencode-project` | 按真实目录推导（见下） | 【预防】值不被校验 |
| `b3` / `traceparent` | 每次请求生成；`tracing:false` 可关 | 【预防】官方默认不发 |
| `content-type` / `accept` / `accept-encoding` | `application/json` / `*/*` / `gzip, deflate, br, zstd` | 【预防】 |
| `x-opencode-request` | 不发送（2.x 不含；1.x 中继设 `requestIdHeader:true`） | — |

桥接从 DSH 的会话头读取直接父会话与子代理标记，用同一份映射为父子各分配线上 ID，不发送 DSH 本地 ID。缺少可信的父子关系时，不补父会话头。本地用 OpenCode v2.3.0 验证了这套父子关系；当时官方免费模型的单请求已返回 429，因此没有验证这些头是否影响线上限额。

`host`、`content-length`、`connection` 由传输层写入（§2.3）。

会话 id 复刻 CLI 编码：`ses_` + 48 位时间字段（降序 `~(ms*0x1000+counter)`，小计数器）+ 14 位 base62。`x-opencode-project` 与抓包验证的官方规则一致：Git 检出→`sha1("git-remote:"+规范化远端)`；其它→`sha1("directory:"+真实路径)`（[project-identity.ts](src/project-identity.ts)）。

为什么：网关把 UA 与会话头当作客户端身份来比对，缺或错即拒。带版本号的外部产品标记（如`deepseek-harness/<n>`）会被拒，所以 DSH 署名默认关闭（`userAgentAttribution` 可开）。project 的具体值不被校验，推导只为与官方一致；追踪头官方仅在 OTEL 开启时发，桥接早期按抓包默认 mint 一对，属「多加」，可关 `tracing` 贴近默认。

### 2.2 请求体、系统提示与工具声明

发出去的请求体由这些部分组成（键序与官方一致）：

```jsonc
{
  "model": "...",
  "messages": [...],
  "tools": [...],                 // 调用方工具；一个都没有时放一个占位
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_completion_tokens": 32000  // 恒发，目录默认；调用方可覆盖
}
```

不发 `tool_choice` 与 `prompt_cache_key`（抓包客户端两者皆无）；`temperature`/`stop`/`reasoning_effort`有则转发。【预防】恒发输出上限、键序等目前不被检查，对齐只为预防（对照见`docs/evidence/tools-field-and-token-budget-2026-11-14.json`）。

**系统提示**：单条 `system` 消息＝DSH 提示 + 环境指令，用 `\n` 连接。【检测】必须含 `<env>` 块：仅含该块的 177 字节提示可过，去掉被拒（`docs/evidence/bun-env-hypothesis.json`）。【用户自由】块里的值不被校验，改写路径、翻转 git 标志仍过（`docs/evidence/bun-env-strictness.json`）；插件仍按真实目录生成使信息有用。【预防】官方的日期行（会话内冻结）、引导句、第 5 行（tmp 偏好）、worktree 根/向上 git 推导、多轮`<system-update>` 都不被检查，桥接照抄当保险。官方 harness 原文与 Code Mode 目录不需要——合成目录同样过（`docs/evidence/bun-synthetic-catalog.json`）。

**工具声明**：【用户自由】清单内容不标识客户端（用户可经官方客户端发任意清单与提示，见`docs/evidence/user-customization-round2-2026-11-13.json`、`user-add-tools-2026-11-13.json`），故只声明调用方自己的工具。但形态有三条【检测】要求：

1. **至少一个工具。** 空清单被拒；名称任意（`dsh_probe_tool` 也过，`docs/evidence/bun-tool-minimum.json`、`any-tool-vs-read.json`）。调用方工具即可满足；一个都没有时 `planTools` 补占位，描述劝阻调用，误调则丢弃。
2. **名称形状。** 未识别名含下划线/连字符/点/大写被拒；网关认识的名可带分隔符；至少一个认识的名。`planTools` 净化为 `[a-z0-9]`（冲突加序号）并保留回映射。这是 1.0.4 前全被拒的原因（报错似配额耗尽）。
3. **不能一次声明大量富工具。** 真实描述与复杂 schema 各自触发拒绝（`docs/evidence/tool-gate-codemode-2026-11-17.json`）。

**Code Mode** 让线上工具列表保持精简：简单锚点不可调用；`execute` 和本步准入的 `subagent` 可直接调用。和 OpenCode v2.3.0 一样，子代理工具不放进 SDK。其他已准入的工具用 DSH 的 SDK 渲染器写进系统提示，保留真实返回类型（如 `read` 返回 `{lines,totalLines}`）。`subagent` 用 DSH 提供的参数，桥接不冒充官方工具执行器。执行与权限见 §5。

### 2.3 TLS 与 HTTP 传输

传输层负责把握手与头形态做成官方的样子。【预防】截至 2026-11-17 门禁不检测这一层；复刻只为将来若出现指纹检查时无法区分。

官方客户端跑在 Bun 上，Node 的 TLS 表达不出同样的 `ClientHello`（OpenSSL 自排扩展、无后量子 key share，hello 约 274 字节 vs 官方 1482）。[bun-transport.ts](src/bun-transport.ts) 把握手交给 `wreq-js`（Rust+BoringSSL，与官方同库），参数取自抓包，需四处修正：

| 修正 | 细节 |
|---|---|
| `curvesList` | 去掉多余 `MLKEM768` 组；只留 `X25519MLKEM768:X25519:P-256:P-384`。 |
| `sigalgsList` | `0x0807` 是 ed25519、`0x0603` 写作 `ECDSA+SHA512`，凑齐抓包 11 项。 |
| 头大小写 | `Authorization`/`Content-Type`/`User-Agent`/`Connection`/`Accept`/`Host`/`Accept-Encoding`/`Content-Length` 按抓包大写。 |
| 头位置 | `Host`/`Accept-Encoding`/`Content-Length` 显式提供，落在第 14–16 位。 |

修正后 `ClientHello` 扩展零差异、1482 字节。请求**头**文本（动态值归一化后）除 `x-opencode-project` 外与抓包一致；这是头形态比对，不是整请求逐字节比对（两条记录全文 23,073 与 951 字节，正文不同）（`docs/evidence/clienthello-deep-2026-11-13.json`、`byte-exact-2026-11-13.json`）。持久 Transport 跨轮次复用连接；只 offer `http/1.1`，无 `h2`。

**回退**：`wreq-js` 是可选依赖；缺原生绑定或 `bunTransport:false` 时回退普通 `fetch`，失去 TLS 对齐但仍工作（某些代理下普通 fetch 根本连不上，故传输价值不止指纹）。运行时不是门禁差异来源：零工具请求体在Bun 与 Node 下都被拒为 `FreeUsageLimitError`（`docs/evidence/bun-runtime-test.json`，两条记录）。

## 3. 模型目录

[catalog.ts](src/catalog.ts) 读官方稳定版 v1 目录 `https://models.opencode.ai/api.json`，取 `opencode`提供者下成本为 0、非 `deprecated` 的模型。官方 v2.3.0 读同服务的 v2 目录并带缓存/内置快照；两者同源，插件尚未迁移 v2。

| 项 | 值 |
|---|---|
| 刷新 | 5 分钟（官方 TTL）；`modelRefreshIntervalMs:0` 关轮询，保留启动预取与按需缓存 |
| 失败 | 保留上一份快照，60s 重试；快照原子提交，`onUpdated` 仅内容变化时触发 |

不再探测 `/models`：2026-11-15 实测目录与实时可用集完全一致，探测无增量信息，且是官方从不发的请求形态。目录还携带 `interleaved.field`（reasoning 回放字段，§2.2/§4）与 `limit.output`（输出上限）。

## 4. 消息与附件

消息映射（DSH → 线上）：

| DSH | 线上 |
|---|---|
| `options.system` / `role:system` | 并入首条 `system`（§2.2） |
| `role:developer` | 丢弃——工具变更已体现在 `options.tools` |
| `role:tool` | `{role:tool, tool_call_id, content}`；空结果发 `''` |
| `role:assistant` | `content` 文本用 `''` 拼接；仅「有工具调用且无文本」时为 `null`；`reasoning_content` 在存在思考或模型需要时发送 |
| 用户内容 | 视觉路由按序保留 text/`image_url` |

**思考回放**：目录声明 reasoning 字段（如 big-pickle）时每条 assistant 行回放该字段（无思考发空串）。可选精简（`trimCompletedReasoning`）只移除已完成轮次的思考，经消息 id + SHA-256 校验；进行中/失败/中断一律保留；仅影响新请求，不删本地历史。

**图片**：[image-input.ts](src/image-input.ts) 只用公开附件接口，不猜存储路径；仅声明 `image` 输入的路由读字节。预算默认 4 MP、单图 1 MiB、总 20 MiB、20 次出现；超预算返回 `IMAGE_OFFLOAD_REQUIRED`，不静默丢。工具结果图片在连续 tool-result 组之后作为一条关联 user 消息上提。

## 5. 工具执行

模型发起调用后，执行与权限都在 DSH，桥接不另设一套流程。

- 返回的调用保留 id、名称与原始参数字节；查找与 schema 校验由 DSH 负责。整批缓冲至`finish_reason:tool_calls`；被截断的批次返回 `TOOL_BRIDGE_INCOMPLETE`，不派发任何调用。
- `subagent` 的直接调用交给 DSH 原有工具处理，模型选择、权限和结果回传仍由 DSH 管理。`execute` 仅借用当前步骤的工具视图，并从嵌套调用中移除 `subagent` 与 `execute`；不修改 DSH 的注册或外层工具集。
- 适配器丢弃占位工具调用。在 Code Mode 下，也会丢弃锚点和未准入的直接调用，并记录 `warn`。
- **Code Mode 的执行侧**：`execute` 是注册的普通工具，执行体委托一个 `PtcExecutor` 实例跑 `run_code`，复用 DSH 原生 PTC 的沙箱运行时与受防护的嵌套分发；嵌套工具调用仍走 DSH 的权限与派发。DSH 的 `run_code`是执行器私有、不可注册，故用 `execute` 承载。仅免费路由且准入 `execute` 时启用；宿主无 PTC 退回直接声明。行为更接近 DSH 的 PTC 模式。已端到端验证简单应答、四步读写、六步含并行与 `edit` 的复杂任务（`docs/evidence/codemode-complex-test-2026-11-17.json`）。已知边界：SDK 以 TypeScript 类型渲染参数，表达不了 `read` 的 `limit<=2000` 数值上限，模型可能先猜大值被拒后改对（与原生 PTC 渲染一致）。

## 6. 错误处理与诊断

- **流式**：增量解析 SSE；输出开始后的流失败不重放（`PARTIAL_STREAM_ERROR`）。
- **免费额度拒绝**：429 且 `FreeUsageLimitError` → `FREE_USAGE_LIMIT`，本轮结束，不自动重试、不传重试等待；原始 `Retry-After` 仅留诊断。
- **等待范围**：新请求不继承上一轮按模型等待；不维护内存模型锁、不写冷却文件；升级清空旧文件。
- **临时限流**：重试由 DSH 调度（最多 2 次、初始 2s、抖动 0.2）；可重试等待上限 15 分钟，原始值留诊断。
- **清除冷却**：同一 RPC 同步清空出口池等待、退避计数与旧冷却文件，不需重启。
- **取消**：POST 前、缓冲后、每个工具块前检查。

依据官方 v2.3.0 错误分类与 ModelRetry：额度拒绝默认不重试，仅临时限流/内部错误用重试等待且上限 15 分钟。官方通用重试预算 10 次，本插件保留 DSH 的 2 次；对齐的是额度处理与等待范围，不是替换宿主重试循环。

上游变化时的对照表：

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `403 FreeTierError` | 身份形态被拒 | 查 UA、会话头、至少一个工具、`<env>` 块（§2）。 |
| `429 FreeUsageLimitError` | 免费通道拒绝或真实配额 | 同出口/同模型/相近时间对照；错误名不能确认 IP 配额。 |
| `400 MissingSessionID` | 缺会话头 | 会话生成失效。 |
| 端点 `404`/`426` | 路由迁移 | 重读目录 `provider.api`。 |
| 目录为空 | 目录请求失败 | 查日志；上一份快照仍保留。 |

**诊断**：失败请求默认追加 `request shape` 与 `tool schema shape` 摘要，共享 `request` 标识；成功摘要仅`debug` 级记录。摘要只含元数据（路径、传输、字节数、角色/长度、环境块数、图片数、工具配对计数、schema结构统计），不写正文、参数、结果、图片、密钥；上限 8 MiB/512 消息/128 工具/8192 节点/深度 32，超限标`capped`。`transport:configured` 仅表示设置了专用传输，不单独证明 TLS 字节一致。

**日志轮转**：写入前检查文件大小；默认每份最多 512 KiB，最多保留 5 份（含正在写入的文件），满了先丢最旧的一份。启动时和运行期间每小时清理一次，按记录时间删除超过 7 天的日志；若一个文件里新旧混存，只删过期记录。已超大小上限的文件只保留末尾能放下的完整记录。磁盘写入或轮转失败时，不继续撑大原文件，失败的记录暂存于内存。

**安全与隐私**：除配置 `apiKey` 外不读凭据；代理 URL 全日志/UI 脱敏；图片数据任何级别不入日志（测试保证）；不新增 `exec`/`spawn`。

## 7. 配置

| 键 | 默认 | 用途 |
|---|---|---|
| `baseUrl` | `https://opencode.ai/inference/v1` | relay 基址 |
| `apiKey` | `public` | 未登录哨兵 |
| `userAgent` | `opencode/latest/2.2.0/cli` | 身份 UA |
| `userAgentAttribution` | `false` | 追加 DSH 署名 |
| `client` | `cli` | `x-opencode-client` |
| `requestIdHeader` | `false` | 发 `x-opencode-request`（1.x） |
| `tracing` | `true` | 发 `b3`/`traceparent` |
| `bunTransport` | `true` | 可用时用 Bun 形态 TLS |
| `toolStrict` | `true` | 工具加 `strict:false` |
| `minOutputTokens` | `32000` | 输出上限下限 |
| `project` / `projectDirectory` | `global` / `''` | 显式 project / 推导目录 |
| `providers` | `['opencode-bridge']` | 服务的 provider 路由 |
| `includeDeprecated` / `extraModels` | `false` / `[]` | 目录过滤/追加 |
| `requestTimeoutMs` | `600000` | 单请求截止 |
| `modelRefreshIntervalMs` | `300000` | 目录刷新；0 关轮询 |
| `trimCompletedReasoning` | `false` | 上下文精简 |
| `toolResultImages` | `true` | 视觉路由转发工具图片 |
| `requestImagePixelBudget` / `requestImageMaxBytes` / `maxRequestImageBytes` / `maxRequestImages` | `4194304`/`1048576`/`20971520`/`20` | 图片预算 |
| `proxies` / `proxyCooldownMs` / `proxyStorePath` | `[]`/`60000`/`''` | 出口池 |
| `logLevel` / `logDir` | `warn`/`''` | 最低日志级别 / 日志目录（空值用默认目录） |
| `logMaxBytes` / `logMaxFiles` | `524288`/`5` | 每份日志的字节上限 / 保留份数（含当前文件） |
| `logMaxAgeDays` | `7` | 保留天数；`0` 仅关闭按时间清理，大小轮转照常 |

## 8. 测试

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json   # 构建
node --test tests/*.test.mjs                            # 全量离线
```

全部离线；`tests/*-live.mjs` 实测探针需显式 `--run`，且拒绝覆盖既有报告。

| 套件 | 覆盖 |
|---|---|
| `current-protocol`/`alignment`/`gateway-requirements`/`official-fidelity` | 线上形态、头、工具声明、`<env>`、占位、预防伪装 |
| `bun-transport` | 抓包加密套件/扩展配置 |
| `bridge-integration`/`bridge-stream` | 批次原子性、流式组装 |
| `reasoning-*` | 回放、精简资格 |
| `image-*`/`vision-*` | 附件投影、预算、工具图片上提 |
| `retry-integration`/`proxy-rotation` | 服务端等待、池冷却、不重放 |
| `project-identity`/`request-waits`/`official-cooldown-policy` | 身份推导、旧状态清理、即时清除 |
| `catalog-*`/`log-*`/`client-boot`/`references`/`evidence-links` | 目录、脱敏、设置页、致谢与证据一致 |

实时探针（消耗真实配额）：`smoke`、`tool-loop-live`（一次三轮会话 10 项检查，`docs/evidence/tool-loop-live-2026-11-14.json`）、`proxy-live`、`vision-compat-live`、`reasoning-*`、`wire-dump`、`official-client-ab-live`（同机同模型对照官方 CLI，`docs/evidence/official-client-comparison-2026-11-17.json`：7/52 合成工具、52 工具+60 KB 提示、最大约 72 KB）。离线全绿也可能全被网关拒（1.0.4 前 418 项离线绿但真实请求全拒），故形态问题必须靠实测发现。

## 9. 文档维护规则

- 本文件与[英文版](TECHNICAL.us.md)同步修改；用户可见功能、协议原则、已记录常量、构建/发布流程或版本号变化须同改两份。版本号还须同步 README 中英安装命令，使其与 `package.json` 的 `version` 一致（`tests/readme-version.test.mjs` 校验）。
- **插件逻辑变化时必须同步更新本技术文档**（中英两份），并通读全文，保证上下文通顺、结构清晰、无歧义；不能只改局部而留下前后矛盾。
- 插件的每次变更（功能、修复、协议、文档）都记录在独立更新日志（[CHANGELOG.md](CHANGELOG.md)/[CHANGELOG.us.md](CHANGELOG.us.md)），本文不另设变更记录。
- 参考新项目时同步更新 [README 致谢](README.md#参考与致谢)与本文 §10。
- 证据两条规则（`tests/evidence-links.test.mjs` 强制）：引用的每个文件必须随仓库发布（抓包放[`docs/evidence/`](docs/evidence/README.md)）；绝不提及未发布内容。

**重新推导某个常量**：本文的常量（UA、头、工具形态、TLS 参数等）都是有日期的观测。当上游变化使某个常量不再成立时，按以下步骤重新测量，而不是凭猜修改：

1. 用已安装的官方客户端抓包：走本机回环端点、隔离配置、本地假模型，记录请求头、请求体与 TLS `ClientHello`。
2. 与 `buildHeaders`/`buildChatMessages`/`BUN_TLS_EMULATION` 的当前值对比。
3. 只改与抓包矛盾之处，且按抓包所指方向改。
4. 在 `tests/` 新增或更新固定该值的断言。
5. 同步本文与英文版，并记入 CHANGELOG。

## 10. 参考的社区项目

协议行为全部来自对官方客户端的实测，不依赖任何社区项目的结论。下列项目只用于设计阶段对照，**没有复制它们的代码。**

| 项目 | 关系 | 许可 |
|---|---|---|
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | 同类适配器，对照工具补缺与配置 | MIT |
| [x5427876/dsh-opencode-free](https://github.com/x5427876/dsh-opencode-free) | 同类适配器，对照别名与调用阻断 | MIT |
| [DragonHorizon-xtihc/dsh-connect-opencode-free](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free) | 同类适配器，对照占位抑制 | MIT |
| [1624318455/dsh-plugin-adapter](https://github.com/1624318455/dsh-plugin-adapter) | 同类适配器，较早工具补缺 | MIT |
| [randomix777/dsh-opencode-zen](https://github.com/randomix777/dsh-opencode-zen) | 同类适配器，对照目录刷新与缓存 | MIT |
| [seonzzy/dsh-zen-adapter](https://github.com/seonzzy/dsh-zen-adapter) | 同类适配器，对照目录发现 | MIT |
| [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) | 只读其 issue 中免费额度随出口 IP 衰减的记录 | GPL-3.0 |

opencode2api 是 GPL-3.0；只读过 issue，没有使用其代码，不受该许可约束；以后若引用代码须重新评估兼容性。本节与 README 同名章节是同一份清单，两处必须同时更新。

