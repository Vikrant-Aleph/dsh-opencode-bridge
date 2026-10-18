# 调研笔记（可公开）

这里放的是**自己写的分析记录**，用于解释 `docs/COMPARISON.zh.md` 里的结论是怎么来的。
不包含第三方源码、抓包样本或二进制文件。

| 文件 | 内容 |
|---|---|
| `competitor-source-audit-2026-10-18.md` | 两个同类适配器（seonzzy/dsh-zen-adapter、randomix777/dsh-opencode-zen）的静态源码核查，含 HEAD SHA、逐项"有/没有/不确定"。 |
| `competitor-source-review-2026-10-18.md` | 三个公开仓库（Fish/162/Dragon）的源码对照摘要，含固定 SHA 与证据链接。 |

两份记录都成文于 2026-10-18，只读公开 GitHub 仓库，未安装或执行第三方代码，
也未发送任何模型请求。它们描述的是**那一天固定提交**的状态，上游会变。

## 为什么仓库里没有 `research/`

本地还有一个 `research/` 目录（约 145 MiB、8800+ 文件），被 `.gitignore` 排除，因为它包含：

- `opencode-src/`：`sst/opencode` 的完整源码拷贝（第三方代码，转分发不合适）；
- `npm/`：若干上游包的解包与 tarball；
- `models-dev.json`、各类 tree/listing 快照与别人的 diff、脚本；
- 下载的 `bun.exe` 等工具二进制（曾因单文件 91.9 MiB 逼近 GitHub 限制而删除）。

这些只在重新推导闸门（TECHNICAL 第 4、10 章）时作参考。方法写在技术文档里，
不依赖这些文件本身。
