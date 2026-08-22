# Applepi Docs

极简单机 Agent Harness（`@applepi/*`）的工程 Wiki。项目的单一事实来源是
`CONTEXT.md`（术语表 + 已锁定决策），本目录承载面向设计与实现的长期文档。

## 文档导航

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 系统架构：核心深模块、bundle 装配、扁平系统提示词、流式 loop、会话持久化（含 [jsonl 事件模型](architecture/08-session-persistence.md#事件模型lifecycle-events)）、LLM 配置、仓库布局 |
| [design-principles.md](design-principles.md) | 设计原则：极简核心、bundle 装配、扁平提示词、信任模型、单一事实来源等 |
| [adr/](adr/) | 架构决策记录（ADR-0001 ~ 0018），按编号阅读，描述每个决策的上下文与后果 |
| [agents/](agents/) | Agent 协作约定：issue tracker、triage 标签、领域文档规范 |

## 快速了解

- **形态**：单机（本地）运行的 agent，不是给别人 embed 的框架。
- **核心极简**：`@applepi/core` 只有深模块 `llm`（流式）/ `stream-loop` / `session` /
  `config` / `security` / `trace` 与薄 Harness 壳——**不含任何工具**（ADR-0005）、
  无洋葱/扩展机制（ADR-0015）。
- **能力来自 bundle + capability**：`@applepi/bundle` 的 `base`/`standard` 纯声明能力包 +
   `@applepi/extension` 的能力工厂（memory/skills/todo/plan/goal/ask_user），由
   **共享运行时服务端**（`packages/server`）装配。安全机制在 core（ADR-0009）。
- **仓库布局**：pnpm workspace —— `server → bundle → extensions → core` 单向（ADR-0003）；
  接入端 `web`（页面壳）与 `tui`（Ink 终端）经 HTTP attach 服务端（ADR-0017）。
- **共享运行时服务端（ADR-0017）**：`packages/server`（Hono，127.0.0.1:3210）持有全部
  agent API（chat/approve/session/workspaces/files/config）；Web 壳与 TUI 都是接入端——
  先启动者拉起服务端、后启动者 attach，心跳租约管生命周期。CLI 已删除；流式 loop、
  工具批准、Langfuse 埋点都在 core（ADR-0011 / ADR-0012）。

## 常用命令

```bash
pnpm install      # 安装依赖（workspace）
pnpm build        # 构建全部包（build-first）
pnpm dev          # 启动 Web 界面（@applepi/web，默认端口 3010）
pnpm test         # 各包测试
pnpm verify       # build + test
```

## 锁定机制

所有重大设计均经由 `/grill-me` 或 `/grill-with-docs` 多轮访谈锁定，
决策记录于 ADR。偏离任何已锁定决策需要重新走 grill 流程。

*Wiki 首版建立于 2026-08-19，取代根目录 `harness-design-spec.md`（已删除，历史见 git）。*
