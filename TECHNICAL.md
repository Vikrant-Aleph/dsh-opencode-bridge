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
每次变更记录在独立的更新日志（[CHANGELOG.md](CHANGELOG.md)，英文 [CHANGELOG.us.md](CHANGELOG.us.md)）。代码已改而文档滞后不可接受。

**参考新项目时同步更新清单。** 阅读或对照了别的项目后，在同一改动里补进
[README 的「参考与致谢」](README.md#参考与致谢)与本文 §12。只读过源码做对照、没有复制代码的，
如实写成对照关系；用到代码或结论时写清出处与许可。

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

1. **只伪装网关真正会检查的部分。** 见[伪装原则](CAMOUFLAGE.md)。
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

其余模块：

| 模块 | 职责 |
|---|---|
| `src/catalog.ts` | 免费模型发现：读官方模型目录，含 TTL 与重试。 |
| `src/project-identity.ts` | 按真实目录推导官方 `x-opencode-project`。 |
| `src/request-waits.ts` | 兼容并清理旧版冷却文件；当前请求不读取或写入按模型等待。 |
| `src/http-errors.ts` | 上游错误分类；安全、有界的诊断信息。 |
| `src/retry-after.ts` | 严格解析 `Retry-After`（毫秒、秒、HTTP-date）。 |
| `src/reasoning-policy.ts` | 仅 Host 侧的已完成轮次思考投影，供可选精简使用。 |
| `src/context-service.ts` | 上下文精简偏好（RPC 与 agent 工具共用同一操作）。 |
| `src/logger.ts`, `log-service.ts` | 分级、脱敏的诊断日志。 |
| [request-diagnostics.ts](src/request-diagnostics.ts) | 有界、无内容的真实请求结构摘要。 |
| `src/proxy-service.ts` | 设置页使用的出口池编辑与探测。 |
| `client.js` | 设置页（浏览器模块，非 tsc 产物）。 |

## 3. 实测到的门禁

**「目前」的口径：2026-11-17** —— 最后一次对免费通道做活体探针的日期（本文更新于 2026-11-18）。
下文的「检测 / 不检测」均以该日为准，是带日期的观测，不是规范（§8 说明如何重新推导）。

伪装手段分成两大块：

**A. 目前被检测的形态（不匹配即被拒，必须复刻）**
User-Agent（§3.1）、会话与请求身份（§3.2）、工具声明形态（§3.3）、系统提示含 `<env>` 块（§3.4）。

**B. 目前不被检测、仅为预防未来特征检测（复刻但非必需）**
传输层 TLS 指纹 / 头名称大小写与顺序 / 连接复用（§3.5），以及一批官方恒发的保真细节（§3.7）：
日期行、`<env>` 引导句与第 5 行、env 取值推导、多轮 `<system-update>`、恒发
`max_completion_tokens`、目录 reasoning 字段回放、body 键序等。这些在 2026-11-17 的探针里
都**不是**过闸条件；复刻它们只为将来网关若开始逐项比对时不被识别。

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

### 3.3 工具声明

工具清单的**内容**不标识客户端：用户可以借助官方客户端本身发出任意工具清单与系统提示
（`agents.<name>.system`、`agents/<name>.md` 可完全替换系统提示；不带工具的自定义 agent 可把
工具清单从 12 个降到 1 个；插件可注册任意名称与 schema 的工具。见
`docs/evidence/user-customization-round2-2026-11-13.json`、`docs/evidence/user-add-tools-2026-11-13.json`）。
早期版本曾注入 OpenCode 内置工具清单、并把冲突的调用方工具改名为 `*_client`，该前提已被上述实验推翻；
现在桥接只声明调用方自己的工具。这也是原则按「是否被检查」而非「是否可配置」表述的原因。

但「内容任意」不等于「形态任意」。工具声明有三条门禁要求：

**至少声明一个工具。** 空清单被拒（`FreeUsageLimitError`）。名称任意——社区流传的「必须有名为
`read` 的工具」未能复现：同一运行时下只改工具数组，一个名为 `dsh_probe_tool` 的工具同样通过
（`docs/evidence/bun-tool-minimum.json`、`docs/evidence/any-tool-vs-read.json`）。调用方自己的
工具即可满足；`planTools` 仅在调用方一个工具都没有时才补占位声明，其描述明确劝阻调用，万一仍被调用
则**丢弃**（记 `warn`），该轮正常结束。正常流量里因此不会出现 DSH 无法执行的工具。

**名称形状。** 未识别的名称含下划线、连字符、点号或大写会被拒；网关认识的名称可带分隔符
（`web_search` 按 `websearch` 通过）。声明中至少要有一个网关认识的名称：纯自造名称即使无分隔符也被拒。
这项要求 2026-11-14 才定位，是 1.0.4 之前所有请求被拒的原因——网关返回的 `FreeUsageLimitError`
与配额耗尽外观一致，长期被当成限流。实测对照：

| 请求体 | 工具名 | 结果 |
|---|---|---|
| 完整 UI 请求（46 工具、69 KB） | 原名（含下划线） | 429 |
| 同一请求体 | 去掉分隔符（`askuserquestion`） | **200** |
| 6 个极小工具 | `job_list`、`web_search`… | 429 |
| 同样 6 个对象 | `pwsh`、`read`、`glob`… | 200 |

官方客户端的 12 个工具全部无分隔符（`edit`、`glob`、`grep`、`question`、`read`、`shell`、
`skill`、`subagent`、`webfetch`、`websearch`、`write`、`execute`）。`planTools` 因此把每个名称
净化为 `[a-z0-9]`（冲突时追加序号），保留「净化名 → 真实名」映射，模型返回调用时还原，DSH 派发不受影响。

**不能一次声明大量富工具。** 真实描述文本与复杂 schema 各自都会触发 `FreeUsageLimitError`；
同尺寸的中性工具块可过，真实工具块被拒（`docs/evidence/tool-gate-codemode-2026-11-17.json`）。
官方客户端用 Code Mode 规避，桥接对免费模型路由同样采用（§5.3）。

### 3.4 系统提示

系统提示必须含 `<env>` 块：仅含该块的 177 字节提示即可通过，去掉该块被拒
（`docs/evidence/bun-env-hypothesis.json`）。`<env>` 的值不被校验：改写路径或翻转 git 标志仍能通过
（`docs/evidence/bun-env-strictness.json`）。插件仍按真实工作目录生成，使块内信息对模型有用。
官方 harness 原文与 Code Mode 目录**不**需要——用 DSH 自己工具合成的目录同样通过
（`docs/evidence/bun-synthetic-catalog.json`）。

注意：被检测的只是「`<env>` 块存在」这一形态。官方的日期行、引导句、第 5 行、worktree/git 推导与
多轮 `<system-update>` 都**不被检测**，属预防性保真，见 §3.7。

### 3.5 传输层（目前不检测，仅预防）

**截至 2026-11-17，门禁不检测这一层。** 复刻官方 `ClientHello` 是为了应对将来可能出现的指纹检查，
让流量在 TLS 层面无法区分于官方客户端；现状是已逐字节对齐，但未被证明必需。

官方客户端运行在 Bun 上。Node 的 TLS 表达不出同样的 `ClientHello`：OpenSSL 自行排列
扩展顺序，也不提供后量子 key share。实测 Node 的 `tls`/`tls-impersonate` 路径扩展顺序不同，
Hello 约 274 字节，官方是 1482。

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
运行时本身也不是门禁差异来源：Bun 1.4.4 用零工具请求体同样被拒
（`docs/evidence/bun-runtime-test.json`）。

### 3.6 与官方编码器的字段级差异

逐行读过官方 OpenAI Chat 编码器（`openai-chat.ts`）后，与官方的差异分成两类。

**门禁相关（必须保留）**：

| 差异 | 官方做法 | 桥接做法 | 实测 |
|---|---|---|---|
| `tools` 为空时 | 省略整个字段 | 补一个 `read` 占位声明 | **省略会被拒（429）**，占位是必需的 |

官方客户端的 `Generate.text`（标题生成）确实发不含 `tools` 的请求体，而这类请求会被网关拒绝——
只是标题失败是静默的，所以从未被发现。

**保真相关（目前不检测，已按官方复刻，见 §3.7）**：`max_completion_tokens` 恒发、system 拼接、
日期/引导句/第 5 行、reasoning 回放、键序等。这些在 2026-11-14 的对照里都**不是**过闸条件
（`docs/evidence/tools-field-and-token-budget-2026-11-14.json`），对齐只为预防未来检测。

其余字段均已对齐：`store` 与 `prompt_cache_key` 都不发（官方仅在 provider 声明支持时发送），
`temperature`、`stop`、`reasoning_effort` 有则转发，助手消息的 `content: null`、`tool_calls` 形状与官方一致。

适配器把环境指令追加在 DSH 提示**之后**，与官方客户端的位置一致，使 agent 自身的指令仍然主导。
两者到位后，适配器自身路径可稳定返回 200（`docs/evidence/verify-env-fix.json`、`docs/evidence/placeholder-verify.json`）。

### 3.7 预防性保真清单（目前不检测，仅防未来）

以下都是官方客户端恒发、但截至 2026-11-17 **不被门禁检测**的特征。桥接已按源码复刻
（`anomalyco/opencode`，v2.2.0 交叉验证），目的仅是将来网关若开始逐项比对时不被识别：

| 特征 | 官方做法 | 源码位置 |
|---|---|---|
| 日期行 | 系统提示恒含 `Today's date: <会话启动日期>`，会话内冻结 | `instructions/builtins.ts` |
| `<env>` 引导句 | 块前有 `Here is some useful information about the environment you are running in:` | 同上 |
| `<env>` 第 5 行 | `Prefer <tmp>/opencode over …/tmp…` | 同上 |
| env 取值推导 | `Workspace root folder`=git worktree 根；git 标志=向上查找 `.git` | `location.ts`/`project.ts` |
| 多轮变化 | 日期/环境变化以 `<system-update>` user 消息插入，基线不重拼 | `instruction-state.ts`/`openai-chat.ts` |
| 输出上限 | primary 请求恒发 `max_completion_tokens`（目录默认 32000） | `model-request.ts` |
| reasoning 回放 | 目录声明 reasoning 字段（如 big-pickle）时每条 assistant 消息回放空串 | `openai-chat.ts` |
| body 键序 | `model, messages, tools, stream, stream_options, max_completion_tokens` | `openai-chat.ts` |
| 传输层 | TLS ClientHello、头大小写/顺序、连接复用、http/1.1 | §3.5 |
| 追踪头 | `b3`/`traceparent` 仅 OTEL 开启时发，默认**不发** | effect/http |

注意 `b3`/`traceparent` 不是官方默认行为：它们由 `OTEL_EXPORTER_OTLP_ENDPOINT` 开关，默认客户端
两个都不发。桥接早期按抓包默认 mint 一对，属于「多加」；如要贴近默认官方行为可关闭 `tracing`。

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
- **免费额度拒绝**：HTTP 429 且类型为 `FreeUsageLimitError` 时返回 `FREE_USAGE_LIMIT`。本轮结束，不自动重试，不向宿主传递重试等待。原始 `Retry-After` 仅保留在诊断中。
- **等待范围**：新请求不继承上一轮的按模型等待。适配器不再维护内存模型锁，也不写入模型冷却文件；升级时清空旧文件，且不从日志恢复冷却。
- **临时限流**：重试由 DSH 调度（最多 2 次、初始 2s、抖动 0.2）。可重试响应的等待上限为 15 分钟，原始值保留在诊断中。等待不跨手动请求保存。
- **清除冷却**：同一个 RPC 同步清空当前出口池的等待、失败退避计数及旧版模型冷却文件，不替换出口条目，不需要重启。

依据官方 v2.3.0 的 [错误分类](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/ai/src/provider-error.ts)与
[ModelRetry](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/model-retry.ts)：额度拒绝默认不自动重试，
只有临时限流和提供方内部错误会使用重试等待，且最多接受 15 分钟。
官方 CLI 的通用重试预算是 10 次；本插件保留通过 DSH 执行的 2 次预算。本次对齐的是额度错误处理、等待范围和等待上限，不是替换宿主的整个重试循环。

2026-11-17 已用旧版适配器复现清空失效：存储已返回 0，适配器仍从另一份内存 Map 返回 `REQUEST_COOLING`，没有发送下一次请求。
移除这份跨请求状态后，回归测试覆盖同一实例清除、旧文件迁移和再次发送。
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

### 5.3 Code Mode（免费模型的工具声明）

为满足 §3.3 的「不能一次声明大量富工具」门禁，免费模型路由采用 Code Mode，与官方客户端一致：
线上只保留少量工具，完整目录进系统提示词，经一个代码执行入口间接调用。

[code-mode.ts](src/code-mode.ts) 的具体形状：

- 线上只声明几个简单锚点工具（`read`/`write`/`edit` 等认识的名字、平凡 schema）加 `execute`。
  锚点只为满足网关的形状检查，模型被明确告知不要直接调用；误调会被适配器丢弃。
- 真实工具目录用 DSH 的 `renderToolsSdk` 渲染进系统提示词，并附"只能直接调 `execute`"的指令。
  目录带每个工具真实的返回 schema（如 `read` 返回 `{lines,totalLines}`、`glob` 返回 `{root,paths}`），
  模型按类型解析返回，不用猜结构。
- `execute` 是注册的普通工具，其执行体委托一个 `PtcExecutor` 实例跑 `run_code`，复用 DSH 原生
  PTC 的沙箱运行时与受防护的嵌套分发。DSH 的 `run_code` 是执行器私有、不可注册，故用 `execute` 承载。
- 仅当该步准入 `execute`（免费模型路由）时启用；其他 agent 的执行器与工具声明不变。

行为更接近 DSH 的 PTC 模式。宿主无 PTC 运行时时自动退回直接声明。

已在真实免费模型会话端到端验证：简单应答、四步读写任务、以及含并行读取与 `edit` 追加的六步复杂任务
都正确完成（见 [复杂任务记录](docs/evidence/codemode-complex-test-2026-11-17.json)）。一个已知边界：
SDK 用 TypeScript 类型渲染参数，表达不了 `read` 的 `limit<=2000` 这类数值上限，模型可能先猜大值、
被工具拒绝后再改对；这与 DSH 原生 PTC 的渲染一致。

## 6. 模型目录

[catalog.ts](src/catalog.ts) 只读稳定版 v1 目录 `https://models.opencode.ai/api.json`，取其中 `opencode` 提供者下成本为 0 的模型，排除 `status: deprecated`。
官方 v2.3.0 的 [ModelsDev](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/models-dev.ts) 默认读取同一服务的
`/experimental/v2.0/api.json?type=chat,decision,image`，并使用缓存与内置快照。
两者同源，但读取路径和缓存层并非完全一致；插件目前尚未迁移到 v2 目录。

| 项 | 值 | 依据 |
|---|---|---|
| 数据源 | 单一，官方稳定版 v1 目录 | 与官方客户端同源，API 版本不同 |
| 刷新间隔 | 5 分钟，与官方 TTL 一致 | `Duration.minutes(5)` |
| 失败处理 | 保留上一份快照，60s 后重试 | 与官方退回缓存同效 |

**为什么不再探测 `/models`。** 早期版本把目录与一次实时 `/models` 请求取交集，用来判断
「哪些模型现在真的可用」。2026-11-15 实测显示这一步没有增加任何信息：目录中成本为 0 且未弃用的
12 个模型，与 `/models` 返回的可用集完全一致（「目录有、线上没有」为 0），而 `/models` 另外
返回的 74 个都是付费模型。可用性信号本来就在目录的 `status` 字段里，因此这次探测被删除——
它也是官方客户端从不发出的请求形态。

快照原子提交，`onUpdated` 只在内容真正变化时触发。`modelRefreshIntervalMs: 0` 关闭周期刷新，
但保留启动预取与按需缓存。

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
| `modelRefreshIntervalMs` | `300000` | 目录刷新；`0` 关闭轮询。 |
| `trimCompletedReasoning` | `false`（live） | 设置 → 上下文精简。 |
| `toolResultImages` | `true` | 视觉路由转发工具输出图片。 |
| `requestImagePixelBudget` | `4194304` | 请求图片像素。 |
| `requestImageMaxBytes` | `1048576` | 单图编码字节目标。 |
| `maxRequestImageBytes` | `20971520` | base64 总预算。 |
| `maxRequestImages` | `20` | 保留的图片出现次数。 |
| `proxies` | `[]` | 出口池，按顺序。 |
| `proxyCooldownMs` | `60000` | 可选出口池的本地兜底冷却；免费额度拒绝不启动它。 |
| `proxyStorePath` | `''` | 设置页拥有的池存储。 |
| `logLevel` | `warn` | `debug`\|`info`\|`warn`\|`error`\|`off`。 |
| `logDir` | `''` | 默认使用 profile 日志目录。 |
| `logMaxBytes` / `logMaxFiles` | `524288` / `5` | 轮转。 |

## 8. 上游变化时

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `403 FreeTierError` | 身份形态被拒 | 检查 UA、会话头、是否至少声明了一个工具、以及 `<env>` 块是否存在（§3）。 |
| `429 FreeUsageLimitError` | 免费通道拒绝或真实配额 | 读取请求摘要，在同出口、同模型、相近时间对照实际结果；错误名不能确认 IP 配额原因。 |
| `400 MissingSessionID` | 缺少会话头 | 会话生成失效。 |
| 端点 `404`/`426` | 路由迁移 | 重读目录的 `provider.api`。 |
| 目录为空 | 目录请求失败 | 查日志；上一份快照仍被保留。 |

重新推导某个常量：

1. 用**已安装的官方客户端**抓包，走本机回环端点（不要靠猜）：`--standalone`、
   隔离配置、本地假模型，然后记录头、请求体与 TLS `ClientHello`。
2. 与 `buildHeaders`/`buildChatMessages`/`BUN_TLS_EMULATION` 对比。
3. 只改抓包与之矛盾之处，且只按抓包所指方向改。
4. 在 `tests/` 中新增或更新固定该值的断言。
5. 在更新日志（CHANGELOG）记录本次变更。

### 8.1 请求结构摘要

失败请求默认追加 `request shape` 和 `tool schema shape` 两条摘要，与错误行共享 `request` 标识。
成功请求的摘要仅在写入级别为 `debug` 时记录；`off` 关闭日志。面板的“显示最低级别”只筛选现有记录，不会开启 Debug 写入。
可通过配置 `logLevel` 或 `opencode_bridge_log` 的 `level` 操作调整写入级别；`stat` 会报告诊断格式版本。

- **请求摘要**：已识别的公共路径、传输选择、请求字节数、输出上限、温度、消息角色与长度、环境块数量、图片数量、工具调用配对计数。
- **工具摘要**：声明数量、名字格式计数、schema 对象、引用和组合结构的统计。不写工具名字、属性名、描述、枚举值或默认值。
- **隐私**：不写消息正文、工具调用参数、结果、图片数据或密钥。自定义 URL、查询参数和非标准 UA 不原样记录。
- **上限**：最多解析 8 MiB 请求、检查 512 条消息、128 个工具及 8192 个 schema 节点，深度上限 32；达到上限会标记 `capped`。摘要失败不影响模型请求。

`transport: configured` 表示已设置专用传输函数，`node-fetch` 表示普通 fetch；该字段不单独证明 TLS 字节一致。

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
| `project-identity`、`request-waits`、`official-cooldown-policy` | 身份推导、旧版状态清理、无跨请求模型锁与即时清除出口等待。 |
| `catalog-*`、`log-*`、`client-boot` | 目录生命周期、脱敏、设置页。 |

### 9.1 实时探针

全部需要显式 `--run`，会消耗真实配额，且拒绝覆盖既有报告。离线套件跑得再全也无法发现「请求形态被网关
拒绝」这类问题——1.0.4 之前 418 项离线测试全绿，而每个真实请求都被拒。

| 探针 | 验证 |
|---|---|
| `smoke.mjs --run` | 会话/请求 id 形态、工具名无分隔符且能回映射、目录可达、带完整工具集的一次真实完成、返回调用名正确还原。 |
| `tool-loop-live.mjs --run` | 多轮工具循环：三轮串行调用，每轮结果喂回下一轮，后续请求必须回放 assistant 历史与 `reasoning_content`。2026-11-14 以 deepseek-v4.1-flash-free 实跑 10/10 通过（`docs/evidence/tool-loop-live-2026-11-14.json`）。 |
| `proxy-live.mjs` | 代理隧道承载真实流量。 |
| `vision-compat-live.mjs` | 图片输入与工具结果图片。 |
| `reasoning-compat-live.mjs`、`reasoning-roundtrip-live.mjs` | 思考字段的回放与往返。 |
| `wire-dump.mjs` | 打印当前实际发出的线上指纹。 |
| `official-client-ab-live.mjs --run --official <exe> --out <new.json>` | 隔离官方 CLI 配置，与真实适配器及 TLS 传输在同机、同模型上对照；支持合成工具数量与系统提示大小控制。 |

2026-11-17 的[同机对照记录](docs/evidence/official-client-comparison-2026-11-17.json)中，官方 v2.3.0 与插件均成功。
插件分别声明 7 个、52 个合成工具，以及 52 个工具加 60 KB 系统提示填充；最大请求体约 72 KB。
范围是受控合成请求，真实 UI 历史需另行复现。这些结果不能解释其他时刻或请求中的 429。

判定要点：先在同出口、同模型、相近时间对照实际结果。两边都被拒时，先排查上游状态与出口条件；
只有插件被拒时，再单变量比较工具、消息与请求参数。`FreeUsageLimitError` 本身不能确认 IP 额度已耗尽。

## 10. 安全、隐私与署名

- 除配置的 `apiKey` 外不读取任何凭据；代理 URL 在所有日志与 UI 中脱敏。
- 日志仅含元数据：不含提示、工具入参、结果或图片字节。
- 图片数据在任何级别都不会进入日志（由测试保证）。
- 插件不新增 `exec`/`spawn` 调用。对 DSH 的署名可通过 `userAgentAttribution` 开启，
  因协议原因默认关闭（§3.1）。

## 11. 术语

| 术语 | 含义 |
|---|---|
| **免费档** | 向官方客户端提供的无 key 模型集合。 |
| **门禁** | 上游判断是否服务非官方客户端请求的检查。本项目把它当作带日期的观测。 |
| **身份头** | 官方客户端恒发、用户无法更改的请求头（§3）。 |
| **占位声明** | 仅在调用方没有任何工具时发送，用于满足网关“至少一个工具”的要求。 |
| **净化名** | 声明到线上的工具名，已去掉分隔符；返回调用时映射回调用方的真实工具名。 |
| **服务端等待** | 当前运行中可重试错误的 `Retry-After` 提示，上限 15 分钟；免费额度拒绝仅记录原始值，不据此锁定模型。 |
| **出口** | 一条通往上游的配置路线（`direct` 或代理）。 |
| **Bun 形态传输** | 复刻官方客户端 `ClientHello` 的 wreq-js 握手。 |

## 12. 参考的社区项目

协议行为全部来自对官方客户端的实测，不依赖任何社区项目的结论。下列项目只用于设计阶段的对照，
判断某个做法是否值得沿用。**没有复制它们的代码。**

| 项目 | 关系 | 许可 |
|---|---|---|
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | 同类适配器，对照工具补缺与配置方式 | MIT |
| [x5427876/dsh-opencode-free](https://github.com/x5427876/dsh-opencode-free) | 同类适配器，对照别名与调用阻断 | MIT |
| [DragonHorizon-xtihc/dsh-connect-opencode-free](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free) | 同类适配器，对照占位工具的抑制方式 | MIT |
| [1624318455/dsh-plugin-adapter](https://github.com/1624318455/dsh-plugin-adapter) | 同类适配器，较早的工具补缺实现 | MIT |
| [randomix777/dsh-opencode-zen](https://github.com/randomix777/dsh-opencode-zen) | 同类适配器，对照目录刷新与缓存 | MIT |
| [seonzzy/dsh-zen-adapter](https://github.com/seonzzy/dsh-zen-adapter) | 同类适配器，对照目录发现 | MIT |
| [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api) | 只读其 issue 中关于免费额度随出口 IP 累积衰减的记录 | GPL-3.0 |

opencode2api 是 GPL-3.0。本项目只读过它的 issue 讨论，没有使用其代码，因此不受该许可约束。
以后若引用其代码，必须重新评估许可兼容性。

本节与 README 的同名章节是同一份清单，两处必须同时更新。
