# 2. 核心运行时（`@applepi/core`）

> [01 概览 ←](01-overview.md) · [索引](../architecture.md) · [03 能力装配 →](03-capability-assembly.md)

核心是一组**单职责深模块**（ADR-0015 [§1.5](01-overview.md#15-模块划分adr-0015)），由薄 Harness 壳组装；按 ADR-0005
不含工具，ADR-0009 把安全强制机制收归内置。core 的模块组成：

1. **`llm`**（ADR-0015 新增）— **LLM 交互面**：工具目录 + 单段**流式**响应。封装
   `streamText`、`reasoningProviderOptions`（推理等级映射）、`buildToolDefs`；
   `stream-loop` 经 `harness.llm.stream` 取模型调用，不再直接依赖 AI SDK。消耗 app
   已组装的 `{ prompt, tools }` 与 history 产出一段流式响应（ADR-0015）。
2. **`loop`** — 内置 agent loop（唯一，流式）：`runLoopStreamSegment`（`streamText`，
   token 级分段流 + 暂停/恢复状态机，[§9.1](09-server-web-tui.md#91-流式-loopstreaming-loopadr-0011)）。经 `llm` 模块发起模型调用，工具经
   `harness.executeTool`（工具执行缝）执行。
3. **`session`** — 会话持久化（jsonl，同时充当流式 loop 的暂停点状态，[§8](08-session-persistence.md)）。
4. **`config`** — LLM 配置解析：settings.json + .env，见 [§10](10-llm-config.md)。
5. **`security`** — 权限级别强制机制（三值级别模型 + 上下文注入，工具 execute 读
   level 自决，[§7](07-security.md)）。级别存 `session.config.permissionLevel`（ADR-0016）。
   声明段在 bundle（base/standard
   共用装配期 `permissionFragment`，由实际注册工具生成），core 只保留强制机制 + `/level` 命令。
6. **`trace`** — 可观测性埋点（Langfuse Cloud，[§9.4](09-server-web-tui.md#94-可观测性langfuse-traceadr-0012)）。
7. **`Harness`（壳）** — 组装以上模块 + 生命周期；owns `llm`，提供
   `registerTool`/`unregisterTool`/`getTools`/`buildToolDefs`、
   `registerSlashCommand`/`getSlashCommand`、`attachSession`/`restoreSecurity`/
   `resume`、`executeTool`（工具执行缝）。无洋葱、无 `emit` 事件总线、无扩展加载器。

> 为什么核心无工具：核心的消费方（未来的 web UI 等）不应被迫继承 shell 访问、
> 文件编辑和安全策略（ADR-0005 的问题陈述）；ADR-0015 强化为「core 只关心 LLM
> 交互」——system_prompt + tools。