# 架构（Architecture）

> 状态：持续更新（初版 2026-08-18/19 经 `/grill-me` / `/grill-with-docs` 多轮访谈锁定；2026-08-20 纳入 web 双接口、流式 loop、工具批准、Langfuse 埋点，对应 ADR-0011 / ADR-0012；2026-08-21 纳入并实现 ADR-0015——core 深模块拆分 + 扁平 system_prompt + bundle/mode/app 重塑，见 §1.6）。
> 本页是系统设计的权威入口，细节与决策依据见各 ADR（ADR-0001 ~ ADR-0015）。

## 1. 概览

一个**单机（本地）运行的 agent**：核心运行时按 ADR-0015 拆分为一组单职责深模块
（`llm` / `loop` / `session` / `config` / `security` / `trace`），由薄 **Harness
壳** 组装；所有增量能力（工具、skills、memory）作为能力/扩展在运行时注入。

> **ADR-0015 重塑（2026-08-21，已实现）**：本页已从「洋葱/扩展注入 + 按块提示词」
> 迁移到「扁平 system_prompt + bundle/mode/app + core 深模块」。**已完成**：core
> 拆分为深模块（`llm` 模块，`loop`/`stream-loop` 走 `llm` 接口），洋葱机制从 core
> 移除（`OnionBus` / `registerExtension` / `HarnessApi` / `emit` 事件族 / `system_prompt`
> 事件族 / `PromptBag` / `buildSystemPrompt`），`packages/bundle` 承载 `base`/`standard`
> 纯声明能力包，app（agent + web）按「bundle 片段 → app 接口片段 → plugin 尾部片段」
> 组装扁平提示词，mode 在建会话时选定并记入 `session.config.mode`。本文档描述
> **当前实现**（即 ADR-0015 最终形态）；历史机制见各 ADR。

```
┌─────────────────────────────────────────────────────────────┐
│  apps/agent  (@applepi/agent)                               │
│  REPL 主入口 · main.ts 选 bundle + 扁平提示词 + 插件加载器    │
│  extensions/ 本地 *.ext.ts（插件）· scripts/ 六个检查        │
└───────────────▲─────────────────────────────────────────────┘
                │ 依赖：agent → bundle（→extensions/core）
┌───────────────┴─────────────────────────────────────────────┐
│  packages/bundle  (@applepi/bundle)                         │
│  base / standard 能力包：纯声明 (env) => ({ prompt, tools }) │
│  + enableBundleSpec / assembleFlatPrompt（app 侧装配助手）    │
└───────────────▲─────────────────────────────────────────────┘
┌───────────────┴─────────────────────────────────────────────┐
│  packages/extensions  (@applepi/extensions)                 │
│  参考工具 bash / str_replace_editor + 能力工厂 memory/skills │
└───────────────▲─────────────────────────────────────────────┘
                │ 依赖：extensions → core（单向）
┌───────────────┴─────────────────────────────────────────────┐
│  packages/core  (@applepi/core)  —— 深模块 + 薄 Harness 壳   │
│  llm · loop · session · config · security · trace           │
└─────────────────────────────────────────────────────────────┘
```

依赖方向（ADR-0003，ADR-0015）：`@applepi/agent → @applepi/bundle → @applepi/core` 与
`@applepi/bundle → @applepi/extensions → @applepi/core`。Web 界面 `@applepi/web` 也只依赖
core + bundle（驱动 Harness + SessionStore + `runLoopStreamSegment` + bundle 装配），
能力集由 bundle/能力工厂在运行时装配（详见 §3、§9）。
跨包引用一律用包名（`@applepi/core` 等），解析到各包 `dist/`。

### 1.5 模块划分（ADR-0015）

core 按单职责拆成深模块，由薄 **Harness 壳** 组装：

| 模块 | 职责 | 说明 |
|---|---|---|
| `llm` | LLM 交互面：工具目录 + 单段模型响应 | `llm.ts`：`buildToolDefs` / `reasoningProviderOptions` / `Llm.generate` / `Llm.stream`，隐藏 AI SDK（`generateText`/`streamText`），消耗 app 已组装的 `{ prompt, tools }` + history 产出/流式一段响应（ADR-0015）。 |
| `loop` | 多回合编排 + 暂停/批准/恢复 | `loop.ts`（非流式）+ `stream-loop.ts`（流式），经 `harness.llm` 取模型调用，不再直接碰 SDK。 |
| `session` | jsonl 持久化 + resume + 追加生命周期事件原语 | `session.ts`（`create`/`appendEvent`/`appendMessage`/`load`/`lastEvent`/`list`）。 |
| `config` | settings.json / provider / reasoning | `config.ts`。 |
| `security` | 权限级别强制（工具执行缝） | `security.ts`：只保留强制机制（三值级别模型/`level/set` 事件 + lastEvent 恢复/ctx 注入/工具自决 + core 自注册 `/level`）；权限**声明段**按 ADR-0015 移入 bundle（§7）。 |
| `trace` | 可观测埋点 | `trace.ts`。 |
| `Harness`（壳） | 组装以上模块 + 生命周期 | `harness.ts`：owns `llm`，`registerTool`/`unregisterTool`/`getTools`/`buildToolDefs`、`registerSlashCommand`/`getSlashCommand`、`attachSession`/`restoreSecurity`/`resume`、`executeTool`（工具执行缝）、`run`（CLI 单回合，接收 app 组装的扁平提示词）。无洋葱、无 `emit`、无扩展加载器。 |

### 1.6 ADR-0015 最终形态（扁平 system_prompt + bundle/mode/app）

ADR-0015 定义本系统的**最终形态（已实现）**。四个核心概念：

- **Bundle（能力包）** — 自包含能力单元。`base` = 恰好 bash + str_replace_editor
  两个工具 + 极简提示词（无 memory/skills/plan/goal/subagent）；`standard` =
  自包含全集（复用共享工具实现 + memory/skills/web/plan/goal/subagent/workflow/
  todo/ask_user 能力声明 + 自己的提示词）。**兄弟并列：standard 不继承 base，无 `extends`。**
- **Mode（模式）** — 被 app 托管的 bundle（base/standard 既是 bundle 也是 mode）；
  mode 不是独立概念。
- **App（应用）** — `web` / `tui`，是**接口**不是 bundle/mode；app 托管 mode 选择
  并在所选 bundle 之上叠加自带接口片段（如 web 的「Workspace」环境片段）。接口轴
  （web/tui）× 能力轴（base/standard）正交。
- **Plugin（插件）** — 外部追加型能力：尾部追加 prompt 片段 + 注册新工具/技能，
  不可重排/删除 base/standard 内部。app 层加载器（`apps/agent/plugins.ts`）扫描
  `extensions/` 下的 `*.ext.ts`。

**扁平 system_prompt**：单一扁平缓冲区，`bundle 片段 → app 接口片段 → plugin 尾部
片段` 三层顺序拼接（下层不可改写上层）；无块栈、无 prompt 中间件/洋葱。由会话
spec（`{ prompt片段, tools }`）一次性拼装（`@applepi/bundle` 的
`assembleFlatPrompt`），每轮重建 = 重读同一份 spec + 当前级别（bundle 权限声明段按
级别分档）。

**模式选择**：仅新建会话时选（web 新对话下拉 / CLI `--mode`），非热切换、非事件；
记入 `session.config.mode`（并在会话 jsonl 记一次 `mode` 事件行以便恢复时重建），
会话内不可变。恢复时按 `lastEvent('mode')` 重建匹配的 spec。

**core 收敛**：`registerExtension` / `SetupFn` / `HarnessApi` / `OnionBus` /
`HookStack` / 洋葱中间件 / `emit` 事件族 / `system_prompt` 事件族 / `PromptBag` /
`buildSystemPrompt` 已从 core 移除。`registerExtension` 仅作为 app 层插件加载器形态
残存（`apps/agent/plugins.ts`，加载 `{ prompt?, tools? }` 插件）。

## 2. 核心运行时（`@applepi/core`）

核心是一组**单职责深模块**（ADR-0015 §1.5），由薄 Harness 壳组装；按 ADR-0005
不含工具，ADR-0009 把安全强制机制收归内置。core 的模块组成：

1. **`llm`**（ADR-0015 新增）— **LLM 交互面**：工具目录 + 单段模型响应。封装
   `generateText`/`streamText`、`reasoningProviderOptions`（推理等级映射）、
   `buildToolDefs`；`loop`/`stream-loop` 经 `harness.llm.generate` / `harness.llm.stream`
   取模型调用，不再直接依赖 AI SDK。消耗 app 已组装的 `{ prompt, tools }` 与 history
   产出一段响应（ADR-0015）。
2. **`loop`** — 内置 agent loop，两个变体：CLI 的 `runLoop`（`generateText`，
   一轮跑完，§5）；web 的 `runLoopStreamSegment`（`streamText`，token 级分段流 +
   暂停/恢复状态机，§9.1）。两者都经 `llm` 模块发起模型调用，工具经
   `harness.executeTool`（工具执行缝）执行。
3. **`session`** — 会话持久化（jsonl，同时充当流式 loop 的暂停点状态，§6）。
4. **`config`** — LLM 配置解析：settings.json + .env，见 §10。
5. **`security`** — 权限级别强制机制（三值级别模型 + `level/set` 事件与恢复 +
   上下文注入，工具 execute 读 level 自决，§7）。声明段在 bundle（base/standard 各自
   按级别分档），core 只保留强制机制 + `/level` 命令。
6. **`trace`** — 可观测性埋点（Langfuse Cloud，§9.4）。
7. **`Harness`（壳）** — 组装以上模块 + 生命周期；owns `llm`，提供
   `registerTool`/`unregisterTool`/`getTools`/`buildToolDefs`、
   `registerSlashCommand`/`getSlashCommand`、`attachSession`/`restoreSecurity`/
   `resume`、`executeTool`（工具执行缝）、`run`（CLI 单回合，接收 app 组装的扁平
   提示词）；无洋葱、无 `emit` 事件总线、无扩展加载器（ADR-0015 已移除）。

> 为什么核心无工具：核心的消费方（未来的 web UI 等）不应被迫继承 shell 访问、
> 文件编辑和安全策略（ADR-0005 的问题陈述）；ADR-0015 强化为「core 只关心 LLM
> 交互」——system_prompt + tools。

## 3. 能力装配：bundle / capability / plugin（ADR-0015）

能力注入不再是 core 的通用机制（`registerExtension`/`api`/洋葱已移出 core）。能力
由 **bundle**（核心能力集）、**capability 工厂**（memory/skills）与 **plugin**
（外部追加）三层构成，全部由 **app 层**装配到 Harness 壳上：

- **Bundle（能力包）** — `packages/bundle` 的 `base` / `standard`：纯声明
  `(env) => ({ prompt, tools })`，无 side effect、无 core/onion 访问。app 建会话时选
  一个（mode），`enableBundleSpec(harness, spec)` 注册其工具。
- **Capability（能力）** — `@applepi/extensions` 的能力工厂（`createMemory` /
  `createSkills`）返回 `{ id, prompt(env, session), tools }`。bundle 的
  `capabilities` 声明 id 清单，app 用 `getCapability(id)` 解析、注册工具并每轮把
  `prompt(env, session)` 片段并入扁平提示词（如 skills 把已加载技能渲染成片段）。
  尚无工厂的 id（web/plan/goal/...）被跳过——声明可多于实现。
- **Plugin（插件）** — `apps/agent/plugins.ts` 的 `loadPlugins(dir)`：扫描
  `extensions/` 下 `*.ext.ts`，默认导出为 `{ prompt?, tools? }` 声明对象或
  `(env, session) => { prompt?, tools? }` producer。插件**只追加**：工具注册到
  Harness、prompt 片段并入尾部，不可重排/删除 bundle 内部。`/reload` = 撤销
  插件工具 + 重扫 + 重建提示词（bundle/mode 不可变）。

**装配流程（app 每轮）**：选取 mode → `makeBundleSpec(mode, { cwd, workspace, level })`
→ `enableBundleSpec`（注册 bundle + capability 工具）→ 加载插件 → 用
`assembleFlatPrompt(harness, spec, { app, plugins })` 拼出扁平提示词 =
`[...bundle.prompt, ...capabilities.prompt, ...app 接口片段, ...插件尾部]`，交给
`harness.llm` / `loop`。重建 = 重读同一份 spec（无动态中间件）。

**工具注册**：`harness.registerTool(spec)`（重复名抛错）/ `unregisterTool` /
`getTools` / `buildToolDefs`（委托 `llm`，模型侧只看 `{ description, parameters }`）。

## 4. 扁平系统提示词（Flat system prompt）

系统提示词是**单一扁平缓冲区**，无块栈、无 prompt 中间件、无 `PromptBag`
（ADR-0015，supersedes ADR-0008/0010）。三层硬编码顺序拼接：

```
bundle 片段 → app 接口片段 → plugin 尾部片段
```

- 下层不可改写上层；顺序是声明的，不是协商的。
- 权限声明段是 **bundle 自有片段**（`basePermissionFragment` /
  `standardPermissionFragment`），按当前级别（readonly/workspace/fullaccess）分档
  渲染；core 的 `security` 只强制、不写提示词文案。
- 重建 = 每轮用当前 env（级别、工作区）重读同一份 spec 重新拼接
  （`assembleFlatPrompt`），因此 `level/set`、`reasoning/set` 只是普通状态记录，
  不再是提示词重建触发器。
- 系统消息持久化：新会话 / `/reload` 时 app 写一条 `system` 消息行到 jsonl；
  会话内每轮直接用新拼的提示词（replay 时最新 system 替换 message[0]，见 §8）。

## 5. 内置 Agent Loop

```
loop:
  messages = [ system(扁平提示词), ...history ]
  for each turn:
    resp = harness.llm.generate({ model, messages, tools })   # llm 深模块（ADR-0015）
    if resp has toolCall:
      result = harness.executeTool(toolCall)          # 工具执行缝（安全缝：ctx 带级别）
      append tool result to messages
      continue
    else:
      return resp.text
```

- **Provider 抽象**：经 **Vercel AI SDK**（`generateText` / `streamText` +
  provider 适配器），由 `llm` 模块封装（ADR-0015：`Llm.generate` /
  `Llm.stream`），不自己写多模型适配，`loop` 也不直接接触 SDK。
- **工具暴露给模型**：扩展注册的工具经 `llm.buildToolDefs()` 生成
  `{ description, parameters }` 目录，并入 `generateText({ tools })`（无 execute——
  执行由 loop 自行驱动，以便工具缝包裹）。
- **系统提示词注入**：每轮 `messages[0]` 由 app 用 `assembleFlatPrompt` 组装的扁平
  提示词（bundle 片段 + 能力片段 + app 接口片段 + 插件尾，ADR-0015）提供——重建 =
  重读同一份 spec，无动态中间件。系统消息行只在会话启动 / `/reload` 时持久化一次
  （app 层 `appendMessage('system', ...)`）；会话内每轮直接用新拼的提示词
  （ADR-0002 replay 语义：最新 system 替换 message[0]）。

## 6. 工具与 Vercel AI SDK 映射

扩展注册工具用 **zod**（而非裸 JSON Schema）：

```ts
api.registerTool({
  name: "grep",
  description: "在文件中搜索正则",
  parameters: z.object({ pattern: z.string(), path: z.string() }),
  execute: async (args) => runGrep(args),
});
```

核心在注册时把 `ToolSpec` 转成 AI SDK `tool()`，并入 `generateText({ tools })`。

## 7. 安全模型（Permission Levels, ADR-0007 + ADR-0009）

- **权限级别系统**：`readonly` / `workspace` / `fullaccess`，会话级单一主级别，统一作用于所有工具。
  每个级别由「可读 × 可写」两维构成——读一律全盘，写范围分级（readonly 不可写；workspace 仅限
  project root=cwd realpath 内；fullaccess 任意）。
- **工具自决（ADR-0009）**：core 内置 SecurityPolicy（默认实现），无运行时拦截中间件；
  每个工具 execute 读 `ctx` 中的 level 自行约束行为（bash 只读白名单、sre view-only 等）。
- **denylist 底线**：原 8 条危险正则作为**任何级别下都生效的绝对底线**，内嵌于 bash 工具自身
  （`fullaccess` 也不允许 `rm -rf`、fork bomb 等）。
- **提示词携带级别（ADR-0015 最终形态）**：权限**声明段**由 bundle 各自承载
  （base/standard 的 `*PermissionFragment`，按当前级别分档渲染），app 每轮把它并入
  扁平提示词；core 的 `security` 只保留强制机制，不再写任何提示词文案。级别变化是
  普通状态记录（`level/set`），不触发提示词重建——下一轮拼接自然带上新级别。
- **级别持久化**：`level/set` 事件写入会话 jsonl；当前级别 = 最后一个 `level/set` 事件的
  `payload.level`，无则默认 `workspace`（`SessionStore.lastEvent` 读取，`restorePermissionLevel` 恢复）。
- **只有用户能改级别**：`/level <readonly|workspace|fullaccess>` 是用户驱动的 slash 命令
  （`registerSlashCommand` 扩展点），模型没有改级别工具（防自我提权）。
- **信任边界**：extension 同进程 = 等价授信；权限系统防的是**模型自主用工具犯错**，不是防扩展。

## 8. 会话持久化

见 ADR-0002 + ADR-0006 完整决策。要点：

- **存储**：每个会话一个 append-only jsonl：
  `~/.applepi/sessions/<workspace>/<session_id>.jsonl`。
  每行是 `kind:"event"`（生命周期事件）或 `kind:"message"`（LLM 消息）。
- **行结构（ADR-0006 精简后）**：
  - 事件行：`{"kind":"event","event":"level/set","payload":{...},"ts":<ISO>}`
    —— `event` 字段合并了类型与阶段（`reload/start|end` 等带相位；`level/set`、
    `reasoning/set`、`title/set`、`mode` 等为原子事件）。`system_prompt/*` 事件族已随
    ADR-0015 移除。
  - 消息行：`{"kind":"message","role":"system|user|assistant|tool","content":...,"ts":<ISO>}`。
  - 行内**不含** `session_id` / `workspace`：会话与工作区身份由文件路径承载，
    行不再自包含（旧 ADR-0002 的"每行可独立审计"语义已放弃）。
- **SessionStore 归核心**：`create` / `appendEvent` / `appendMessage` /
  `load`（replay 变换） / `lastEvent` / `list`。CLI 与 web UI 都驱动同一套核心方法。
  ADR-0015 移除 `emit` 事件总线后，事件（`level/set`、`reasoning/set`、`title/set`、
  `mode`、`tool/approval-pending`、`reload/start|end` 等）由 app / 工具直接
  `store.appendEvent` 写入 jsonl——`appendEvent` 就是存储原语，不再有 core 内置事件处理器。
- **Replay（只读）**：读取时过滤 message 行；若存在 `reload` 事件，最新重建的
  system 消息替换 `message[0]`；原 jsonl 永不被改写。
- **Resume / Reload**：`/resume <id>` 切换活动会话并继续追加；`/reload`（app 层）=
  撤销插件层工具 + 重扫 `extensions/` + 重建扁平提示词并持久化新 system 消息
  （bundle/mode 与 `session.scratch` + `session.history` 不变，无 new Harness）。
- **系统提示词（ADR-0015 扁平模型，supersedes ADR-0008/0010）**：单一扁平缓冲区 =
  `bundle 片段 → app 接口片段 → plugin 尾部片段` 顺序拼接；无块栈、无 PromptBag、
  无提示词中间件。重建 = 每轮用当前 env（级别/工作区）重读同一份 spec
  （`assembleFlatPrompt`）。系统消息行只在会话启动 / `/reload` 时由 app
  `appendMessage('system', ...)` 持久化。
- **Slash 命令（核心能力，非 CLI 专属）**：`/level`（core 自注册）/ `/reload` `/resume <id>` `/new`
  `/sessions` `/config` `/help` `/exit`。

## 9. 界面：CLI 与 Web 双接口

Harness 现在有两个界面，共享同一个 core（Harness + SessionStore + `runLoopStreamSegment`
+ SecurityPolicy + trace）。CLI 是本地 REPL 主入口；Web 是个人本地界面（无鉴权），
把同样的 core 能力通过 HTTP 暴露给浏览器。

- **CLI（`apps/agent`）**（§5）— REPL，用 `runLoop`（`generateText`，一轮跑完）驱动。
- **Web（`apps/web`，`@applepi/web`）** — Next.js App Router（默认端口 3000，`pnpm dev:web`）
  + assistant-ui 0.15 primitives（`ExternalStoreRuntime` 适配器）+ Tailwind v4 +
  Vercel AI SDK v4 数据流（`createDataStreamResponse` + `processDataStream`）。

### 9.1 流式 loop（streaming loop, ADR-0011）

core 新增 `runLoopStreamSegment`：`streamText` 变体，token 级分段流 + **暂停/恢复
状态机**。与 CLI 的 `runLoop`（`generateText`）并存——CLI 一次性跑完一轮；web 分段流，
遇到需批准的 `ask` 工具暂停、批准后从 jsonl 持久化的暂停点续跑（**不重跑 LLM**，
jsonl 即 loop 状态，见 P13）。

### 9.2 工具批准（tool approval, ADR-0011）

web 会话对工具执行采用**前端批准**：

- `ToolSpec.approval`（`auto` / `ask` / 按参数函数，缺省 `ask`）分类；
- `ask` 工具暂停并持久化 `tool/approval-pending` 事件；`POST /api/chat/approve`
  从暂停点续跑；
- 读类（`memory_read` / `skill_load` / `view` / bash 只读命令）自动执行，写/执行类须批准；
- **拒绝 = 工具结果回填模型**（模型可自愈）。CLI 语义不变。

### 9.3 工作区选择器与会话动作

- 页面可选择已有工作区或手动添加（`GET|POST /api/workspaces`，manifest 记录
  slug↔path；CLI 建的 workspace 经 `unslugWorkspace` 反解回填真实路径，避免 slug
  被 `path.resolve` 污染 cwd）；
- `session.config.workspace` 决定工具 cwd 与 project root（`workspaceRoot(ctx)`）；
  切换后 resume 该工作区最近会话（无则新建）；
- **mode（ADR-0015）**：会话按 mode（base/standard）缓存独立 Harness（工具集不可变）；
  新会话在首条消息带上 `mode`，服务端记一次 `mode` 事件行；恢复时 `lastEvent('mode')`
  重建匹配 spec；
- 会话动作 API（`PATCH /api/session`）：rename / pin / unpin / archive / unarchive /
  notify / level；`GET /api/session?format=jsonl` 导出；级别切换走 core
  `applyPermissionLevel`（写 `level/set`，扁平提示词下一轮自带上新级别，无重建），
  与 CLI `/level` 同语义。

### 9.4 可观测性（Langfuse trace, ADR-0012）

埋点位于 **core 层**（`trace.ts`）：每轮一条 trace + 每条 LLM 调用一个 generation
（带 token usage）+ 每工具一个 span；CLI 与 web 双端自动受益，目标 **Langfuse
Cloud**（`~/.applepi/.env` 的 `LANGFUSE_BASE_URL` / `PUBLIC_KEY` / `SECRET_KEY`），
未配置则为 no-op（见 P14）。

### 9.5 Web UI 壳（base 风格复刻）

复刻 assistant-ui playground base 壳视觉：外层灰底圆角白卡两栏（移动端抽屉）；
侧栏 = 品牌 + 新对话 +「空间(N)」+ 按工作区分组的会话树（folder+⌄折叠、5 条 +
查看更多、活跃高亮、hover 三件套）；composer 大圆角框 + 框下胶囊行（工作区胶囊仅
空态新会话出现、权限胶囊常驻）；会话/工具/批准卡片统一 base 审美。视觉 faithfully
跟随、产品 delta 显式记录（见 P15 与 CONTEXT.md「Web UI shell」段）。

### 9.6 二期增量（会话搜索 / @引用文件 / 通知推送）

一期壳之上的三个增量（2026-08-20）：

- **会话搜索**：侧栏「空间(N)」头下搜索框，跨工作区按标题实时过滤，扁平展示（标题 + 所属工作区 + 时间），清空恢复树。纯前端、零依赖。
- **@引用文件（路径引用）**：`GET /api/files`（受工作区根约束的安全递归列举，跳过 `.git`/`node_modules`/`.next` 等大目录，限深度 10 / 遍历预算 6000 / 返回 60 条）支持 `@` 触发路径输入 + 建议；选中注入路径 chip，发送时把引用路径作为结构化前缀（`用户引用了以下文件：\n- <path>`）拼入 user 消息，LLM/工具据此读取——走路径引用而非内容注入，避免上下文膨胀。`chat-store` 新增 `references`/`addReference`/`removeReference`/`send`（发送前拼前缀并清空引用）。
- **通知推送**：会话出现 pending 批准时，已授权弹浏览器桌面通知（`Notification` API，首次发送时在用户手势内 `requestPermission`），否则降级页面内 toast（5s 自动消失）。客户端监听 `pending` 变化触发。

> 见 CONTEXT.md「Web 二期」段与 `apps/web`（`sidebar.tsx` / `chat-ui.tsx` / `chat-store.ts` / `app/api/files/route.ts`）。

## 10. LLM 配置

见 ADR-0004 完整决策。要点：

- `~/.applepi/settings.json` 是 **LLM 配置唯一来源**（不再读 process.env）：
  `{ provider, model, apiKey, baseURL? }`。
- `~/.applepi/.env` 存真实密钥（`dotenv.parse`，纯解析不污染环境变量）。
- **解析规则**：`apiKey` 字段是密钥名，`realKey = dotenv[apiKey] ?? apiKey`。
- 配置解析原语归核心（`loadSettings` / `loadDotenv` / `resolveApiKey` /
  `resolveLlmConfig`），agent 负责组装 provider 实例。
- `/config` 重新读配置并重建模型；`/reload` **不**触碰 provider。

## 11. 仓库布局

```
applepi/
├── package.json            # workspace 编排器（build / dev / dev:web / test / verify）
├── pnpm-workspace.yaml     # packages: ["packages/*", "apps/*"]
├── tsconfig.base.json      # 共享编译配置
├── packages/
│   ├── core/               # @applepi/core：深模块 llm·loop·session·config·security·trace + Harness 壳（无工具、无洋葱）
│   ├── bundle/             # @applepi/bundle：base / standard 能力包，纯声明 (env)=>({prompt,tools}) + app 侧装配助手
│   └── extensions/         # @applepi/extensions：参考工具 bash/sre + 能力工厂 memory/skills
├── apps/
│   ├── agent/              # @applepi/agent：REPL 主入口（--mode）+ 插件加载器 + extensions/*.ext.ts + scripts/check-*
│   └── web/                # @applepi/web：Next.js 界面（assistant-ui + Tailwind v4），§9
├── docs/
│   ├── README.md           # Wiki 首页
│   ├── architecture.md     # 本文档
│   ├── design-principles.md
│   ├── adr/                # ADR-0001 ~ 0015
│   └── agents/             # agent 协作约定
└── CONTEXT.md              # 术语表 + 已锁定决策（单一事实来源）
```

- **构建策略**：build-first，跑 agent / web / check 前先构建依赖包（`pnpm -r build`
  拓扑序自动处理）。
- **验证**：`pnpm verify` = build + 各包测试 + 六个 key-free 检查脚本
  （`check-ext` / `check-session` / `check-skills` / `check-memory` /
  `check-denylist` / `check-security`；`check-soft-isolation` 已随洋葱移除删除）。

## 12. 已移除：MCP

MCP 功能整体移除（Q11，2026-08-19）：`mcp_call` 工具、`createMcpExtension`、
check-mcp、相关测试与文档全部删除。需要外部集成时凭 bash 即可触达，
或后续再评估枚举 mcp-cli servers。

## 13. 待确认项

1. `SessionContext` 字段（history / config / scratch）的精确结构。
2. ~~denylist 默认黑名单/白名单的具体内容~~ → 已由 ADR-0007 确认：denylist 8 条危险正则作为底线 + 权限级别白名单/路径规则。
3. 是否生成最小可运行脚手架（含 AI SDK 接入，需 API key）。
