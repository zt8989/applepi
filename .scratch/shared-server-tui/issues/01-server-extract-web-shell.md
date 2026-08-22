# 01: 服务端抽取 + web 壳改造（ADR-0017）

**What to build:** 新包 `packages/server`（Hono，默认 `127.0.0.1:3210`，`APPLEPI_PORT` 可覆盖，`GET /api/health`）：把 web 的内嵌后端整体迁入——每 (workspace, mode) harness 缓存与 `lib/server.ts` 的全部操作、以及 `/api/chat`、`/api/chat/approve`、`/api/session`、`/api/workspaces`、`/api/files`、`/api/config*`、`/api/pick-folder` 路由，按现有语义搬移（流式线格式与请求/响应契约不变）。`apps/web` 删后端与 API 路由，`next.config` `rewrites()` 代理 `/api/*` → 服务端；新增根脚本 `pnpm serve`（只起服务端）与共享「探测→拉起→attach」小函数（spawn detached、日志 `~/.applepi/server.log`、EADDRINUSE 自愈）。**验收红线：web 行为不变——`pnpm dev` 起页面后，对话/工具批准（含 ask_user 文本卡片）/会话侧栏/工作区/设置全走服务端且与改造前一致。**

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `packages/server` 建包：Hono app，`/api/health` 返回 ok；所有 agent 路由按现有契约迁移（请求/响应 body 与 data-stream 线格式不变）；`streamTextCall` 注入缝存在（测试用假 LLM）
- [ ] harness 缓存与全部会话/工作区/配置操作自 `apps/web/lib/server.ts` 迁入，web 不再持有后端
- [ ] web 壳：API 路由删除；`rewrites()` 代理 `/api/*` 到 3210；页面/客户端代码零改动（fetch 仍同源）
- [ ] 根脚本：`serve` / `dev`（ensure server 后起 web）/ `tui`（先占位或最小 echo，正式在票 02）；共享 attach 函数（探测→spawn detached→重试自愈、`APPLEPI_PORT`）
- [ ] 服务端请求级测试（`fetch(app.request)` + 假 LLM：流式段、批准暂停/载荷续跑、会话/工作区 API 冒烟）全绿
- [ ] 手工 E2E：`pnpm dev` 页面对话 + approve + ask_user 卡片 + 会话侧栏全流程可用；`pnpm serve` 独立可起、`/api/health` 通
- [ ] `pnpm -r verify` 绿