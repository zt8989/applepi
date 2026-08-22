# 04 — 删除 Harness.listSessions() 死代码

**What to build:** `packages/core/harness.ts` 的 `listSessions()`（约 131–135 行）：

```ts
/** Enumerate sessions in the current workspace (delegates to core SessionStore). */
listSessions(): Promise<string[]> {
  const ws = this.sessionStore?.workspace ?? this.workspace;
  return new SessionStore({ workspace: ws }).list();
}
```

全库检索确认 **没有任何调用者**：web 侧会话列表已改用 deepen #02 的语义化原语
`store.listSessions()`（返回 `SessionSummary[]`，含 title/pinned/notify + mtime 排序，
`apps/web/lib/server.ts` 的 `listWorkspaces`），该方法是从 ADR-0015 实现期遗留的、
只返回 id 列表的旧形态。属于死代码，按「确定无用即可彻底删除」清理。

**建议做法：**
1. 删除 `Harness.listSessions()`；确认 `SessionStore.list()`（返回 id 列表）仍被使用
   （例如 `/sessions` 语义、测试），**不删除**——只删 harness 层的旧转发。
2. 检查 harness.ts 的注释/文档是否引用该方法，一并清理。
3. `pnpm -r verify` 全绿（build + test，重点是 core 测试与 web typecheck）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] 删除 `Harness.listSessions()` 及任何相关 JSDoc 残留。
- [x] 确认 `SessionStore.list()` 仍有正当引用（否则一并处理，单独判断）。
- [x] `pnpm -r verify` 全绿。

> 2026-08-22：由 deepen-architecture 5 票实现审查（.scratch/deepen-followups）发现的死代码生成。
> 2026-08-22：完成。`Harness.listSessions()` 已删；`SessionStore.list()` 保留（`test/session.mjs` 仍引用，
> 作为 id 枚举原语）。