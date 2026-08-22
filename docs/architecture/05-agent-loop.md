# 5. 内置 Agent Loop（流式，唯一）

> [04 扁平系统提示词 ←](04-flat-system-prompt.md) · [索引](../architecture.md) · [06 工具映射 →](06-tools-ai-sdk.md)

core 只提供一个 agent loop：`runLoopStreamSegment`（`streamText`，token 级分段流 +
暂停/恢复状态机，[§9.1](09-server-web-tui.md#91-流式-loopstreaming-loopadr-0011) / ADR-0011）。

```
loop（分段流）:
  messages = [ system(扁平提示词), ...history ]
  for each turn:
    resp = harness.llm.stream({ model, messages, tools })   # llm 深模块（ADR-0015）
    merge parts into the data stream（text / reasoning / tool-call）
    for each toolCall:
      if classifyApproval(...) === 'ask': pause + persist approval; end segment
      else: harness.executeTool(toolCall)     # 工具执行缝（安全缝：ctx 带级别）
      stream the tool-result back
    continue until the model stops calling tools or maxTurns
```

- **Provider 抽象**：经 **Vercel AI SDK**（`streamText` + provider 适配器），由 `llm`
  模块封装（`Llm.stream`），不自己写多模型适配，`stream-loop` 也不直接接触 SDK。
- **工具暴露给模型**：经 `llm.buildToolDefs()` 生成 `{ description, parameters }` 目录，
  并入 `streamText({ tools })`（无 execute——执行由 loop 自行驱动，工具经执行缝包裹）。
- **暂停 / 批准 / 恢复（ADR-0011 + ADR-0018）**：`ask` 工具暂停——其 `tool_call`
  开放区间即待审批状态（无专门事件）；`executeApprovedTool` 续跑（approve 执行 /
  deny 回填拒绝），决策写 `tool_call/end { decision }` 关闭区间，**不重跑 LLM**——jsonl 即
  loop 状态（见 [§9.1](09-server-web-tui.md#91-流式-loopstreaming-loopadr-0011) / P13）。
- **生命周期区间（ADR-0018）**：每段开头写 `turn/start`，段尾按终因写
  `turn/end { finishReason: stop \| tool-calls \| max-turns \| error }`（一个 turn =
  一次流式段）；每个工具调用生成即写 `tool_call/start`（auto 紧随 end），结果写回前后写
  `tool_result/start|end`。
- **系统提示词注入**：每轮 `messages[0]` 由 app 用 `assembleFlatPrompt` 组装的扁平
  提示词（bundle 片段 + 能力片段 + app 接口片段）提供——
  重建 = 重读同一份 spec，无动态中间件。系统消息行只在会话启动时持久化一次
  （app 层 `appendMessage('system', ...)`）；会话内每轮直接用新拼的提示词
  （ADR-0002 replay 语义：最新 system 替换 message[0]）。