# Applepi Docs

极简单机 Agent Harness（`@applepi/*`）的工程 Wiki。项目的单一事实来源是
`CONTEXT.md`（术语表 + 已锁定决策），本目录承载面向设计与实现的长期文档。

## 文档导航

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 系统架构：核心运行时、扩展协议、洋葱总线、agent loop、会话持久化、LLM 配置、仓库布局 |
| [design-principles.md](design-principles.md) | 设计原则：极简核心、能力注入、洋葱模型、信任模型、约定优于机制等 |
| [adr/](adr/) | 架构决策记录（ADR-0001 ~ 0010），按编号阅读，描述每个决策的上下文与后果 |
| [agents/](agents/) | Agent 协作约定：issue tracker、triage 标签、领域文档规范 |

## 快速了解

- **形态**：单机（本地）运行的 agent，不是给别人 embed 的框架。
- **核心极简**：`@applepi/core` 只有洋葱事件总线、加载器、内置 agent loop、
  会话存储、LLM 配置解析——**不含任何工具**（ADR-0005）。
- **能力全部来自扩展**：工具、skills、memory 都是 extension，经
  `setup(api)` 运行时注入。安全机制在 core（ADR-0009），不再由扩展提供。
- **仓库布局**：pnpm workspace 三包 `apps/agent → packages/extensions → packages/core`，
  依赖单向（ADR-0003）。

## 常用命令

```bash
pnpm install      # 安装依赖（workspace）
pnpm build        # 构建全部包（build-first，跑 dev/check 前必须）
pnpm dev          # 启动 REPL
pnpm test         # 各包测试
pnpm verify       # build + test + 全部 key-free 检查
```

## 锁定机制

所有重大设计均经由 `/grill-me` 或 `/grill-with-docs` 多轮访谈锁定，
决策记录于 ADR。偏离任何已锁定决策需要重新走 grill 流程。

*Wiki 首版建立于 2026-08-19，取代根目录 `harness-design-spec.md`（已删除，历史见 git）。*
