# 02: tool_call / tool_result 生命周期区间事件

**What to build:** 每个工具调用在 jsonl 中拥有完整生命周期区间：生成时写 `tool_call/start`（含 toolCallId / toolName / args / expectsAnswer），自动执行类（auto）紧随写 `tool_call/end`，工具结果写回前后写 `tool_result/start` / `tool_result/end`；待审批（ask）的调用 start 保持开放——其 end 由审批决定写入（票 04）。此票期间新区间事件与旧 `tool/approval-pending` 事件并存，不改变审批流程行为。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 生成 pass 为每条 tool-call part 写 `tool_call/start`（全部工具，含 ask 的 expectsAnswer 载荷）
- [ ] auto 工具执行完成后写 `tool_call/end`（`{ toolCallId, decision: 'approve' }`）；结果写回前后写 `tool_result/start` / `tool_result/end`（均为 `{ toolCallId }`）
- [ ] 事件写入顺序正确（start → end → result start → result end），且落在对应 turn 区间内
- [ ] 此票不改变 ask 工具的暂停/恢复行为（approval-pending 事件照旧，留给票 04 切换）
- [ ] stream-loop 测试断言事件序列（fake streamText 驱动），`pnpm -r verify` 全绿