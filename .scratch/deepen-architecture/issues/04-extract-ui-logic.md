# 04 — 纯展示逻辑移出 React 组件

**What to build:** 把困在 `'use client'` 组件里的纯逻辑抽到 `apps/web/lib/`：`estimateUsage` / `contextLimit` / `formatTokens` / `toText` 和 `LEVEL_META` / `REASONING_META` / `MODES` 标签常量。组件只做渲染。上下文预算估算邻近模型配置放。先于实现做一轮 grill（哪些函数 / 常量、放哪个 lib 文件）。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] Grill：settled 抽出的函数 / 常量清单与 `lib/` 文件划分。
- [x] 新建 `apps/web/lib/display.ts`（或类似），迁移 `estimateUsage` / `contextLimit` / `formatTokens` / `toText` 与标签常量；`contextLimit` 邻近模型配置。
- [x] `chat-ui` / `composer-footer` / `settings-modal` / `sidebar` 改为只引用 lib 常量、渲染逻辑。
- [x] 为纯函数补单测（不依赖 React）。
- [x] `pnpm -r build && pnpm -r test` 全绿。
