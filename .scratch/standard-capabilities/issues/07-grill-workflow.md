# 07: grill —— workflow 形态设计（批次三设计闸门）

**What to build:** 对 workflow 能力做一轮 /grill-with-docs 定案。议题：形态定案——声明式清单文件 vs 轻量 DSL vs 复用 todo/plan 状态加提示词约定；存储位置与作用域（project root 内共享 or 会话私有）；执行语义——模型逐步推进（人每轮触发）vs 一键顺序运行；与 plan/todo 的职责边界（避免三件套功能重叠）；失败步骤的处理语义。

**Blocked by:** None (can start immediately).

**Type:** grilling

**Status:** ready-for-agent

- [ ] 形态、存储、执行语义、与 plan/todo 边界均有决策 + 理由，记入 CONTEXT.md（必要时 ADR）
- [ ] 产出 workflow 实施票清单（后续拆），含验收口径
