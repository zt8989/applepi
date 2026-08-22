# Spec: Extensions → Extension 单数重命名

> 来源：2026-08-22 命名一致性决策（用户拍板：统一为单数）。
> 包名约定：**包名 = 该包导出的核心概念（单数）**——`core` / `bundle` / `server` 均单数，
> `extensions` 是唯一复数异常；领域词（CONTEXT 词条）本就是单数 **Extension（扩展）**。
> 将 `@applepi/extensions` 更名为 `@applepi/extension`（目录 `packages/extension`）。

**范围：** 包目录与包名 + 全部代码引用方 + 文档/历史 ADR 修订注记。纯机械重命名，
无行为变更；每步保持全仓 `pnpm verify` 绿。

**测试与验证：** 改名后 `pnpm -r verify`（23 套件）全绿；全仓 grep
`@applepi/extensions` 与 `packages/extensions` 归零（历史 ADR 的说明性修订注记除外，
注明旧名）。