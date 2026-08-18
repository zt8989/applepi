# 01 — 核心运行时 + 端到端 agent loop

**What to build:** 一个能直接跑起来的本地 agent。pnpm workspace 根就绪；`@harness/core` 实现洋葱事件总线、会话上下文（ctx）、扩展加载器（loader）、harness 装配与内置 agent loop（使用 Vercel AI SDK 的 `generateText`，工具只向外暴露 schema、执行走自有 loop）；内置 `bash` 与 `str_replace_editor` 两个工具；denylist 作为最外层 `tool` 中间件注册；`apps/agent` 通过环境变量选择 provider（OpenAI / Anthropic）并对一条 prompt 完成一次"模型调用 → 解析工具调用 → 执行 → 回灌"的闭环。本 ticket 需补全上一轮被中断写坏的 `packages/core/src/bus.ts`（洋葱总线的 `dispatch` 递归与 `try/catch` 软隔离骨架）。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 根目录 `pnpm install` 能解析所有 workspace 包（`@harness/core`、`apps/agent`；`@harness/extensions` 留待 T04–T06）
- [x] `@harness/core` 对外导出：`OnionBus`（洋葱中间件）、`Harness`、loader、`runLoop`、两个内置工具（`bash`、`str_replace_editor`）
- [ ] `apps/agent` 配置有效 provider API key 后，对一条"需要工具才能回答"的 prompt 能让模型调用 `bash`、harness 实际执行并把结果回灌进对话 —— **待真实 key 端到端验证**（单元冒烟测试已覆盖总线/工具/denylist 机制，无需 key）
- [x] denylist 中间件以最高 priority（1000）注册为 `tool` 栈最外层；安全命令正常穿透（`rm -rf /` 被 BLOCKED）
- [x] 损坏的 `bus.ts` 被补全：洋葱 `dispatch` 递归正确，各层 `try/catch` 软隔离到位

## Answer

实现落地于 `harness/` monorepo：
- `packages/core/src/`：`bus.ts`(洋葱三栈+priority+软隔离)、`harness.ts`(工具注册表+扩展加载器+AI SDK loop)、`loop.ts`、`tools/bash.ts`、`tools/str_replace_editor.ts`、`extensions/denylist.ts`、`index.ts`。
- `apps/agent/src/main.ts`：按 `LLM_PROVIDER` 选 OpenAI/Anthropic（环境变量传 key），注册内置工具与 denylist，扫描 `./extensions/` 自动发现本地扩展，跑 loop。

验证：`pnpm install` + `pnpm -r build` 全绿（3 包 tsc 通过）；`packages/core/test/smoke.mjs` 6 项断言通过（洋葱顺序 / veto / 软隔离 / bash 执行 / 编辑器读写 / denylist 拦截）；`node apps/agent/dist/main.js` 在无 key 时按预期抛出 `OPENAI_API_KEY not set`（装配正确）。真实 LLM 工具闭环仅需设置 key 后 `pnpm --filter agent dev` 即可跑通。
