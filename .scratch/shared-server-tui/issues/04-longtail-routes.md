# 04: 长尾路由迁入服务端

**What to build:** 余下 agent API 迁入服务端：`/api/files`（工作区根约束的安全递归列举）、`/api/config*`（providers/models/general/last-used-level）、`/api/pick-folder`（osascript 目录选择）。请求/响应契约不变；各自的冒烟/请求级测试。至此全部 agent API 在服务端就绪。

**Blocked by:** 01（server 骨架）。

**Status:** ready-for-agent

- [ ] `/api/files` 迁入（跳过 .git/node_modules/.next、深度/预算/条数上限不变）
- [ ] `/api/config`、`/api/config/providers`、`/api/config/models`、`/api/config/general`、`/api/config/last-used-level` 迁入
- [ ] `/api/pick-folder` 迁入（非桌面环境降级语义不变）
- [ ] 请求级/冒烟测试各路由（非法 workspace 拒绝、缺失 provider 行为不变）
- [ ] `pnpm -r verify` 绿