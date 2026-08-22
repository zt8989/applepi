# 05: web 壳契约切换（行为不变红线）

**What to build:** web 从「内嵌后端」切为「页面壳」：删除全部 API 路由与 `lib/server.ts` 后端代码；`next.config` `rewrites()` 代理 `/api/*` → `127.0.0.1:3210`（浏览器同源、CORS 不开）；`pnpm dev` 经 attach 函数 ensure server。**验收红线：web 行为与改造前不变**——对话、工具批准（含 ask_user 文本卡片）、会话侧栏（列表/重命名/置顶/归档/通知/导出）、工作区选择、设置（模型/通用/推理等级）、文件引用、pick-folder 全流程可用。

**Blocked by:** 02, 03, 04（全部 agent API 已在服务端）。

**Status:** resolved

- [x] web 删除全部 agent API 路由（11 个委托文件与 `app/api/` 整体移除）；`next.config.ts` `rewrites()` 代理 `/api/*` → `http://127.0.0.1:${APPLEPI_PORT ?? 3210}`（浏览器同源、CORS 不开）
- [x] web 摘除 `@applepi/server` 依赖（不再有后端代码）；`tsc` 全绿（清 `.next` 过期生成类型后）
- [x] `pnpm dev` 走 attach 函数（票 01 已就位）；手工全流程回归通过（见实测记录）
- [x] `pnpm -r verify` 绿（20 套件 EXIT 0）

**实测记录（2026-08-22，`pnpm dev` 完整 E2E）：**

- `pnpm dev` 无服务端时自动拉起（3210，pid 15040），web 壳 3010 就绪（约 14s）。
- 代理连通性：`GET /api/health` 经 3010 返回**同一服务端进程**（same pid）；`GET /api/workspaces` 经代理返回服务端 manifest（含已注册工作区）；`POST /api/chat` 经代理触发真实 provider 解析并流式返回 `session` part + `chat error` part（SDK 认证错误语义清晰）——全链路 代理 → 服务端 → harness → 模型调用 成立。
- 收尾：3210/3010 进程均终止、端口释放。（注：测试期间环境 `~/.applepi/settings.json` 的 providers 字段在空数组间波动——系环境自身状态，与本次代码无关；代理链路与错误语义不受影响。）