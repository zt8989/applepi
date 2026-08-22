# 08 — Workspace 构建 + 运行验证

**What to build:** 端到端验证整个 monorepo 可构建、可运行。`pnpm install && pnpm -r build` 全绿，`pnpm --filter agent dev` 能跑通一条 prompt 的完整闭环；各包的 tsconfig 正确串联。这是对 T1–T7 所有垂直切片的集成验收。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop、02 — 本地扩展自动发现 + hello 工具、03 — Denylist 安全闭环、04 — Memory 参考扩展、05 — Skills 参考扩展、06 — MCP 参考扩展（bash + mcp-cli 桥）、07 — 软隔离（misbehaving middleware）

**Status:** resolved —— dc61f94（票面标注过期，实现已随对应提交落地，2026-08-22 审计修正）

- [ ] 所有 workspace 包构建无 TypeScript 错误
- [ ] `apps/agent` 能成功跑完 "prompt → 工具调用 → 结果回灌" 的完整一轮
- [ ] 可追溯性：每个参考扩展（T04/T05/T06）与安全/健壮性切片（T03/T07）均被逐一验证通过
- [ ] 损坏的 `bus.ts` 已修复并纳入构建（T01 交付项）
