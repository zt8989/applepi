# Spec: jsonl 生命周期事件模型（lifecycle events）

> 来源：2026-08-22 设计对话（事件分类原则：可暂停过程 → start/end 对，不可暂停原子操作 → 单事件）。
> 状态：**ready-for-agent**。
> 测试缝：core 级（`SessionStore` 原语 + `streamTextCall` 注入缝的 stream-loop 测试，沿用 `packages/core/test`）与 server 请求级（`fetch(app.request)`，沿用 `packages/server/test`）。理想缝 = core 的会话存储原语（写入/扫描），其余消费方随之上层调整。

## Problem Statement

jsonl 会话文件目前混入两类不相干的事件：UI 状态类（`title/set`、`pin/set`、`notify/set`）与一次性审计类（`tool/approval-pending`）。而真正有过程语义的阶段——每轮 LLM 生成（turn）、工具调用（含审批挂起）、工具结果异步返回——全是单点事件或无事件记录，表达不了「开始 / 中断 / 结束」。恢复审批被迫依赖一个专门事件（按事件名读最后一个），UI 元数据又污染了审计流。需要按「过程 vs 原子」重分事件族：可暂停的过程必须有 start/end 区间（中断 = 区间开放），不可暂停的原子操作只留单事件点。

## Solution

- **分类原则**：可能暂停/中断的过程型事件一律 start/end 成对（`turn`、`tool_call`、`tool_result`）；不允许暂停的原子操作只有单事件（`system_prompt/set`）。中断 = 有 start 无配对 end 的开放区间，无需专门的「中断标记」事件。
- **事件族**：
  - `system_prompt/set`（原子：一次性组装，写即完成）
  - `turn/start` / `turn/end`（一轮 LLM 生成；end 带 `finishReason: stop | tool-calls | max-turns | error`）
  - `tool_call/start` / `tool_call/end`（一个工具调用全生命周期：生成 → 审批（可能挂起）→ 执行/拒绝；end 带 `decision: approve | deny`）
  - `tool_result/start` / `tool_result/end`（结果异步返回区间：start = 结果开始写回，end = 结果完整落地）
- **挂起审批 = 开放区间**：搜索按 `toolCallId` 配对、第一个有 start 无 end 的 `tool_call` 区间即当前待审批调用；审批决定、恢复都不再写专门事件。
- **移除**：`title/set`、`pin/set`、`notify/set` → 迁入旁挂 `<session_id>.meta.json`（UI 元数据，last-wins 语义不变）；`tool/approval-pending` → 删除（语义由开放区间替代）。按事件名读取的原语（`lastEvent`）退役。
- **replay 不变**：LLM 上下文仍只由 message lines 构建，事件行不注入。

## User Stories

1. 作为调试者，我想在 jsonl 里看到每一轮 LLM 生成的开始与结束（含结束原因），以便审计暂停、中断与重放整个推理过程。
2. 作为调试者，我想看到每个工具调用自生成到决策（approve/deny）的完整区间，以便区分「审批挂起中」与「已完成」。
3. 作为恢复方（审批 API），我希望能从存储里直接推导当前挂起的审批（第一个未闭合的 tool_call 区间），而不依赖专门事件。
4. 作为前端，审批卡片所需的 `expectsAnswer` 在事件载荷里可恢复，所以页面刷新后仍能渲染正确的输入形态（文本输入 or 仅按钮）。
5. 作为审计者，`tool_call/start` 载荷自足（toolCallId/toolName/args/expectsAnswer），可独立重建工具调用现场，无需回溯消息行。
6. 作为维护者，UI 状态（标题/置顶/通知）不再出现在 jsonl 里，所以审计流只含 LM 过程类事件。
7. 作为会话列表方，title/pin/notify 的读取语义（last-wins、缺省）与现有行为完全一致，只是换了存储位置。
8. 作为开发者，`tool_call/deny` 也闭合区间（end 带 decision），所以「无 end = 挂起」的推导不会被已拒绝的调用污染。
9. 作为开发者，同一轮多个工具调用各自拥有独立区间，逐个审批时剩余待审批项天然可见。
10. 作为消费者，结果异步返回有明确的区间边界（start = 开始返回，end = 完整返回），为将来流式结果传输预留语义。
11. 作为集成方，`turn/end` 的 `finishReason` 与现有循环结束语义一一对应（stop/tool-calls/max-turns/error），无需新枚举。
12. 作为集成方，系统提示词组装记录为单事件（无 start/end），因为该动作不允许暂停、必然一次完成。
13. 作为回放方，消息行（message lines）的 schema 与语义不变，旧会话文件无需迁移即可继续 /resume。
14. 作为测试作者，事件序列（顺序与载荷）成为可断言的存储外部行为，与 loop 的行为测试天然配套。
15. 作为未来的流式结果消费者，tool_result 开放区间即「返回未完成」，可据此感知断流/中断而不需要额外事件。

## Implementation Decisions

- **事件载荷**：
  - `turn/start` → `{}`；`turn/end` → `{ finishReason }`
  - `tool_call/start` → `{ toolCallId, toolName, args, expectsAnswer }`；`tool_call/end` → `{ toolCallId, decision: 'approve' | 'deny' }`
  - `tool_result/start` / `tool_result/end` → `{ toolCallId }`
  - `system_prompt/set` → `{ sections: string[] }`（沿用既有载荷）
- **turn 的边界**：一次 LLM 生成迭代（loop 的一次 while 迭代）即一个 turn；遇 ask 工具暂停时写 `turn/end { finishReason: 'tool-calls' }`，暂停本身由 tool_call 开放区间表达；审批恢复后的后续生成为新 turn。`turn/end` 不悬跨 HTTP 段。
- **tool_call 生命周期**：生成 pass 为**每条** tool-call part 写 `tool_call/start`（auto 工具紧随写 end）；ask 工具保持开放直到审批决定——approve 后执行完成写 `tool_call/end { decision: 'approve' }`，deny 直接写 `{ decision: 'deny' }`（不执行工具，但区间照常闭合）。
- **tool_result 边界**：工具执行完成、结果开始写回（写 result part + 消息行）前写 `tool_result/start`，结果完整写入后写 `tool_result/end`。本次实现结果仍为一次性写出（非流式），start/end 界定「写回过程」两端，为将来流式化保留区间语义。
- **审批推导原语**：会话存储层新增「第一个未闭合 tool_call」推导原语（按 toolCallId 配对 start/end，从头部顺序扫描）；`lastEvent` 及其调用方退役。执行中崩溃导致的开放区间会被误读为待审批——可接受（与现状等价），不在载荷中加 phase 区分字段。
- **UI 元数据迁移**：`<session_id>.meta.json` 以 last-wins 语义存 `{ title?, pinned?, notify? }`；会话展示元数据原语（标题/置顶/通知/列表）输出语义不变，读取源切换；meta 文件缺失视为无覆盖。写路径：rename/置顶/通知等会话动作改为写 meta 文件。
- **兼容性**：message lines 不变 → 旧会话照常 /resume；事件行无读取兼容（新模型不再读取旧事件名），干净切换，无需迁移脚本。`kind/ts/event/payload` 行 schema（ADR-0006）保持不变。
- **replay transform 不变**：仅 message lines 进 LLM 上下文；事件行只参与审计与状态推导。

## Testing Decisions

- **测试缝**：core 级测试继续用「假 `streamTextCall` 驱动 loop」的既有模式（prior art：`packages/core/test/stream-loop.mjs` 的 fake streamText），在临时目录注入 `SessionStore` 断言写出的 jsonl 事件序列；server 级测试用 `fetch(app.request)` 走真实 HTTP（prior art：`packages/server/test/chat-api.mjs`）。
- **测什么**（外部行为，不测实现）：
  - 单段 loop：auto 工具 → `tool_call/start`+`end`、`tool_result/start`+`end` 按序出现；ask 工具 → `tool_call/start` 开放、`turn/end { tool-calls }`；回复完成 → `turn/end { stop }`。
  - 审批恢复：approve 后 `tool_call/end { approve }` + tool_result 区间；deny 后 `tool_call/end { deny }` 且不执行工具；multi-ask 轮次逐个闭合、下一个未闭合区间成为当前待审批。
  - 恢复推导：会话存储原语从 jsonl 推导出的待审批与消息日志推导的 `pendingToolCalls` 一致。
  - 元数据：rename/pin/notify 写 meta 文件且 jsonl 不再出现对应事件；列表/标题/置顶/通知端点行为与现状一致。
  - replay：`load()` 的 message lines 输出与改造前一致（回归）。
  - 旧会话：改造前生成的 jsonl 仍可 resume（message lines 兼容）。
- **不需要测**：事件内部格式之外的实现细节；meta 文件的具体内部结构（通过公开原语间接覆盖）。

## Out of Scope

- 工具结果的流式传输实现（本次只为区间建模，结果仍单次写出）。
- 取消/放弃挂起审批的 UI 机制（开放区间如何收尾由未来特性决定）。
- Web / TUI 前端改动（前端已从 data-stream parts 推导 pending 状态，事件变化对其透明）。
- 旧事件行的向后兼容读取与迁移脚本。
- 事件模型之外的系统提示词 / 循环语义改动。

## Further Notes

- ADR-0006（行 schema：`kind/event/ts/payload`）继续有效；本 spec 是事件**语义**的演进，将记录为 ADR-0018（lifecycle events），并在 ADR-0006 追加修订注记。
- `tool_result` 区间在本次为「近瞬时」两端（写回动作本身），其价值在于：中断语义统一、为流式结果预留位置；不要因为两事件间距近而合并成单事件。
- 架构文档（architecture）会话持久化一节将同步本事件模型图解。