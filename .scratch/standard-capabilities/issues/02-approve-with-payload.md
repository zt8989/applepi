# 02: ask_user 载荷机制 —— approve 可携带答案（prefactor）

**What to build:** core 流式 loop 的暂停/恢复路径扩展 **approve-with-payload**：approve 决定可携带一段载荷（用户的答案文本），续跑时该 pending 工具调用的工具结果 = 答案文本（而非执行工具），完整回填消息流与 jsonl；deny 语义不变。web 侧：批准路由接受可选答案字段并透传 core；前端批准卡片在 pending 标记「需要答案」时走文本输入提交路径。本票只做机制，用探针工具在 core 缝上验证；真实 ask_user 能力在 #03 接线。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] core 续跑原语 `executeApprovedTool` 支持 approve-with-payload（新增 `answer?` 参数）：载荷成为该 toolCallId 的工具结果（`assistant(tool-call) → tool(result=答案)` 完整持久化），工具的 `execute` **不被调用**；deny 语义不变
- [x] 暂停 pending 结构（core 双份 PendingApproval + web PendingApprovalInfo + ToolSpec.expectsAnswer）携带「期望答案」标记；对现有二元 approve/deny 完全向后兼容（既有测试不改仍绿）
- [x] web 批准路由 `/api/chat/approve` 接受并透传 `answer`；下一 pending part 由工具 spec 补 `expectsAnswer`；`/api/session` GET 返回服务端解析的 `pending`（含 expectsAnswer，刷新后 ask_user 卡片形态不丢）；chat-store `respond(decision, answer?)` + handleData/hydrate 消费标记；批准卡片渲染文本输入路径（提交回答/拒绝）；`tsc` 全绿
- [x] core 假 LLM 单测（stream-loop.mjs 新增 5b/5c）：user_input 探针暂停 → part+事件带 expectsAnswer:true → `execute` 未被调用、结果=答案、pending 清空；deny 路径行为不变（既有测试 5 通过）
