# 01 — Bundle 提示词诚实化：让「提示词说哪些工具」与实际注册同源

**What to build:** 在 `@applepi/bundle` 中，让每个会话 system prompt 里「Tools available」一行由装配时真正解析出的注册表（`spec.tools` ∪ 已落地 capability 的工具）生成，而不是手写字符串。standard 会话不再向模型声称未接线的 web/todo/subagent/workflow 等能力；base/standard 共用一个 `permissionFragment(env, tools)` 渲染器（顺带消解候选 #5 的权限片段重复）；`enableBundleSpec` 对声明但无工厂的 capability id 打 `console.warn`；standard 人格收敛为 minimal（与 base 同串）；新增测试 (a–d) 并改 test #3；更新 CONTEXT.md 并把 ADR-0015「standard 自有 prompt」条款记为已软化。

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] `assemble.ts` 新增共享 `permissionFragment(env, tools: string[]): string`，统一渲染 `## Permission & Capability` + project root + `Tools available:` + 三档 level 行（base/standard 共用，无 footnote）。
- [x] `assembleFlatPrompt` 改为从 `spec.tools` + 已落地 capability 的工具计算 `resolvedTools`（去重），并把权限片段插入 persona 之后、capability 片段之前（顺序保持 bundle → capability → app → plugin）。
- [x] `enableBundleSpec` 对 `getCapability(id)` 缺失的声明 id 调用 `console.warn`。
- [x] `base.ts` / `standard.ts` 的 `make()` 的 `prompt` 改为仅 `[BASE_PROMPT]` / `[STANDARD_PROMPT]`；删除 `basePermissionFragment` / `standardPermissionFragment` 函数。
- [x] `STANDARD_PROMPT` 设为 `'You are a helpful software engineer assistant.'`（与 `BASE_PROMPT` 同串）；`STANDARD_CAPABILITIES` 保留不动（test #2 依赖）。
- [x] `index.ts` 移除旧 fragment 导出、导出新增的 `permissionFragment`。
- [x] `bundle.mjs` 新增 (a) 提示词只列真实工具且不含未接线名；(b) 不含旧 full-capability 人格文本；(c) `enableBundleSpec` 触发 warn；(d) 提示词工具名集合 == harness 实际注册集合（防漂移）；并把 test #3 改为只校验 sibling/结构、去掉 persona 相等性断言。
- [x] 更新 CONTEXT.md 中 standard 描述；记录 ADR-0015 修订注记（standard 与 base 现共享 minimal 人格，软化 own-prompt 条款）。
- [x] `pnpm --filter @applepi/bundle test`（build-first）全绿。
