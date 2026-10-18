# GitHub 源码核查（2026-10-18）

只静态下载/阅读 GitHub REST + raw 文件；未安装、构建或执行第三方代码，未发送模型推理请求，未读取/发送用户提示或密钥。完整树及 HEAD 元数据见各仓库 metadata.json。

## HEAD
- seonzzy/dsh-zen-adapter: `09f847119321866afc3a7ed310f8ba14eece747d`
- randomix777/dsh-opencode-zen: `05fe1dc329d1226ab994ebb8bd94a89bf83918f7`

## 核心差异

### seonzzy
- 实现：`lib/catalog.js` fetchLiveIds/fetchMetadata/buildCatalog 双源汇合；inference/v1/models 决定在售，models.dev 定价/容量；已知付费/废弃拒绝，元数据缺失时仅按名字含 free 降级。目录5分钟、元数据24小时 SQLite 缓存，网络失败允许旧数据；`lib/index.js` 半小时强制刷新，seed三模型冷启动。
- 实际探测：`lib/zen-service.js` probeAll/#probeOne 顺序对每个免费候选发送固定 `ping`、max_tokens=1、stream=true、read占位工具；间隔350ms。可用性仅由HTTP200判定，虽然读取全文，但不验证SSE有效帧、输出或工具能力；无探测结果TTL/持久化/独立请求超时，bridge传空options，不可据此宣称端到端能力测试。
- `lib/index.js` currentModelIds 排除探测失败，但如筛选后为空又返回SEED_MODELS，可能重新出现探测失败的seed。不自动替换正在调用的模型，不是聊天故障转移/熔断。
- 协议/工具：ensureFreeLaneShape 注入缺失的精确 read 名工具并强制流式；只有原来零工具才设置tool_choice=none；有其他真实工具时占位read仍有被模型调用的可能，未见本插件专门拦截该占位工具调用。实际消息/工具流适配委托宿主 PiAiAdapter/pi-ai；不能把依赖内部能力当成本仓库自有实现。
- 匿名隐私：createDisguisedOptions 去除Authorization（null），INERT_AUTH不读真实凭据；固定OpenCode UA与session/request头。deriveRequestIDs 从第一条用户内容产生session seed；session.js base62Tail 用SHA256派生尾部，前缀随当前时间变化，因此不是完整sessionID跨回合稳定，且哈希不是匿名性保证。缓存只记录模型id/定价/容量，没有本插件显式提示落盘。错误/探测detail截断但没有秘密脱敏；没有发现独立诊断导出、日志级别管理、提示保留开关、遥测模块。上游仍收到会话内容，免费服务留存策略无法由此确认。

### randomix777（必须区分 src 和发布入口）
- `package.json` main 指向 lib/index.js、files仅打包lib；提交的lib与src不同步。
- 当前lib：旧7项fallback，内存TTL/请求去重/失败冷却；models.dev cost.input/output===0 且context>0筛选，网关列表可取时求交，网关不可取/空时放宽为仅元数据。无元数据则内存/硬编码列表。没有聊天探测，也不验证候选能生成或调用工具；resolveModel允许未知id。
- src新增目录抓取最多3次指数退避、文件缓存与QuotaTracker；但lib完全没有这些新增功能（lib L577-580仅一次Promise.all；apply L673-701无tracker/cachePath）。因此不能说正常package入口已经具备目录重试/配额跟踪/磁盘缓存。
- 即使只评src：discovery.ts 从未调用已import的readTextFile恢复目录；fs-cache.ts 从node:fs导入回调式mkdir/writeFile/readFile后不传callback直接await，错误被吞，不能认定缓存工作；readTextFileSync在ESM里调用require也被catch吞。此为静态判断，未执行确认。
- QuotaTracker只是记录429，10分钟3次推估30分钟重置；adapter每次仍fetch，不拒绝请求、不半开试探、不切模型。adapter.describeFailure的429总是RATE_LIMIT，故recordRateLimit目前其他分类分支实际上走不到。
- 工具自实现：translate.toWireTools映射函数schema、历史tool-call/tool-result；stream.consume按index拼接工具参数，输出DSH块/推理/usage；无参数JSON校验/修复、工具选择降级/别名或read门控注入。忽略历史reasoning和普通image；工具结果image转占位文字。SSE坏JSON直接跳过，缺finish_reason默认stop/tool-calls，未看到SSE error帧显式报错，故HTTP200不保证成功。
- 隐私：可从credentials/env取真实key并发Bearer；无key省略Authorization。启动日志输出endpoint/env名不输出key值；上游原始错误body截断后直接拼入LlmError，未见脱敏、诊断导出/开关或主动遥测。不能以未发现遥测推断上游不留存。

## 精确 GitHub 证据

seonzzy:
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/catalog.js#L249-L315
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/zen-service.js#L123-L195
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/index.js#L113-L134
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/index.js#L184-L221
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/index.js#L291-L295
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/session.js#L71-L92
- https://github.com/seonzzy/dsh-zen-adapter/blob/09f847119321866afc3a7ed310f8ba14eece747d/lib/cache.js#L65-L95

randomix:
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/package.json#L23-L30
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/lib/index.js#L547-L593
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/lib/index.js#L673-L701
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/discovery.ts#L148-L205
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/fs-cache.ts#L8-L48
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/quota-tracker.ts#L75-L125
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/adapter.ts#L113-L170
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/translate.ts#L32-L69
- https://github.com/randomix777/dsh-opencode-zen/blob/05fe1dc329d1226ab994ebb8bd94a89bf83918f7/src/stream.ts#L47-L133

## 拟议工具安全组合的比较边界

在本次这两个公开 HEAD 中，没有找到“可审计只读工具桥 + 注入shell默认拒绝且不把Bash转换成pwsh + 全部返回toolcalls先原子校验 + 当前agent.scope离线审计（不发送提示、无网络、无执行）”的完整组合。randomix 的 toWireTools 直接映射工具schema，consume按delta即时输出工具调用，未见只读allowlist/shell拒绝、shell名映射、批次原子校验或scope审计。seonzzy自身只注入read stub/强制流式，没有筛选原有工具，工具转换交给宿主pi-ai；依赖内部行为未核查，不能断言依赖绝无相关能力。不作全球唯一声明；动态目录、探测、诊断等单项并不独有，seonzzy已明确有真实POST逐模型HTTP探测。父代理另核查的x5427876/dsh-opencode-free不属于本子报告直接审计范围。

## 结论边界
本次可确定代码实现和缺失路径，不确定当下公网端点地域/匿名额度、模型真实健康、宿主pi-ai内部重试、npm发布包是否另行重建、上游数据保留政策。不把源码注释的2026-10-15测量当成本次实测，也不把目录fallback称为推理fallback。
