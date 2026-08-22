# 01: server 骨架 + attach 函数 + 编排脚本

**What to build:** 新包 `packages/server`（Hono）可从零跑起来：`GET /api/health` 返回 ok；共享「探测 → 拉起 → attach」小函数（探测 health、spawn detached 跑服务端 dist 入口、日志 `~/.applepi/server.log`、EADDRINUSE 自愈重试、`APPLEPI_PORT` 覆盖端口）；根脚本 `pnpm serve`（只起服务端）、`pnpm dev`（ensure server 后起 web）、`pnpm tui`（占位，正式在票 06）。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `packages/server` 建包并入 workspace（依赖 core/bundle/extensions）；`GET /api/health` 通
- [ ] 共享 attach 函数实现并单测：无服务端 → spawn detached 成功且日志入 `~/.applepi/server.log`；有服务端 → 直接 attach；并发撞端口 → 探测重试自愈；`APPLEPI_PORT` 生效
- [ ] 根脚本 `serve` / `dev`（走 attach 函数）/ `tui`（占位）可用
- [ ] 手工验证：`pnpm serve` 独立起、health 通；`pnpm dev` 在无服务端时自动拉起
- [ ] `pnpm -r verify` 绿