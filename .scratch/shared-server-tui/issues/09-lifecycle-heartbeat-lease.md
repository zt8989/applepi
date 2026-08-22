# 09: 服务端生命周期精化（心跳租约）

**What to build:** 服务端生命周期收敛：客户端 attach 后注册心跳（周期续命 API），无任何客户端心跳满 5 分钟自动退出；SIGINT 立即退；客户端断开时进行中的流式段自动中止（服务端侧清理断言）。web 壳与 TUI 统一通过 attach 函数发心跳。双客户端同挂/逐退场景验证。

**Blocked by:** 05（web 客户端就位）, 06（TUI 作为第二个心跳源就位）。

**Status:** resolved

- [x] 服务端心跳（`POST /api/heartbeat` 刷新租约）+ idle guard（`APPLEPI_IDLE_TIMEOUT_MS`，默认 5 分钟，0=禁用；退出路径同步写日志后 exit）；SIGINT 立即退（既有）
- [x] 客户端统一心跳 `startHeartbeat(url, intervalMs)`（web 壳 dev-web.mjs + TUI 入口均接入；unref 不拖住客户端退出）
- [x] 客户端断开 → 当前流式段中止（fetch abort → 服务端写失败即段结束，既有语义）
- [x] 进程级测试（heartbeat.mjs 10 项）：app 级 refresh 钩子、短超时子进程保活/熄火、idle-exit 日志、**双客户端**——一方退出服务端仍活、双方退出才熄
- [x] `pnpm -r verify` 绿（23 套件 EXIT 0）