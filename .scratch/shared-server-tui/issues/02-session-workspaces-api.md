# 02: session / workspaces API 迁入服务端

**What to build:** 服务端持有每 (workspace, mode) harness 缓存与 `apps/web/lib/server.ts` 的会话/工作区核心操作（bindSession、sessionMode、sessionTitle、loadConfig 等），并对外提供 `/api/session`（GET hydrate + PATCH 动作含 pending 解析）与 `/api/workspaces`（GET/POST，manifest 语义）——请求/响应契约与 web 现状完全一致。请求级测试：hydrate、会话列表、工作区注册。

**Blocked by:** 01（server 骨架）。

**Status:** resolved

- [x] harness 缓存（每 (workspace, mode)）+ 会话绑定/恢复/配置操作迁入服务端（`lib/server.ts` 整体迁入 `@applepi/server` 并删除，web 无重复源；`sessionsRoot()` 支持 `APPLEPI_SESSIONS_DIR` 隔离）
- [x] `/api/session` GET（messages/level/reasoning/mode/title/pending）+ PATCH（rename/pin/unpin/archive/unarchive/notify/level/reasoning/model）在服务端可用，契约不变（web 路由改为薄委托）
- [x] `/api/workspaces` GET/POST/PATCH 在服务端可用（manifest-only 语义，ADR-0013）
- [x] 请求级测试（`fetch(app.request)`，`APPLEPI_SESSIONS_DIR` 隔离）：hydrate 形状、全部会话动作、归档往返、jsonl 导出、校验路径 400
- [x] `pnpm -r verify` 绿（server health 4 + attach 11 + session/workspaces 11，全仓 EXIT 0）