# 03 — 共享 typed message 契约

**What to build:** 在 `@applepi/core`（或共享 d.ts）声明一条消息契约（ThreadMessage like），让 web 的 `hydrate` 只消费它、不再重新合并 `tool → tool-call` part；把「从 content parts 取文本」收敛为单一 `toText()`。暂停/恢复（approve/deny → resume）协议成为可在 core 侧单测的纯函数，不再跨 core/server/client 三端各自 `any`。先于实现做一轮 grill（契约字段、与 stream-loop 的衔接）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Grill：settled 契约的字段形状与暂停/恢复消息的 wire 类型。
- [x] 在 core 导出消息契约类型；`stream-loop` 产出符合契约的消息。
- [x] web `chat-store.ts` 的 `hydrate` 改为纯消费契约；合并 / 文本提取收敛为单 `toText()`。
- [x] 为合并 / 恢复逻辑补 core 侧单测（不依赖 React）。
- [x] `pnpm -r build && pnpm -r test` 全绿。
