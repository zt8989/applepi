# 02 — 从 core 移除非流式 loop（runLoop）

**What to build:** core 只暴露 web 界面所用的**流式** agent loop。单回合非流式 loop 函数及其支撑面全部删除：非流式模型调用面（仅被该 loop 使用）、`Harness` 上供 CLI 单回合的便捷 turn 方法、以及它们的导出。曾引用该 loop 的 core/extensions 测试改为沿用保留的循环/工具执行路径（闭环用例直接经工具执行缝驱动，不再经被删 loop）。删除后无残留引用，整体构建与验证绿。

**Blocked by:** 01 — 删除 CLI 应用（apps/agent）

**Status:** resolved —— 610efc2（票面标注过期，实现已随对应提交落地，2026-08-22 审计修正）

- [ ] 非流式 loop 函数不再存在；`index` 导出不再含它及其配套类型（依赖包重建后无 TS 解析错误）
- [ ] 非流式模型调用面及其 `Harness` turn 便捷方法已移除；流式路径（供 web 的 loop）保持不变
- [ ] core/extensions 中引用被删 loop 的测试已重做（闭环用例改经工具执行缝直接驱动）并通过
- [ ] `pnpm -r verify` 全绿；grep 被删符号无残留引用（node_modules、dist 除外）
