# OpenCode Zen 适配器源码比较与本项目定位

> 核查日期：2026-10-18。本文比较固定公开提交中的实际实现，不作产品排名、线上可用性承诺或“全球唯一”声明。
> 本项目 0.3.0 已实现“安全工具桥与离线当前作用域审计”并新增离线回归测试；不据此宣称全量模型或真实 Host/UI 已通过。

## 1. 方法与证据边界

- 静态获取、阅读 GitHub REST/raw 源码、包入口及测试；未安装、构建或执行第三方项目，未运行其测试。
- 未向第三方发送用户聊天、密钥或模型推理请求；不把作者的历史实测记录当成本次复测。
- 比较的是下表 HEAD，不保证 npm 包与仓库源码一致；尤其需要区分 randomix 的发布入口与未同步源码。
- “未看到”指已核查文件与调用路径中没有证据，不等于所有历史版本、未发布代码或依赖内部绝对不存在。
- 本次未实测所有模型、地区、匿名额度、工具组合及 DSH 版本；目录在售、HTTP 200 与完整工具执行成功不是同一件事。

| 简称 | 公开仓库 | 固定 HEAD SHA |
|---|---|---|
| Fish | [FishBottle7/opencode2dsh][F0]，主要核查 packages/plugin | `06a702931abcb7505147e848bf817f577f1cd577` |
| Dragon | [DragonHorizon-xtihc/dsh-connect-opencode-free][D0] | `26cabe4201088e4cff8953510c346247d09683b6` |
| 162 | [1624318455/dsh-plugin-adapter][A0]，主要核查 packages/plugin | `db7f273bd7caf2bb87c2428dcb8bd883eb338d1c` |
| seonzzy | [seonzzy/dsh-zen-adapter][S0] | `09f847119321866afc3a7ed310f8ba14eece747d` |
| randomix | [randomix777/dsh-opencode-zen][R0] | `05fe1dc329d1226ab994ebb8bd94a89bf83918f7` |
| x5427876 | [x5427876/dsh-opencode-free][X0]，README 对应 0.3.5 | `1e12698d363ba6a3a3bbad9131739c9843830137` |

## 2. 能力矩阵：先承认已经存在的功能

| 项目 | 目录与模型诊断 | 工具门控、别名与诱饵 | 恢复机制与范围 |
|---|---|---|---|
| Fish | Zen/models.dev、缓存、静态降级、目录状态 [F1] | bash/read 补缺；别名接口存在但当前映射为空 [F2] | 同模型首内容前换出口；特定 reasoning-only 截断后 Off 重试一次 [F3] |
| Dragon | 动态目录、永久型错误退役账本、Key/配额诊断 [D1][D2] | 补缺、屏蔽本次诱饵；默认尝试注册真实 bash/read [D3][D4] | 按策略与 Key 验证结果切凭据、退避；不换 model id [D5] |
| 162 | 双源目录、静态信息降级、目录状态 [A1] | bash/read 占位补缺；所读路径未见实际别名桥 [A2] | 同模型 IP 出口轮换、流 watchdog；未见 Fish 当前 Off 恢复层 [A3] |
| seonzzy | 双源、SQLite 缓存、真实逐模型 HTTP 探测 [S1][S2][S6] | 注入 read；消息/流处理主要委托宿主 PiAiAdapter [S3] | 失败候选过滤；全空又回 seed，不是聊天自动换模型 [S4] |
| randomix | 发布入口有双源筛选、内存 TTL/冷却；src 新增部分未进 lib [R1][R2] | 自写消息/工具流转换；所读实现未见诱饵桥 [R3] | 目录降级；src 配额记录也不是聊天熔断/换模型 [R6] |
| x5427876 | 双源目录、真实推理探测、延迟/结果持久化、隐藏模型 [X1][X2] | pwsh→bash、参数往返改名；缺失诱饵拒绝、残缺名字缓冲 [X3][X4] | 探测可检查协议通道并记住可用通道；不等于任意请求换模型 [X5] |
| 本项目既有能力 | 动态目录 | 工具别名与参数翻译 | 独立 LlmAdapter；不 patch 全局 fetch |
| 本项目 0.3.0 | 离线、当前 agent 工具作用域审计 | 保守 schema 桥、注入 shell 默认拒绝、整批工具调用原子校验 | 已实现且有离线回归；不等于全量 live/Host 验收 |
| 本项目 0.4.0 | 代理逐条GET探测、脱敏健康状态/明文store | 保留0.3.0桥，不patch全局HTTP | 用户配置HTTP(S) CONNECT池、按序复用健康出口；429/流前传输失败才改道，流中不重播 |

动态目录、工具改名、参数转换、探测、诊断和原生适配器各自都已有先例。
仅增加设置页、日志或名称变化，不足以说明本项目有独立技术定位。
本项目0.4.0的新增组合是[用户配置HTTP(S)代理池与逐出口冷却](../src/proxy-pool.ts)、[增删/GET探测与store](../src/proxy-service.ts)、流前改道且不重放已流内容。
健康时按配置顺序复用靠前出口（非round-robin/逐会话绑定），冷却后顺延、恢复后重新优先；401/403/503不轮换，SOCKS不支持，密码本地明文，上游额度未证实仅按IP。
0.4.0编译及66/66离线通过，真实CONNECT/直连GET为200（847ms/2384ms），store→重载source=settings-store已实机验证并清理恢复仅直连；合成补全均503、未线上触发429，浏览器渲染与RPC未验证，不能外推端到端成功。

## 3. 工具别名：补缺、改名、拒绝和安全映射不能混为一谈

### Fish 与 162：占位补缺不等于 Windows 工具桥

Fish 把已有名字放入 Set，仅追加缺少的 bash/read；无工具的 chat 请求设置 tool_choice=none。
已有其它真实工具时新增占位仍可能被选择；“Reserved”描述不是权限控制。[F2]
Fish 的 GATE_TOOL_ALIASES 明确为空；测试断言 bash 名字原样通过，因此不能把扩展 seam 说成实际 bash→pwsh 转译。[F4]
Responses 路径反而设置 auto，不能沿用 chat 空工具时的 none 保证。[F2]
162 保留较早的补缺实现；provider 旧名兼容别名不属于工具冲突处理。[A2]

### Dragon：真实的诱饵抑制，但另一条路径自行执行命令

Dragon 跟踪每个请求实际新增的 injectedStubs，只抑制这些占位调用，保留调用者已有真实同名工具，并输出说明。[D3]
其 realGateTools 默认 true，尝试注册真正 bash/read；冲突异常时撤回本轮部分成功注册并退回占位，不是逐项自动分配安全别名。[D4][D8]
这比只注入占位更完整，但不能称为把 Bash 命令安全翻译成 PowerShell。

### x5427876：已有实际别名、参数恢复与诱饵阻断

匿名路径在缺 bash 且存在 pwsh 时，将 pwsh 对外声明为 bash；read 的 file_path/filePath、shell 的 timeoutMs/timeout 也往返映射。[X3]
它同步重写工具声明和历史调用；返回中若出现 unavailable gate tool 就抛错，不允许 Host 执行。[X3]
withGuidance 还缓冲可能属于不可用诱饵的未完整工具名，未解析完则报错。[X4]
因此不能以“其它项目只有诱饵、无 Windows 转译或无诱饵阻断”为本项目卖点。
但这些路径不等同于本项目的“全部 caller 名预留 + 已知 schema 子集校验 + 整批调用原子放行”。

## 4. Windows 执行边界与进程影响范围

- Dragon 的 bash 实际使用 child_process.exec(command)，没有显式 shell；Windows 默认通常经 cmd.exe，而非 Bash/pwsh。[D4]
- timeout、maxBuffer、windowsHide 与输出截断是资源/窗口控制，不是沙箱；read 直接调用 fs.readFile。[D4]
- 所读 Dragon 执行器未见 DSH 原生审批、文件策略或 sandbox/run API 联动；这不证明 OS/宿主不存在任何外层防护。
- Fish/162 的适配器占位不是自建可执行 shell；其 sidecar/sing-box 子进程 argv 管理也不是模型工具安全转译。[F5][A4]
- x5427876 工具执行留给 DSH，但确实安装 compat、global fetch 与 node:http(s) 包装，限定 Zen inference 端点；README 明确披露同进程影响与权限风险。[X6][X7]
- 本项目独立 LlmAdapter、不 patch 全局 fetch，可减少跨插件传输影响面；独立适配器本身不是本项目独有，也不自动证明安全。
- 新桥只对本插件新增的 shell 诱饵拒绝执行；调用者本已授权提供的 pwsh 或其别名仍正常，不把“拒绝诱饵”写成禁止用户合法 shell。

## 5. 诊断、健康报告、测试与自动回退的真实含义

Fish/162 有 catalog snapshot、状态落盘、侧车 healthz 客户端与消息/流/轮换测试，不是只有 README。[F1][A1][F6]
Fish 额外有 DSH 0.1.7 合约回归、reasoning-only Off 恢复及本地 HTTP 测试；本次没有运行它们。[F6]
Dragon 有 auditWireMessages 的未应答工具数警告，以及把孤儿 tool result 改标 user 的 sanitizer；不是完整协议形式验证。[D6]
其 catalog bridge 返回同步错误、quota、keyCheck、retired；verify-key 是联网诊断，不能叫离线审计。[D2]
Dragon 的真实 bash/read 测试在无法导入 dsh-tools 时直接 return，不能仅凭测试名字认定这条路径必定执行过。[D7]

seonzzy 探测确实逐模型 POST，但以 HTTP 200 判可用，不验证有效输出、SSE 或工具执行；过滤后全空又回 seed。[S2][S4]
x5427876 探测读取真实推理结果，有文本或 thinking 即可判有回答，并区分 dead 与 inconclusive；这也不是工具能力全覆盖测试。[X5]
randomix 必须看发布入口：main 指向 lib；src 中的目录重试、缓存、配额新增不应当算作当前入口已具备。[R1][R2]
其 src 缓存代码存在回调式 fs API 被直接 await、错误被吞等静态疑点，不能把“有缓存文件源码”当成功持久化证据。[R4]

应分别描述四类恢复，而非统称“自动模型回退”：
1. **目录降级**：上游目录失败后使用缓存/静态信息；不改变正在生成的模型。
2. **出口轮换**：Fish/162 首内容前尝试其它 IP；一旦已有内容便不重放。[F3][A3]
3. **凭据回退**：Dragon 在特定 429/拒绝等情况下尝试其它匿名/私有额度，model id 不变。[D5]
4. **推理级别恢复/协议通道探测**：Fish 特定截断场景关 thinking 重试；x5427876 探测其它 API 通道，均不是自动挑另一个模型。[F3][X5]

所核查路径中未看到统一、全面的“协议健康报告”接口，但已有丰富的局部诊断，不能称其它项目“没有健康诊断”。

## 6. 隐私结论必须有层次

工具 schema、会话 ID 派生、诊断导出、运行日志、上游数据留存是不同问题。
seonzzy 的匿名路径与派生 session 并不保证上游不接收或保留请求；randomix 可发真实 Key，错误正文截断也不等于脱敏。[S3][S5][R5]
x5427876 已公开说明身份字段、进程包装与敏感 debug 日志边界，不能说其“没有隐私考虑”。[X7]
本项目新审计的隐私承诺仅限该审计路径：不读聊天、不联网、不执行工具、不导出描述/default/参数；不代表模型推理本身离线。
不依据“未发现遥测模块”宣称任何项目或免费服务零留存。

## 7. 新增组合：安全工具桥与离线当前作用域审计

以下约束已在[规划层](../src/opencode-protocol.ts)、[工具桥](../src/tool-bridge.ts)、[适配器](../src/adapter.ts)与[审计工具](../src/bridge-audit.ts)实现，并有[桥测试](../tests/tool-bridge.test.mjs)、[集成测试](../tests/bridge-integration.test.mjs)；不是全量线上证明：

| 约束 | 预期行为 | 不能由此推出 |
|---|---|---|
| 名字预留 | planTools 先预留全部 caller 名，避免 read_client 等冲突随输入顺序改变 | 所有第三方命名永不冲突 |
| 请求作用域 | 从实际 options.tools 建计划，不凭全局注册表扩权 | 宿主权限策略一定正确 |
| 原子放行 | tool_calls 完成后先校验整批，任何桥接失败不发该批任何工具块；EOF/length/stop 为 TOOL_BRIDGE_INCOMPLETE | 执行事务、Host 后续失败回滚、已发文字/思考回滚 |
| 原生参数 | 原名/别名要求合法 JSON 对象，保留原始参数字节；完整 schema/权限由 Host 验证 | 插件已经验证原生工具的全部约束 |
| Shell 默认拒绝 | 本插件注入 bash/shell 不猜测转换到 pwsh；调用者已有合法工具照常 | Bash 与 PowerShell 语义等价 |
| 只读桥 | read/glob/grep 仅在当前 caller 有目标且源/目标已知 schema 子集验证通过时映射 | 支持任意 JSON Schema 或任意工具 |
| Fail-closed | 未知、畸形、无法证明约束均拒绝，不吞掉约束继续执行 | 没有误拒绝或用户体验成本 |
| 离线审计 | opencode_bridge_audit 无必填参数，limit=1–200 默认80；只查 tools.schemas(exec.agent)，缺 agent 拒绝不退全局 | 其它 agent、未来请求或远端模型也已审计 |
| 最小输出 | 只输出 names/aliases/route/reasons；不输出 descriptions/defaults/args | 所有名字本身都不敏感 |

这组约束的实质在于**当前授权范围、保守映射证明、无部分工具放行与可离线解释**，不是简单改名或增加日志。
在本次六个固定 HEAD 的已核查路径中，未找到这组约束的完整相同组合；未穷尽依赖、全网与其它版本，不能证明唯一。
保守子集会拒绝无法识别的 schema；审计只给候选路由、每次参数仍需验证。整批缓冲增加执行前等待，且不提供执行事务/回滚，这是兼容性与延迟取舍。
审计 basis 为 current-agent-scoped-native-registry，不是调用历史/HTTP 健康测试/权限授权；PTC 与辅助请求可能不同，实际请求按 options.tools 重规划。
“只读”仅描述路线名，不保证任意同名实现无副作用；未知 `$ref`/`pattern` 等约束拒绝，合法 native 的完整 schema/权限仍由 Host 负责。

### 7.1 本轮验证记录（2026-10-18）

- TypeScript 编译成功，49/49 离线测试通过；测试的是本项目，不是第三方项目。
- 本机 `0.3.0` 重新挂载后，真实调用 `opencode_bridge_audit({limit:8})` 成功；
  当时作用域报告 41 个调用方工具、3 个别名、3 条候选映射和 2 条可执行诱饵拒绝。
- 打包干跑退出码 0。一次合成 GLM smoke 能读取 10 项模型目录，但推理 POST 返回
  HTTP 503 / Endpoint is unavailable；未取得 SMOKE_OK，未跨模型重试或做策略提示隔离对照。
- 因此不能宣称本轮端到端推理、全模型或完整 Desktop/UI 验收通过；审计入口与离线回归有实测证据。

## 8. 可用于 PR 的表述

> 新增“安全工具桥与离线当前作用域审计”：按请求实际工具集规划别名，保留 caller 全部名字；
> 对新增 shell 诱饵默认拒绝，不猜测 Bash 到 PowerShell 的转换；只对当前存在且 schema 可验证的只读目标作保守映射。
> 返回工具调用整批通过桥接检查后才发任何工具块，避免桥接部分放行（不提供执行事务/回滚）；离线审计解释当前 agent 的名字、路由与拒绝原因。
> 本功能不执行审计对象、不读取聊天、不发送审计网络请求。

发布前应补充实际验证结果与支持的 schema 范围。可写“已实现并有离线回归测试”，不要外推“已全量 live 通过”。
不承诺模型全覆盖、上游免费资格、Marketplace 收录或审查通过；不贬低已有项目的真实能力。

## 9. 固定提交证据索引

以下链接全部绑定完整 SHA；本项目工作树能力尚在演进，不能借这些第三方链接证明本项目验收完成。

[F0]: https://github.com/FishBottle7/opencode2dsh/commit/06a702931abcb7505147e848bf817f577f1cd577
[F1]: https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/catalog.ts#L350-L505
[F2]: https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/messages.ts#L350-L423
[F3]: https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/zen-adapter.ts#L422-L686
[F4]: https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/test/zen-adapter.test.ts#L516-L545
[F5]: https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/agent-process.ts#L229-L268
[F6]: https://github.com/FishBottle7/opencode2dsh/tree/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/test
[D0]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/commit/26cabe4201088e4cff8953510c346247d09683b6
[D1]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/availability.js#L19-L113
[D2]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/index.js#L443-L509
[D3]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L535-L695
[D4]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/gate-tools.js#L20-L155
[D5]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L916-L1086
[D6]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L341-L407
[D7]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/test/core.test.js#L306-L335
[D8]: https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/config.js#L90-L98
[A0]: https://github.com/1624318455/dsh-plugin-adapter/commit/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c
[A1]: https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/catalog.ts#L243-L421
[A2]: https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/messages.ts#L196-L299
[A3]: https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/zen-adapter.ts#L296-L495
[A4]: https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/agent-process.ts#L230-L265
[S0]: https://github.com/seonzzy/dsh-zen-adapter/commit/09f847119321866afc3a7ed310f8ba14eece747d
[S1]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/catalog.js#L249-L315
[S2]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/zen-service.js#L123-L195
[S3]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/index.js#L184-L221
[S4]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/index.js#L113-L134
[S5]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/session.js#L71-L92
[S6]: https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/cache.js#L65-L95
[R0]: https://github.com/randomix777/dsh-opencode-zen/commit/05fe1dc329d1226ab994ebb8bd94a89bf83918f7
[R1]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/package.json#L23-L30
[R2]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/lib/index.js#L547-L701
[R3]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/stream.ts#L47-L133
[R4]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/fs-cache.ts#L8-L48
[R5]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/adapter.ts#L113-L170
[R6]: https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/quota-tracker.ts#L75-L125
[X0]: https://github.com/x5427876/dsh-opencode-free/commit/1e12698d363ba6a3a3bbad9131739c9843830137
[X1]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/catalog.ts#L1370-L1515
[X2]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/index.ts#L358-L405
[X3]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/zen-provider.ts#L603-L700
[X4]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/zen-provider.ts#L1949-L1993
[X5]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/zen-provider.ts#L1071-L1348
[X6]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/src/index.ts#L468-L506
[X7]: https://github.com/x5427876/dsh-opencode-free/blob/1e12698d363ba6a3a3bbad9131739c9843830137/README.md#L130-L172
