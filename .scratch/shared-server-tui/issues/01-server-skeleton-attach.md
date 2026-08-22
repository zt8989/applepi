# 01: server 骨架 + attach 函数 + 编排脚本

**What to build:** 新包 `packages/server`（Hono）可从零跑起来：`GET /api/health` 返回 ok；共享「探测 → 拉起 → attach」小函数（探测 health、spawn detached 跑服务端 dist 入口、日志 `~/.applepi/server.log`、EADDRINUSE 自愈重试、`APPLEPI_PORT` 覆盖端口）；根脚本 `pnpm serve`（只起服务端）、`pnpm dev`（ensure server 后起 web）、`pnpm tui`（占位，正式在票 06）。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] `packages/server` 建包并入 workspace（hono 4.13 + @hono/node-server 2.1）；`GET /api/health` 通（app 级 + 进程级请求测试）
- [x] 共享 attach 函数（`ensureServer` / `probeHealth` / `spawnServer` / `serverUrl`）单测全绿：无服务端 spawn detached 成功、日志入 server.log（`APPLEPI_LOG` 可覆盖供测试隔离）、有服务端直接 attach、非 health 占端口拒绝且不悬挂、`APPLEPI_PORT` 生效（含非法值回落默认）
- [x] 根脚本 `serve` / `dev`（build-first + ensure 后起 web 壳）/ `tui`（占位）可用；手工 E2E：`pnpm serve` 独立起 + health 通 + 日志行；`node scripts/tui.mjs` 首次自动拉起、二次 attach 复用同一服务端
- [x] `pnpm -r verify` 绿（server health 4 + attach 11，全仓 EXIT 0）

**实测记录（2026-08-22，`pnpm dev` 完整 E2E，环境：本机 3210/3010 端口干净）：**

- `pnpm dev` 在无服务端时**约 2 秒自动拉起** server（`/api/health` → `{"ok":true,"pid":6172}`，比 8s 超时余量充足）；web 壳随之就绪（3010 HTTP 200），`GET /api/workspaces` 正常返回 JSON。
- `POST /api/chat` 在此环境返回 500，根因 = `~/.applepi/settings.json` 的 `providers` 为空数组，`resolveLlmConfig` 抛出清晰的注册表校验错误（`must be a provider registry`）——**预置语义、响亮报错，非本票回归**（web 代码本票未改动）。真实对话/批准路径待配置提供方后在票 02/03 回归中验证。
- 收尾：服务端与 next dev 进程均已终止，3210/3010 端口释放。