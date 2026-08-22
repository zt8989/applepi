# 04: 长尾路由迁入服务端

**What to build:** 余下 agent API 迁入服务端：`/api/files`（工作区根约束的安全递归列举）、`/api/config*`（providers/models/general/last-used-level）、`/api/pick-folder`（osascript 目录选择）。请求/响应契约不变；各自的冒烟/请求级测试。至此全部 agent API 在服务端就绪。

**Blocked by:** 01（server 骨架）。

**Status:** resolved

- [x] `/api/files` 迁入（跳过 .git/node_modules/.next 等、深度/预算/条数上限不变）
- [x] `/api/config`、`/api/config/general`、`/api/config/providers`、`/api/config/models`、`/api/config/last-used`、`/api/config/last-used-level`、`/api/config/open-file` 迁入
- [x] `/api/pick-folder` 迁入（非桌面环境降级语义不变）；全部 web 路由退化为薄委托
- [x] 冒烟测试（longtail.mjs 6 项，只走安全路径）：files 枚举/过滤/跳 node_modules/校验 400；config 空注册表容忍；general/providers/last-used 校验前置拒绝；models anthropic 405；open-file hidden 探针；pick-folder 非 macOS 400
- [x] `pnpm -r verify` 绿（server 5 套件，全仓 EXIT 0）

> **测试事故披露**：longtail.mjs 初版误把 `{providers:{}}` 当作非法载荷 PUT 到 `/api/config/providers`，实际写入了一次真实 `~/.applepi/settings.json`（把原本破损的 `providers: []` 空数组改写为 `providers: {}` 空对象——两者均为无提供方空态，应用语义等价；原有破损态并非可用配置）。用例已改为真正缺键的 400 场景；路由行为本身正确（空对象是最小合法载荷，删除全部提供方的语义）。