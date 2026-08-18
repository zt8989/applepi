# 01 — 核心运行时 + 端到端 agent loop

**What to build:** 一个能直接跑起来的本地 agent。pnpm workspace 根就绪；`@harness/core` 实现洋葱事件总线、会话上下文（ctx）、扩展加载器（loader）、harness 装配与内置 agent loop（使用 Vercel AI SDK 的 `generateText`，工具只向外暴露 schema、执行走自有 loop）；内置 `bash` 与 `str_replace_editor` 两个工具；denylist 作为最外层 `tool` 中间件注册；`apps/agent` 通过环境变量选择 provider（OpenAI / Anthropic）并对一条 prompt 完成一次"模型调用 → 解析工具调用 → 执行 → 回灌"的闭环。本 ticket 需补全上一轮被中断写坏的 `packages/core/src/bus.ts`（洋葱总线的 `dispatch` 递归与 `try/catch` 软隔离骨架）。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 根目录 `pnpm install` 能解析所有 workspace 包（`@harness/core`、`@harness/extensions`、`apps/agent`）
- [ ] `@harness/core` 对外导出：`bus`（洋葱中间件）、`ctx`、loader、`harness`、`loop`、两个内置工具（`bash`、`str_replace_editor`）
- [ ] `apps/agent` 配置有效 provider API key 后，对一条"需要工具才能回答"的 prompt（例如"列出当前目录文件"）能让模型调用 `bash`、harness 实际执行并把结果回灌进对话
- [ ] denylist 中间件以最高 priority 注册为 `tool` 栈最外层；一条安全命令可正常穿透
- [ ] 损坏的 `bus.ts` 被补全，洋葱 `dispatch` 递归正确、各层 `try/catch` 骨架到位
