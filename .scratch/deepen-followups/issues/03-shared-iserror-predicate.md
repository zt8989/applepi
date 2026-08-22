# 03 — 共享 isError 判定：流式路径复用核心 `looksError`

**What to build:** deepen #03（共享消息契约）的意图是「合并 / 文本提取收敛为单一实现」，
但 `apps/web/lib/chat-store.ts` 的 `attachToolResult`（约 456–477 行）仍在客户端手写
`isError: /^(ERROR|BLOCKED)/.test(String(result))` —— 与 `packages/core/message.ts` 内部
`looksError()` 的正则完全重复：

- 水合路径：`hydrate` → `mergeToolResults`（core 侧用 `looksError` 标记 `isError`）✅
- 流式路径：`attachToolResult`（客户端手写同一正则）❌ 重复

**建议做法：**
1. 从 `packages/core/message.ts` **导出** `looksError`（或更名公开为 `isErrorResult`，
   附 JSDoc：何为错误结果 —— ERROR/BLOCKED 前缀），保持纯函数、无新依赖。
2. `apps/web/lib/chat-store.ts` 的 `attachToolResult` 改为调用该导出（通过
   `@applepi/core/message` 子路径导入，与 `toText/mergeToolResults/pendingApproval` 同源）。
3. 在 `packages/core/test/message.mjs` 补一条直接断言 `isErrorResult` 的用例；
   同时给 web 的 display 或 chat-store 相关测试补流式 isError 覆盖（若当下无 React 环境，
   至少保证 core 侧导出有单测）。
4. 注意此改动是**纯重构**：正则为同一模式，行为不变；`mergeUI` 的类型与形状不动。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] core `message.ts` 导出 `looksError`（公开命名建议 `isErrorResult`），导出路径同步 `packages/core/index.ts` 与 `./message` 子路径。
- [x] `chat-store.ts` `attachToolResult` 改引用共享导出，删除手写正则。
- [x] core `test/message.mjs` 补导出断言；`pnpm -r verify` 全绿。

> 2026-08-22：由 deepen-architecture 5 票实现审查（.scratch/deepen-followups）发现的收敛不彻底问题生成。
> 2026-08-22：完成。`looksError` 公开为 `isErrorResult`（附 JSDoc），经 `@applepi/core/message`
> 子路径导入 chat-store；`test/message.mjs` 补 7 条直接断言。