# ADR-0018: Lifecycle Events — jsonl 事件按「可暂停过程 → start/end 对」重组

## Status

Accepted — 2026-08-22, decided via design conversation（事件分类原则：可暂停/可中断的过程必须有 start/end 区间；不允许暂停的原子操作只留单事件点）。**实现待办**：spec `.scratch/lifecycle-events/spec.md`（ready-for-agent）。

## Context

jsonl 事件行目前混入两类不相干的事件：

- **UI 状态类**（`title/set`、`pin/set`、`notify/set`）——支撑会话列表展示元数据（`SessionSummary`），但语义是 UI 状态（last-wins），不是 LM 过程记录；
- **一次性审计类**（`tool/approval-pending`，含决策追写两处调用点）——承载挂起审批状态，恢复逻辑按事件名读「最后一个」。

而真正有过程语义的阶段全是单点或无记录：每轮 LLM 生成（turn）、工具调用（生成 → 审批挂起 → 执行/拒绝）、工具结果异步返回（调用后可能长时间等待、结果分次到达）——这些阶段**可能暂停或中断**，单点事件表达不了「开始 / 未完成 / 结束」，审计与恢复都别扭：恢复依赖专门事件（`lastEvent('tool/approval-pending')`）、中断无从辨认。

需要一个按「过程 vs 原子」重分的统一事件模型：可暂停的过程成对 start/end（中断 = 有 start 无配对 end 的开放区间），不可暂停的原子动作单点事件。

## Decisions

### 分类原则

- **可暂停/可中断的过程 → `X/start` + `X/end` 成对**。中断不需要专门事件：`start` 无配对 `end` 即开放区间（挂起/中断）。
- **不允许暂停的原子操作 → 单事件点**。无 start/end。

### 事件族（新模型）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `system_prompt/set` | `{ sections: string[] }` | 原子：一次性组装，写即完成，不允许暂停 → 无 start/end |
| `turn/start` / `turn/end` | `end: { finishReason: 'stop' \| 'tool-calls' \| 'max-turns' \| 'error' }` | 一次 LLM 生成迭代（loop 的一次 while 迭代）即一个 turn。遇 ask 工具暂停写 `end { tool-calls }`，暂停本身由 tool_call 开放区间表达；`turn/end` 不悬跨 HTTP 段 |
| `tool_call/start` / `tool_call/end` | `start: { toolCallId, toolName, args, expectsAnswer }`；`end: { toolCallId, decision: 'approve' \| 'deny' }` | 一个工具调用全生命周期：LLM 生成 → 审批（可能挂起）→ 执行/拒绝。生成 pass 为**每条** tool-call part 写 start（auto 工具紧随 end）；ask 工具保持开放直到决策——approve 执行完成后写 end，deny 直接写 end（不执行但区间闭合） |
| `tool_result/start` / `tool_result/end` | `{ toolCallId }` | 结果**异步返回**区间：start = 结果开始写回（异步等待结束），end = 结果完整落地。本次实现结果仍一次性写出，start/end 界定写回过程两端，为将来流式结果传输预留区间语义 |

### 挂起审批 = 未闭合区间（替代 `tool/approval-pending`）

- 搜索**按 `toolCallId` 配对**的最早「有 start 无 end」的 `tool_call` 区间即当前待审批调用；
- `tool/approval-pending` 事件（含决策追写、同轮下一待审批追写）**整体删除**：同轮所有 ask 工具的 start 从一开始就是开放区间，「待审批集合」天然可见，恢复无需再写专门事件；
- 「第一个未闭合区间」推导作为会话存储层新原语；`lastEvent` 及其调用方退役；
- **已知歧义（接受）**：执行中崩溃也表现为开放区间，会被误读为待审批——与现状（决策事件先于执行写入）等价脆弱，不在载荷中加 phase 区分字段。

### UI 元数据迁出 jsonl（`title/set` / `pin/set` / `notify/set` 删除）

- 新旁挂文件 `<session_id>.meta.json`，last-wins 语义存 `{ title?, pinned?, notify? }`，缺失视为无覆盖；
- 会话展示元数据原语（标题/置顶/通知/会话列表 `SessionSummary`）输出语义不变，读取源切换；
- 与 `<session_id>.config.json>`（ADR-0016, override diff 语义）**分文件**——meta 是 last-wins UI 状态，config 是级联覆盖，语义不同不混装。

### 兼容性

- message lines 不变 → 旧会话照常 /resume；`kind/ts/event/payload` 行 schema（ADR-0006）不变；
- 事件行无向后兼容读取（新模型不再读旧事件名），干净切换，无迁移脚本；
- replay 变换不变：仅 message lines 进 LLM 上下文，事件行只参与审计与状态推导。

## Consequences

- **审计即过程**：turn / tool_call / tool_result 的起止与中断（开放区间）可完整重放；`finishReason`、`decision` 直接落在端事件载荷上。
- **恢复自简化**：审批恢复从「按名读最后事件」变为「扫描未闭合区间」，与消息日志推导的 `pendingToolCalls` 双源一致。
- **jsonl 纯化**：事件行只剩 LM 过程四族；UI 元数据与配置状态全部旁挂（meta.json / config.json）。
- **实现改动面**：loop 生成 pass（为全部 tool-call 写 start / auto 即时闭合）、决策路径（end 带 decision）、审批恢复（未闭合推导原语）、会话动作路由（写 meta 文件）、`session` 模块（新原语 + 读源切换）；测试缝沿用 core 级（fake streamText）与 server 请求级（`fetch(app.request)`）。
- **ADR-0006 局部被取代**：行 schema 保留；其事件载荷与「事件即审计」语义由本文档演进。

## 相关

- 架构文档 [§8 会话持久化](../architecture/08-session-persistence.md)（含演进注记）
- spec：`.scratch/lifecycle-events/spec.md`
- ADR-0006（event schema slimming）、ADR-0016（session config 双层，`level/set` 等迁 config 的先例）