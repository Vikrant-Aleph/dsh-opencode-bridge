# 三个公开仓库源码对照（2026-10-18）

## 范围与方法

仅只读研究公开 GitHub REST/raw。读取默认分支 HEAD commit，再按完整 SHA 获取文件；三者 API/tree/raw 均可访问，tree 均 `truncated:false`。未安装、运行第三方源码或测试，未修改主项目、DSH profile/应用、现有 research/opencode-src。工作资料只在本目录。结论为静态源码所见，不代表实际服务端当前策略或测试已通过。主范围为 Fish 的 packages/plugin、162 的 packages/plugin，以及 Dragon 的 lib/test/scripts；legacy Go 不作为当前 TS 插件能力证据。

| 仓库 | 默认分支 / HEAD SHA | 插件版本 |
|---|---|---|
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh/commit/06a702931abcb7505147e848bf817f577f1cd577) | master / `06a702931abcb7505147e848bf817f577f1cd577` | 0.3.12 |
| [DragonHorizon-xtihc/dsh-connect-opencode-free](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/commit/26cabe4201088e4cff8953510c346247d09683b6) | main / `26cabe4201088e4cff8953510c346247d09683b6` | 0.4.0 |
| [1624318455/dsh-plugin-adapter](https://github.com/1624318455/dsh-plugin-adapter/commit/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c) | master / `db7f273bd7caf2bb87c2428dcb8bd883eb338d1c` | 0.3.9 |

## 一、工具冲突、指纹诱饵、转译

### Fish：补缺名占位，不是实际别名路由

- `ensureFreeLaneShape` 将已有工具名放 Set，只追加缺少的 `bash/read`，不覆盖已有同名工具。工具为空才设 `tool_choice:none`；已有其他工具时新增占位仍可能被模型选择。占位描述为 Reserved，schema 为空对象，但这不是执行权限限制。[messages.ts:350–423](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/messages.ts#L350-L423)
- 确实存在 inbound 工具名映射参数，但实际 `GATE_TOOL_ALIASES = {}`，注释明确只是未来 gate 拼写变化的 seam。测试甚至断言输出仍为 `bash`。[events.ts:1–10](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/events.ts#L1-L10)、[zen-adapter.test.ts:516–545](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/test/zen-adapter.test.ts#L516-L545)
- 因此不能宣称当前实现 bash→pwsh、参数转译或碰撞后自动改名。对缺失 bash 的 Windows host，占位调用仍按 bash 原名离开适配器；是否被 host 拒绝取决于 host，不能由本仓库断言其总会失败。
- Responses 也补平铺工具，并强制 `tool_choice:auto`；不能把 chat 空工具时的 none 保证套到 Responses。[messages.ts:377–395](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/messages.ts#L377-L395)

### Dragon：抑制诱饵调用，或注册自己的真实 shell/read

- 同样根据调用者已有工具名补缺 bash/read，不覆盖已有 schema。[provider.js:78–84](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L78-L84)
- 真正区别：每次请求记录本次新增的 `injectedStubs`，加入 system 提醒，stream translator 只屏蔽这些诱饵调用，保留调用者真实同名工具；这是真实执行路径，不只是 README 描述。但“屏蔽”不是把 bash 调用转译成 pwsh。[provider.js:535–550](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L535-L550)、[provider.js:844–877](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L844-L877)
- `realGateTools` 默认 true（[config.js:90–98](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/config.js#L90-L98)），该路径注册真正 bash/read。遇重复注册异常会撤回本轮部分成功项，降级占位；没有看到逐项冲突解决、命名空间别名或 Host 原生工具参数适配。[gate-tools.js:113–155](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/gate-tools.js#L113-L155)

### 162：较早的占位补缺路径

- `bash/read` Set 去重并补缺；空工具时 chat 设 none；Responses 用平铺函数工具，并去掉 reasoning.effort=none，但不设 tool_choice。[messages.ts:196–299](https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/messages.ts#L196-L299)
- 已看消息转换、流转换/适配器路径中，未看到 Fish 新增的反向别名 seam，也未看到 Dragon 的诱饵调用屏蔽及真实 shell/read 注册。不能把 provider 的旧名兼容别名当工具别名功能。

## 二、Windows shell 安全

- **Dragon 风险最具体**：名为 bash 的工具实际 `child_process.exec(command,{cwd,timeout,maxBuffer,windowsHide})`，没有显式指定 shell。按 Node 默认行为，Windows 通常经 ComSpec/cmd.exe，不是 Bash，也不是 pwsh。`windowsHide` 只隐藏窗口，timeout/maxBuffer/64K 截断只限资源，不是权限沙箱。执行函数直接接受模型 command；read 直接 fs.readFile 任意给定路径。所读实现内未见 DSH 审批、文件策略、sandbox/run 服务、工作区边界或取消 signal 联动。不能据此断言宿主/OS 完全无外层防护，但不能将它描述成复用 DSH 原生安全 shell。[gate-tools.js:20–43、60–98](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/gate-tools.js#L20-L98)
- Fish 与 162 当前适配器层未看到自建模型可调用 shell/read 执行器；其 gate 工具是协议占位，不等于提供 Windows 安全转译。
- 两者确有受控子进程管理：sidecar 用 `spawn(executable,args)`，Windows 用 taskkill 参数数组，不经 shell 字符串拼接。Fish 的 taskkill 比 162 多 windowsHide 和超时，但不能泛化所有子进程都已加此限制（sing-box taskkill 仍仅 stdio ignore）。[Fish agent-process.ts:261–268](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/agent-process.ts#L261-L268)、[162 agent-process.ts:258–265](https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/agent-process.ts#L258-L265)、[Fish singbox.ts:404–434](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/pool/singbox.ts#L404-L434)

## 三、协议健康报告与线下测试

- **三者都有真实测试源码，不能说只是 README；本次均未运行。** Fish 与 162 的 package script 都有 node --test，test 目录有 messages/events/catalog/watchdog/rotate 等 mock/本地 server 测试，也有独立 live 脚本，必须区分离线与联网脚本。Fish 额外有 DSH 0.1.7 host contract 与 reasoning recovery 回归测试。[Fish package.json:47–52](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/package.json#L47-L52)、[Fish dsh-017-host.test.ts:1–23](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/test/dsh-017-host.test.ts#L1-L23)、[162 package.json:44–49](https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/package.json#L44-L49)
- Fish 的 `snapshot()` 给出 catalog pending/error/stale/ready、总数、暴露数、刷新时间，index 写 adapter-status.json 与 lastError；162 同样有 catalog snapshot/状态落盘及侧车 healthz 读取路径。这是目录/运行状态，**不是已经证明端到端工具协议健康**。[Fish catalog.ts:496–505](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/catalog.ts#L496-L505)、[Fish index.ts:121–143](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/index.ts#L121-L143)、[162 catalog.ts:408](https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/catalog.ts#L408)
- Dragon 真有 `auditWireMessages` 未应答工具数警告，以及 `sanitizeWireMessages` 将找不到 call id 的 tool result 改标 user 的修复。audit 本身按数量计数，不是完整按 id 的全协议验证，sanitizer 也不是通用 schema validator。[provider.js:341–407](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L341-L407)
- Dragon `/catalog` 实际返回同步错误、quota、keyCheck、retired；`/verify-key` 真发上游探测，属联网诊断，不是离线测试。没有在已看源码中看到统一“协议健康报告”产品/导出接口；不要把这些局部诊断说成完全没有诊断，也不要反过来称全协议健康报告已实现。[index.js:443–509](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/index.js#L443-L509)
- Dragon 测试确有 wire audit、orphan repair、诱饵屏蔽、真实工具保留、credential 回退断言。**真实 bash/read 测试若 import 不到 dsh-tools，直接 return，不构成真实工具测试必然执行的保证。**[core.test.js:306–335](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/test/core.test.js#L306-L335)、[core.test.js:1398–1489](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/test/core.test.js#L1398-L1489)

## 四、模型诊断及“自动回退”到底是什么

1. **Fish：存在目录/能力诊断与两类真实恢复。** S1 Zen 目录 / S2 models.dev / 缓存 / 静态已验证列表是目录降级，不是替用户换模型。新增本地 blocklist 与缓存 stale-while-revalidate。[catalog.ts:364–455](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/catalog.ts#L364-L455)
   - IP 池支持首个内容之前的失败换出口，已有内容后不重播；错误会聚合轮换故事。它换出口，model id 不变。[zen-adapter.ts:600–686](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/zen-adapter.ts#L600-L686)
   - **当前 Fish 独有重要差异：reasoning-only 达 max-tokens 后，可对声明支持 Off 的同一模型自动关 thinking 重试一次；不在已输出回答/工具调用后重放，累计两次 usage；不是一般自动换模型。**测试含 mock 及本地 HTTP/pi-ai 链路。[zen-adapter.ts:422–493](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/src/adapter/zen-adapter.ts#L422-L493)、[reasoning-recovery.test.ts:85–108、205](https://github.com/FishBottle7/opencode2dsh/blob/06a702931abcb7505147e848bf817f577f1cd577/packages/plugin/test/reasoning-recovery.test.ts#L85-L108)
2. **162：存在同模型 IP 出口重试、首内容/流空闲 watchdog、目录源和静态信息降级。**所读 stream 方法没有 Fish 当前的 reasoning-only→Off 包装恢复；不能因同源 fork 就当版本能力一样。[zen-adapter.ts:296–340](https://github.com/1624318455/dsh-plugin-adapter/blob/db7f273bd7caf2bb87c2428dcb8bd883eb338d1c/packages/plugin/src/adapter/zen-adapter.ts#L296-L340)
3. **Dragon：存在持久化模型可用性账本与真正 credential 回退。**将 deprecated、ModelProtocolUnsupported、RegionError、明确 model unavailable 持久化并从 picker 隐藏，429/超时/5xx 不据此永久退役；成功可撤销记录。这是被动失败诊断，不等于启动时逐模型主动验证。[availability.js:19–113](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/availability.js#L19-L113)
   - 按 verified-key 与 quota policy 构造匿名/多 key 顺序，429、FreeTierError 等特定情形换凭据；400 不盲目耗第二配额，5xx/transport 可退避重试；保留失败次数与来源诊断。重试 body 始终沿用同一个 model id，不是自动换模型。[provider.js:916–953](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L916-L953)、[provider.js:1036–1086](https://github.com/DragonHorizon-xtihc/dsh-connect-opencode-free/blob/26cabe4201088e4cff8953510c346247d09683b6/lib/provider.js#L1036-L1086)

## 结论边界

- 已实现：三者真实源码和测试；三者 gate 补缺去重；Fish 空映射的别名扩展 seam、当前 reasoning-Off 恢复；Dragon 诱饵抑制、真实工具注册、wire audit/repair、模型退役账本、凭据回退；Fish/162 同模型换出口。
- **没有足够源码证据宣称已实现**：通用工具别名碰撞自动分配、完整 bash→pwsh/参数安全转译、统一全面协议健康报告、自动挑选另一个模型继续用户请求。
- 上述“未看到”仅限已读取当前公开源码范围，不宣称任何历史提交、未发布版本、宿主或服务器绝对不存在该能力。仓库注释内的 live-probed 日期/HTTP 结果是作者记录，本次未复测，不作为当前线上可用性保证。
