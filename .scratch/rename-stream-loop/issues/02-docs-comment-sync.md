# 02: 文档与注释同步 stream-loop → loop 命名

**What to build:** 文档与代码注释中的模块指称从 `stream-loop` 切到 `loop`：架构 Wiki（overview 模块表、core-runtime、agent-loop、session-persistence、repo-layout、architecture.md ASCII 图、README）、CONTEXT.md 现行词条；core/server/extension 内提及 `stream-loop.ts` 的注释。历史 ADR 不改正文，按惯例加「修订注记」。

**Blocked by:** 01（文档描述新路径落地后的状态）。

**Status:** ready-for-agent

- [x] 架构 Wiki + README + CONTEXT.md 现行词条改用 `loop`
- [x] core / server / extension 注释同步（含 server 测试注释）
- [x] ADR-0011 / ADR-0017 加修订注记，正文不动
- [x] `rg "stream-loop"` 仅剩历史记录类提及
