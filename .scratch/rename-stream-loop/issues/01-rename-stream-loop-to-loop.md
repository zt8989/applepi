# 01: 文件更名 stream-loop.ts → loop.ts（零行为变更）

**What to build:** core 的 loop 深模块文件名与架构文档中的模块名对齐：`packages/core/stream-loop.ts` 更名为 `packages/core/loop.ts`，测试文件 `test/stream-loop.mjs` 同步更名为 `test/loop.mjs`。对用户零行为变更——导出面（`runLoopStreamSegment` / `executeApprovedTool` / `classifyApproval` / `pendingToolCalls` 及类型）不变，唯一 barrel import 与 package.json 测试脚本指向更新后全仓 verify 全绿。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] `stream-loop.ts` → `loop.ts`、`test/stream-loop.mjs` → `test/loop.mjs`（git mv 保留历史）
- [x] 构建图内旧路径引用清零：core barrel import、package.json test 脚本
- [x] 零行为变更：core 测试套件原样通过，`pnpm -r verify` 全绿
