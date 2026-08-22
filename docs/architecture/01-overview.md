# 1. 概览

> [索引](../architecture.md) · [02 核心运行时 →](02-core-runtime.md)

一个**单机（本地）运行的 agent**：核心运行时按 ADR-0015 拆分为一组单职责深模块
（`llm` / `loop` / `session` / `config` / `security` / `trace`），由薄 **Harness
壳** 组装；所有增量能力（工具、skills、memory）作为能力/扩展在运行时注入。
全景架构图与依赖方向见[总页](../architecture.md)。

> **ADR-0015 重塑（2026-08-21，已实现）**：本文档描述**当前实现**——扁平
> system_prompt + bundle/mode/app + core 深模块；洋葱/扩展注入、按块提示词等历史机制
> 见 ADR-0008/0010/0015。

## 1.5 模块划分（ADR-0015）

core 按单职责拆成深模块，由薄 **Harness 壳** 组装：

| 模块 | 职责 | 说明 |
|---|---|---|
| `llm` | LLM 交互面：工具目录 + 单段**流式**响应 | `llm.ts`：`buildToolDefs` / `reasoningProviderOptions` / `Llm.stream`，隐藏 AI SDK（`streamText`），消耗 app 已组装的 `{ prompt, tools }` + history 流式一段响应（ADR-0015）。 |
| `loop` | 多回合编排 + 暂停/批准/恢复 | `stream-loop.ts`（`runLoopStreamSegment`，流式，唯一 agent loop），经 `harness.llm` 取模型调用、`harness.executeTool` 执行工具。 |
| `session` | jsonl 持久化 + resume + 追加生命周期事件原语 + 会话展示元数据 | `session.ts`（`create`/`appendEvent`/`appendMessage`/`load`/`list` + ADR-0018 的 `pendingToolCall()` 未闭合区间推导原语与 `loadMeta`/`saveMeta`/`updateMeta`，及 `title`/`pinned`/`notify`/`listSessions` 展示元数据原语）。 |
| `config` | settings.json / provider / reasoning | `config.ts`。 |
| `security` | 权限级别强制（工具执行缝） | `security.ts`：只保留强制机制（三值级别模型，级别存 `session.config.permissionLevel`（ADR-0016，非 `level/set` 事件）/ctx 注入/工具自决 + core 自注册 `/level`）；权限**声明段**按 ADR-0015 移入 bundle（[§7](07-security.md)）。 |
| `trace` | 可观测埋点 | `trace.ts`。 |
| `Harness`（壳） | 组装以上模块 + 生命周期 | `harness.ts`：owns `llm`，`registerTool`/`unregisterTool`/`getTools`/`buildToolDefs`、`registerSlashCommand`/`getSlashCommand`、`attachSession`/`restoreSecurity`/`resume`、`executeTool`（工具执行缝）。无洋葱、无 `emit`、无扩展加载器。 |

## 1.6 ADR-0015 最终形态（扁平 system_prompt + bundle/mode/app）

ADR-0015 定义本系统的**最终形态（已实现）**。四个核心概念：

- **Bundle（能力包）** — 自包含能力单元。`base` = 恰好 bash + str_replace_editor
  两个工具 + 极简提示词（无 memory/skills/plan/goal/subagent）；`standard` =
  自包含全集（复用共享工具实现 + memory/skills/web/plan/goal/subagent/workflow/
  todo/ask_user 能力声明；人格收敛为与 base 同串的 minimal 文本，权限/能力声明段
  由共享 `permissionFragment` 按实际注册工具生成，deepen #01）。**兄弟并列：
  standard 不继承 base，无 `extends`。**
- **Mode（模式）** — 被 app 托管的 bundle（base/standard 既是 bundle 也是 mode）；
  mode 不是独立概念。
- **App（应用）** — `web` / `tui`，是**接口**不是 bundle/mode；app 托管 mode 选择
  并在所选 bundle 之上叠加自带接口片段（如 web 的「Workspace」环境片段）。接口轴
  （web/tui）× 能力轴（base/standard）正交。**ADR-0017：tui 已实现**（Ink 7，
  Claude Code 风格），web/tui 都是**接入端**——先启动者拉起共享**服务端**，后启动者
  attach，不重复启动运行时（[§9](09-server-web-tui.md)）。
- **Plugin（插件）** — 外部追加型能力：尾部追加 prompt 片段 + 注册新工具/技能，
  不可重排/删除 base/standard 内部（ADR-0015 概念）。web 当前未挂插件目录。

**扁平 system_prompt**：单一扁平缓冲区，`bundle 片段 → app 接口片段 → plugin 尾部
片段` 三层顺序拼接（下层不可改写上层）；无块栈、无 prompt 中间件/洋葱。由会话
spec（`{ prompt片段, tools }`）一次性拼装（`@applepi/bundle` 的
`assembleFlatPrompt`），每轮重建 = 重读同一份 spec + 当前级别（bundle 权限声明段按
级别分档）。

**模式选择**：仅新建会话时选（web 新对话下拉），非热切换、非事件；
作为构建期身份记入 `<id>.config.json>` 的 `session.config.mode`（ADR-0016），
会话内不可变。恢复时 `Harness.resume`
（读 config 文件）与 web 的 `sessionMode` 从该文件重建匹配的 spec。
**权限/能力声明段**：base/standard 共用同一装配期 `permissionFragment`
（deepen #01）—— 由 `resolvedTools`（`spec.tools` ∪ 已落地 capability 工具）
实时生成，提示词与实际注册面永不漂移；声明但无工厂的 capability id 在
`enableBundleSpec` 打 `console.warn`。

**core 收敛**：core 只含深模块 + 薄壳，能力装配完全落在 `@applepi/bundle` + 服务端
装配（历史机制 `OnionBus` / `PromptBag` / `emit` 等已移除，见 ADR-0015）。