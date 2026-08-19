# 05 — Skills 参考扩展

**What to build:** 提供 `skill_load` 工具 + 一个 `llm` 栈中间件，把 skill 的 markdown 内容注入到下一次 LLM 调用的 system prompt 中。验证 extension 扩展 `llm` 洋葱栈的能力（改写 messages / 注入指令）。

**Blocked by:** 01 — 核心运行时 + 端到端 agent loop

**Status:** resolved

- [x] 加载某个 skill 后，其指令出现在下一次 LLM 调用的上下文中
- [x] 模型在该轮按被注入的 skill 指令行为
- [x] 注入逻辑走 `llm` 中间件栈，与 Q15 洋葱模型一致（`session` / `llm` / `tool` 三栈之一）
