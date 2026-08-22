# 01: Extensions → Extension 单数重命名

**What to build:** 包名统一为单数（包名 = 核心概念名约定）：`packages/extensions`
目录与 `@applepi/extensions` 包更名为 `packages/extension` / `@applepi/extension`，
并同步全部代码引用方与文档。纯机械重命名、零行为变更——改名后全仓
`pnpm -r verify` 保持 23 套件全绿，这是验收红线。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 包重命名：`packages/extensions` → `packages/extension`；`package.json` name 改 `@applepi/extension`
- [ ] 代码引用方全部切换：bundle 包的 `base.ts` / `standard.ts` / `assemble.ts` 三处源码 import、bundle `package.json`（scripts 中的过滤构建 + dependencies）；`packages/server` 与 `apps/web` 的 `package.json` 依赖（及 web 源码若引用）；`packages/core/test/stream-loop.mjs` 的 `../../extensions/dist/index.js` 路径导入
- [ ] `pnpm install` 重链 lockfile；`pnpm -r verify` 全绿（23 套件）
- [ ] 文档同步：CONTEXT.md（15 处 + 新增包名约定词条「包名 = 核心概念名单数」）、docs/architecture.md（§3/§11/图）、docs/design-principles.md、docs/README.md、`.scratch/standard-capabilities/spec.md`；ADR-0005（该包引入的决策）与其他波及 ADR 追加**修订注记**（不改写历史正文，注明旧名→新名）
- [ ] 收尾：全仓 grep 无 `@applepi/extensions` / `packages/extensions` 残余（历史 ADR 修订注记与 CONTEXT 历史段允许说明性提及旧名）