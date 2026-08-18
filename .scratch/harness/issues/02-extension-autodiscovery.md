# 02 — 本地扩展自动发现 + hello 工具

**What to build:** 往 `apps/agent/extensions/` 丢一个 `*.ext.ts`，无需改动任何加载器或 harness 代码，其声明的工具就被自动注册并可供模型调用。验证 loader 的目录扫描机制与 extension 的拉模式契约（`setup(api)` 中调 `api.register_tool(...)`）。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** resolved

- [x] 一个定义 `hello` 工具的示例扩展被自动发现，模型可成功调用该工具
- [x] 增加 / 删除扩展文件后，可用工具集合随之变化，且无需编辑 loader 代码
- [x] 自动发现机制与 Q12/Q14 锁定的"本地 `extensions/` 目录扫描"一致（信任模型 = 本机自有代码）

## Answer

- 样品：`apps/agent/extensions/hello.ext.ts`（`export default setup(api)` 拉模式注册 `hello` 工具）。
- 修正 `apps/agent/src/main.ts` 扩展目录解析：`new URL('./extensions/')` → `../extensions/`（相对 `src/main.ts` 指向 `apps/agent/extensions/`，符合规格"本地 `extensions/` 目录"语义；dev 与 build 两种运行态都解析到同一目录）。
- 验证脚本：`apps/agent/scripts/check-ext.ts`（`pnpm --filter agent check-ext`，tsx 运行，无需 API key）。
- core 级回归：`packages/core/test/fixtures/echo.ext.mjs` + `smoke.mjs` 用例 7/8，纯 `node` 下验证 loader 扫描 `*.ext.{ts,js,mjs}` 并走 `setup(api)` 拉模式契约；空目录返回 [] 证明"增删文件即增删工具、无需改 loader"。
- 验证：`pnpm -r build` 全绿；`node packages/core/test/smoke.mjs` 8/8 通过；`tsx scripts/check-ext.ts` 输出 `loaded extensions: ['hello.ext.ts']` + `registered tools: ['hello']` + `OK`。
- 已知边界：构建态 `node dist/main.js`（`start`）下 `extensions/` 内 `.ts` 无法被纯 node 动态 import，主路径为 tsx dev（`pnpm --filter agent dev`）；如需 build 态也支持，可将扩展写成 `.mjs` 或预编译。
