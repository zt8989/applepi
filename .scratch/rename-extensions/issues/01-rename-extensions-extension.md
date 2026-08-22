# 01: Extensions → Extension 单数重命名

**What to build:** 包名统一为单数（包名 = 核心概念名约定）：`packages/extensions`
目录与 `@applepi/extensions` 包更名为 `packages/extension` / `@applepi/extension`，
并同步全部代码引用方与文档。纯机械重命名、零行为变更——改名后全仓
`pnpm -r verify` 保持 23 套件全绿，这是验收红线。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 包重命名：`packages/extensions` → `packages/extension`；`package.json` name 改 `@applepi/extension`
- [x] 代码引用方全部切换：bundle `base.ts`/`standard.ts`/`assemble.ts`/`types.ts` 四处源码 import、bundle scripts 过滤构建 + dependencies、server/web `package.json` 依赖、core 测试 `../../extension/dist/index.js` 路径导入、extension 自身测试头注释；`pnpm install` 重链 lockfile
- [x] `pnpm -r verify` 全绿（23 套件，重建后 dist 同步）
- [x] 文档同步：CONTEXT（9 处替换 + 新增「包名约定」词条：包名 = 核心概念名单数）、architecture.md（§3/图/依赖行/布局/验证清单）、design-principles、README、standard-capabilities spec；ADR-0005 等 13 份波及 ADR 追加「修订注记」（正文沿用决策当时名称）
- [x] 全仓 src/live-doc grep 无旧名残余（仅已删 CLI 的未跟踪 dist 死产物与 ADR 修订注记/词条的说明性提及）

**提交：** `99cb4f9`（改名 + 代码引用方，verify 绿）→ 文档提交紧随。