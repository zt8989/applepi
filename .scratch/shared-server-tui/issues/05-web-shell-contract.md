# 05: web 壳契约切换（行为不变红线）

**What to build:** web 从「内嵌后端」切为「页面壳」：删除全部 API 路由与 `lib/server.ts` 后端代码；`next.config` `rewrites()` 代理 `/api/*` → `127.0.0.1:3210`（浏览器同源、CORS 不开）；`pnpm dev` 经 attach 函数 ensure server。**验收红线：web 行为与改造前不变**——对话、工具批准（含 ask_user 文本卡片）、会话侧栏（列表/重命名/置顶/归档/通知/导出）、工作区选择、设置（模型/通用/推理等级）、文件引用、pick-folder 全流程可用。

**Blocked by:** 02, 03, 04（全部 agent API 已在服务端）。

**Status:** ready-for-agent

- [ ] web 删除全部 agent API 路由与后端逻辑；`rewrites()` 代理 `/api/*` ≥ 服务端端口
- [ ] `pnpm dev` 走 attach 函数（无服务端自动拉起）
- [ ] 手工全流程回归：对话/批准/ask_user 卡片/侧栏操作/工作区/设置/文件引用/pick-folder 与改造前一致
- [ ] web `tsc` 全绿；`pnpm -r verify` 绿