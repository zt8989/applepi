# 06: grill —— subagent 编排设计（批次三设计闸门）

**What to build:** 对 subagent 能力做一轮 /grill-with-docs 定案。议题：子循环复用方式（core 流式 loop 重入的形态）；审批嵌套策略——子代理遇到 ask 工具时是冒泡到主会话卡片还是按主会话级别预授权；trace 层级与会话/审计归属（子循环写不写主 jsonl、Langfuse span 嵌套）；终止/超时与结果回传形态；子代理可用能力集（跑 base 还是 standard 子集）。

**Blocked by:** None (can start immediately).

**Type:** grilling

**Status:** ready-for-agent

- [ ] 每个议题有决策 + 理由，记入 CONTEXT.md（必要时 ADR）
- [ ] 产出 subagent 实施票清单（后续拆），含验收口径
