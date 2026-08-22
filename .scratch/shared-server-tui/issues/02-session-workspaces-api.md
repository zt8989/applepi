# 02: session / workspaces API 迁入服务端

**What to build:** 服务端持有每 (workspace, mode) harness 缓存与 `apps/web/lib/server.ts` 的会话/工作区核心操作（bindSession、sessionMode、sessionTitle、loadConfig 等），并对外提供 `/api/session`（GET hydrate + PATCH 动作含 pending 解析）与 `/api/workspaces`（GET/POST，manifest 语义）——请求/响应契约与 web 现状完全一致。请求级测试：hydrate、会话列表、工作区注册。

**Blocked by:** 01（server 骨架）。

**Status:** ready-for-agent

- [ ] harness 缓存（每 (workspace, mode)）与会话绑定/恢复/配置操作迁入服务端
- [ ] `/api/session` GET（messages/level/reasoning/mode/title/pending）+ PATCH（rename/pin/unpin/archive/unarchive/notify/level）在服务端可用，契约不变
- [ ] `/api/workspaces` GET/POST 在服务端可用（manifest-only 语义，ADR-0013）
- [ ] 请求级测试（`fetch(app.request)`）：hydrate 形状、会话动作、工作区注册/列表
- [ ] `pnpm -r verify` 绿