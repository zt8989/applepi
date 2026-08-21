# 02 — 深化 SessionStore：会话智能收进 core

**What to build:** 把「会话叫什么 / 钉没钉 / 开没开提醒 / 按 mtime 排序列出」等会话展示智能从 web 层（`apps/web/lib/server.ts` 手撕 jsonl）收进 core 的 `SessionStore`，新增 `title()` / `pinned()` / `notify()` / `listSessions()`（排序）等语义化读取原语。web 的 route 只取数转发，不再 `fs.readFile` 逐行 parse。这与 ADR-0016 已定方向一致——`loadConfig/saveConfig` 原语也归 core session 模块。先于实现做一轮 grill（接口形状、与 ADR-0016 配置迁移的衔接）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Grill：settled SessionStore 新增原语的接口与返回形状，确认与 ADR-0016 配置迁移的衔接点。
- [x] `packages/core/session.ts` 新增 `title()` / `pinned()` / `notify()` / `listSessions()` 等，基于已有 `lastEvent` / 文件读取，不重复解析逻辑。
- [x] web `server.ts` 的 `sessionTitle` / `sessionPinned` / `sessionNotify` / `listWorkspaces` 改为调用 core 原语，删除手撕 jsonl。
- [x] 新增 / 调整 core 或 web 测试覆盖新原语。
- [x] `pnpm -r build && pnpm -r test` 全绿。
