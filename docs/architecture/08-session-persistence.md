# 8. 会话持久化

> [07 安全模型 ←](07-security.md) · [索引](../architecture.md) · [09 界面与服务端 →](09-server-web-tui.md)

见 ADR-0002 + ADR-0006 完整决策。要点：

- **存储**：每个会话一个 append-only jsonl：
  `~/.applepi/sessions/<workspace>/<session_id>.jsonl`。
  每行是 `kind:"event"`（生命周期事件）或 `kind:"message"`（LLM 消息）。
- **行结构（ADR-0006 精简后 + ADR-0018 事件族）**：
  - 事件行：`{"kind":"event","event":"turn/start","payload":{...},"ts":<ISO>}`
    —— `event` 字段合并了类型与阶段。jsonl 只剩 LM 过程四族：可暂停过程成对
    `X/start|end`（`turn` / `tool_call` / `tool_result`），原子操作单点
    （`system_prompt/set`）。配置类状态不在 jsonl，在旁挂 `<id>.config.json>`
    （ADR-0016）；UI 展示元数据在旁挂 `<id>.meta.json`（ADR-0018）。
  - 消息行：`{"kind":"message","role":"system|user|assistant|tool","content":...,"ts":<ISO>}`。
  - 行内**不含** `session_id` / `workspace`：会话与工作区身份由文件路径承载，
    行不再自包含（旧 ADR-0002 的"每行可独立审计"语义已放弃）。
- **SessionStore 归核心**：`create` / `appendEvent` / `appendMessage` /
  `load`（replay 变换） / `list`；状态推导原语 `pendingToolCall()`（最早未闭合
  `tool_call` 区间 = 当前待审批，ADR-0018，替代已退役的 `lastEvent`）；展示元数据
  原语 `title()` / `pinned()` / `notify()` / `listSessions()`（`SessionSummary` 数组，
  含 title/pinned/notify + mtime 降序，读旁挂 meta 文件）及写原语
  `loadMeta` / `saveMeta` / `updateMeta`。web UI 驱动同一套核心方法，不再手撕 jsonl。
- **共享消息契约（deepen #03）**：`packages/core/message.ts` 定义跨 core→web 的消息形状
  （`ThreadMessage` / `MessagePart`，纯 leaf 模块，无 node/ai/react 运行时依赖）。
  `stream-loop` 产出契约消息并持久化；web `hydrate` 通过 `mergeToolResults`（把 `tool`
  消息折叠进持有它的 assistant tool-call part）与 `toText`（唯一文本提取器）纯消费；
  `pendingApproval` 在刷新后重浮未决批准。流式路径的 isError 判定与核心同一来源
  （`isErrorResult` 导出）。
  事件（`turn/*`、`tool_call/*`、`tool_result/*`、`system_prompt/set` 四族，
  ADR-0018；`reload/start|end` 原语保留）由 app / 工具直接
  `store.appendEvent` 写入 jsonl——`appendEvent` 就是存储原语，无 core 内置事件处理器。

## 事件模型（lifecycle events）

### 分类原则

- **可暂停/可中断的过程 → `X/start` + `X/end` 成对**。中断无需专门事件：`start` 无配对 `end` 即开放区间（挂起/中断），恢复逻辑据此推导状态。
- **不允许暂停的原子操作 → 单事件点**（无 start/end）。

### 事件族一览

| 事件 | 载荷 | 语义 |
|---|---|---|
| `system_prompt/set` | `{ sections: string[] }` | 原子：系统提示词一次性组装，不允许暂停 → 无 start/end |
| `turn/start` / `turn/end` | `end: { finishReason: 'stop' \| 'tool-calls' \| 'max-turns' \| 'error' }` | 一个 turn = 一次流式段（一次 HTTP 请求内的 loop 执行，可含多轮自动工具迭代）；`end` 不悬跨 HTTP 段；`tool-calls` = 暂停在待审批工具调用上（暂停本身由 tool_call 开放区间表达） |
| `tool_call/start` / `tool_call/end` | `start: { toolCallId, toolName, args, expectsAnswer }`；`end: { toolCallId, decision: 'approve' \| 'deny' }` | 一个工具调用全生命周期：生成 → 审批（可能挂起）→ 执行/拒绝。生成 pass 为每条 tool-call part 写 start（auto 工具紧随 end）；ask 工具保持开放直到决策——approve 执行完成后写 end，deny 直接写 end（区间照常闭合） |
| `tool_result/start` / `tool_result/end` | `{ toolCallId }` | 结果**异步返回**区间：start = 结果开始写回（调用后异步等待结束），end = 结果完整落地。本次实现结果仍一次性写出，start/end 界定写回过程的两端，为将来流式结果传输预留区间语义 |

### 时序示意

```
会话级（原子，不允许暂停 → 无 start/end）：
  system_prompt/set

每轮 turn（可中断 → start/end 对）：
  turn/start ──────────────── turn/end { finishReason }

每个工具调用（可中断 → start/end 对）：
  tool_call/start ─[审批挂起：开放、无 end]─ tool_call/end { decision }
     └─ 执行期：异步 execute，await 等待结果
每份工具结果（异步返回 → start/end 对）：
  tool_result/start ──[结果写回/传输]── tool_result/end { toolCallId }
```

### 状态推导（替代事件查找）

- **挂起审批 = 未闭合区间**：按 `toolCallId` 配对 start/end，最早「有 start 无 end」的 `tool_call` 区间即当前待审批调用（存储原语 `pendingToolCall()`）；`tool/approval-pending` 事件已删除（含决策追写、同轮下一待审批追写两处调用点），同轮所有 ask 工具的开放区间天然构成「待审批集合」。已知歧义（接受）：执行中崩溃也表现为开放区间，会被误读为待审批。
- **UI 元数据旁挂**：title/pin/notify 存 `<session_id>.meta.json`（last-wins：`{ title?, pinned?, notify? }`，缺失视为无覆盖；旧会话 jsonl 中的 `title/set` 等 UI 事件不再读取，meta 缺失即走缺省回退）；与 `<id>.config.json>`（ADR-0016 override-diff 语义）分文件。会话展示元数据原语输出语义不变，读取源已切换。
- **replay 不变**：仅 message lines 进 LLM 上下文；事件行只参与审计与状态推导。行 schema（`kind/ts/event/payload`，ADR-0006）不变；message lines 不变 → 旧会话照常 /resume，无迁移脚本。
- **Replay（只读）**：读取时过滤 message 行；若存在 `reload` 事件，最新重建的
  system 消息替换 `message[0]`；原 jsonl 永不被改写。
- **Resume**：web 的 `openSession` → `GET /api/session` 水合 + `Harness.resume`
  切换活动会话并继续追加；
  `reload/start|end` 事件与 `SessionStore` 的 replay 规则作为存储/读取原语保留。
- **系统提示词（ADR-0015 扁平模型，supersedes ADR-0008/0010）**：单一扁平缓冲区 =
  `bundle 片段 → app 接口片段 → plugin 尾部片段` 顺序拼接；无块栈、无 PromptBag、
  无提示词中间件。重建 = 每轮用当前 env（级别/工作区）重读同一份 spec
  （`assembleFlatPrompt`）。系统消息行只在会话启动时由 app `appendMessage('system', ...)`
  持久化（在 pre-chosen 级别/推理等级写入之后，见 [§1.6](01-overview.md#16-adr-0015-最终形态扁平-system_prompt--bundlemodeapp)）。
- **Slash 命令（核心能力）**：core 自注册 `/level`（`registerSlashCommand` 扩展点）；
  其余由 web 界面直接驱动同一套 core 方法（`SessionStore` / `applyPermissionLevel` /
  `resolveLlmConfig`）。