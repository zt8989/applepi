# 4. 扁平系统提示词（Flat system prompt）

> [03 能力装配 ←](03-capability-assembly.md) · [索引](../architecture.md) · [05 内置 Agent Loop →](05-agent-loop.md)

系统提示词是**单一扁平缓冲区**，无块栈、无 prompt 中间件、无 `PromptBag`
（ADR-0015，supersedes ADR-0008/0010）。三层硬编码顺序拼接：

```
bundle 片段 → app 接口片段 → plugin 尾部片段
```

- 下层不可改写上层；顺序是声明的，不是协商的。
- 权限声明段是 **共享 `permissionFragment`**（deepen #01：base/standard 共用同一渲染器，
  由 `resolvedTools` 实时生成「Tools available」清单），按当前级别
  （readonly/workspace/fullaccess）分档渲染；core 的 `security` 只强制、不写提示词文案。
- 重建 = 每轮用当前 env（级别、工作区）重读同一份 spec 重新拼接
  （`assembleFlatPrompt`），因此级别、工作区等状态变化**不是**提示词重建触发器
  （级别存 `session.config.permissionLevel`，ADR-0016；无 `level/set`/`reasoning/set` 事件）。
- 系统消息持久化：新会话时 app 写一条 `system` 消息行到 jsonl（在 pre-chosen
  级别/推理等级写入之后）；会话内每轮直接用新拼的提示词（replay 时若存在 `reload`
  事件，最新 system 替换 message[0]，`reload/start|end` 作为存储原语保留，见 [§8](08-session-persistence.md)）。