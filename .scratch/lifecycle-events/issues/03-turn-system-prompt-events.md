# 03: turn / system_prompt 事件（回合边界 + 原子单事件）

**What to build:** 每轮 LLM 生成在 jsonl 中有 `turn/start` + `turn/end` 成对记录（end 带 `finishReason`：stop / tool-calls / max-turns / error；一次生成迭代即一个 turn，end 不悬跨 HTTP 段）；系统提示词每次组装记录单事件 `system_prompt/set { sections }`（原子动作、不允许暂停，无 start/end）。replay 语义不变——LLM 上下文仍只由消息行构建，旧会话照常 resume。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 每次 LLM 生成迭代写 `turn/start` 与 `turn/end`；finishReason 正确映射（ask 暂停 → tool-calls；自然结束 → stop；超轮 → max-turns；异常 → error）
- [ ] 系统提示词组装处写 `system_prompt/set` 单事件（无 start/end）
- [ ] 消息行 replay 输出与改造前一致（回归）；含旧事件行的旧 jsonl 照常 resume
- [ ] stream-loop 与 session 测试覆盖（含 finishReason 各分支、system_prompt 原子性），`pnpm -r verify` 全绿

## Comments

- **实施注记（2026-08-22）**：turn 粒度实现为**流式段**（`runLoopStreamSegment` 一次调用 = 一个 HTTP 请求内的 loop 执行，可含多轮自动工具迭代），非字面的「每次 while 迭代」。理由：finishReason 枚举是段级终因，「自动迭代继续」的中间轮次在枚举中无对应值；按迭代切会产生无终因的中间 turn。spec 与 ADR-0018 的 turn 边界措辞已同步修订。验收第 1 条按此口径满足（每段一对 start/end，四种 finishReason 映射均有测试覆盖）。
- `system_prompt/set` 载荷实现为 `{ sections: [mode] }`（组装来源标识 = bundle/mode 段）；spec 载荷说明已同步。