# 伪装原则

中文 | [English](CAMOUFLAGE.us.md) · [技术设计](TECHNICAL.md)

记录**桥接模仿什么、为什么**，是代码的依据：不在此列出的模仿都应删除。

---

## 原则

> **只伪装网关真正会检查的部分。**

最初的表述是“只伪装官方无法让用户改变的部分”，2026-11-13 的实测修正了它：字段“用户可配置”只
排除了它作为指纹的可能，并不排除网关把**默认形态**当作协议前提。所以判断标准是“是否被检查”，
不是“是否可配置”。

---

## 会被检查的部分

| 要求 | 实测结果 | 证据 |
|---|---|---|
| `User-Agent` | 必须是 `opencode/latest/2.2.0/cli`，其余全对也不行 | 社区报告与本项目探针 |
| **至少声明一个工具** | 名字任意，单独一个即可；空数组被拒 | `docs/evidence/bun-tool-minimum.json`、`docs/evidence/any-tool-vs-read.json` |
| **系统提示含 `<env>` 块** | 仅含该块的 177 字节提示即可；去掉该块被拒 | `docs/evidence/bun-env-hypothesis.json` |

后两项是关键：它们由官方客户端自动生成，用户改不掉。

---

## 不会被检查的部分

| 面 | 用户可改 | 证据 |
|---|---|---|
| 系统提示 | `agents.<name>.system`、`agents/<name>.md`，改后仍能通过 | `docs/evidence/user-customization-round2-2026-11-13.json` |
| 工具清单 | 12 个降到 4 个，仍能通过 | 同上 |
| `<env>` 的内容 | 改写路径、翻转 git 标志，仍能通过 | `docs/evidence/bun-env-strictness.json` |
| Code Mode 目录 | 用不同工具名合成的目录，仍能通过 | `docs/evidence/bun-synthetic-catalog.json` |
| `b3`、`traceparent` | 每次请求由运行时生成，无固定值 | — |
| `x-opencode-project` | 由工作目录推导 | — |
| 运行时 | Bun 1.4.4 用零工具请求体同样被拒 | `docs/evidence/bun-runtime-test.json` |

---

## 传输层（TLS）

官方客户端的 `ClientHello` 是 Node 自带 TLS 无法表达的。`src/bun-transport.ts` 把握手交给
`wreq-js`（BoringSSL，与官方同一套库）。

**状态：已逐字节对齐，但未被证明必需。** 目前只用于应对将来可能出现的指纹检查。

| 元素 | 值 |
|---|---|
| 加密套件 | 抓包中的 17 个，顺序一致 |
| `supported_groups` | `X25519MLKEM768`、`X25519`、`P-256`、`P-384`——默认配置多给的 `MLKEM768` 组要去掉 |
| `signature_algorithms` | 抓包中的 11 个，含 **`0x0807` = ed25519**（不是 `rsa_pss_pss_sha256`，那是 `0x0809`）与 `0x0603` = ecdsa_secp521r1_sha512 |
| 扩展 | 抓包中的 12 个，顺序一致，无 GREASE/ECH/ALPS |
| ALPN | 仅 `http/1.1`——官方客户端从不提供 `h2` |

`ClientHello` 为 1482 字节，归一化随机字段后与抓包逐字节相同
（`docs/evidence/clienthello-deep-2026-11-13.json`）。

---

## 刻意不做的事

- 不通过轮换 IP、会话或身份规避服务限制。
- 不在其他运行时里执行工具：返回的调用交给 DSH 派发。
- 不额外模仿用户可改的内容，因为它们不构成身份。

---

## 当前状态

| 要求 | 桥接如何满足 |
|---|---|
| 至少声明一个工具 | 调用方自己的工具即可满足；**仅当调用方没有任何工具时**才补一个占位声明，其描述劝阻调用，万一被调用则丢弃（记 `warn`），该轮正常结束 |
| 系统提示含 `<env>` 块 | 适配器把 `environmentBlock()` 追加在 DSH 提示之后，内容取自真实工作目录 |
| `ClientHello` | 与抓包逐字节一致，扩展零差异 |
| 请求头 | 除 `x-opencode-project` 外，名称、大小写、顺序、值均一致 |
| 连接 | 复用连接池、`keep-alive` |

适配器自身代码路径可稳定返回 200 并正常作答
（`docs/evidence/verify-env-fix.json`、`docs/evidence/repeat-1.json`、`docs/evidence/placeholder-verify.json`）。

---

## 已排除的假设

每一项都经实测否定，记录在此以免重复劳动。

| 假设 | 结果 |
|---|---|
| User-Agent | 已按抓包对齐，但不足以通过 |
| 端点 lane | 四条路径行为一致 |
| 会话 ID 过期 | 全新会话同样失败 |
| 出口 IP 配额 | 换全新 IP 后官方通过、桥接仍被拒 |
| 代理按进程分流 | 两个进程名下出口 IP 相同 |
| TCP 写入合并 | 确有差异，但随时序变化，作为门禁不合理 |
| 单独的 TLS 指纹 | 已逐字节一致，仍被拒 |
| 运行时 | Bun 用同一请求体同样失败 |
