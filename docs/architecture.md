# 架构（Architecture）

> 状态：持续更新（初版 2026-08-18/19 经 `/grill-me` / `/grill-with-docs` 多轮访谈锁定；2026-08-20 纳入 web 双接口、流式 loop、工具批准、Langfuse 埋点，对应 ADR-0011 / ADR-0012）。
> 本页是系统设计的权威入口，细节与决策依据见各 ADR（ADR-0001 ~ ADR-0012）。

## 1. 概览

一个**单机（本地）运行的 agent**：核心运行时极简到只剩骨架，所有增量能力
（工具、skills、memory、安全层）都是**扩展**，在运行时注入。

```
┌─────────────────────────────────────────────────────────────┐
│  apps/agent  (@applepi/agent)                               │
│  REPL 主入口 · main.ts 组装 core + extensions + provider     │
│  extensions/ 本地 *.ext.ts · scripts/ 七个 key-free 检查     │
└───────────────▲─────────────────────────────────────────────┘
                │ 依赖：agent → extensions → core（单向）
┌───────────────┴─────────────────────────────────────────────┐
│  packages/extensions  (@applepi/extensions)                 │
│  参考工具 bash / str_replace_editor                          │
│  baseExtension（一键还原默认能力集）· memory · skills         │
│  （注：SecurityPolicy 自 ADR-0009 起归 core 内置，见 §7）      │
└───────────────▲─────────────────────────────────────────────┘
                │ 依赖：extensions → core（单向）
┌───────────────┴─────────────────────────────────────────────┐
│  packages/core  (@applepi/core)  —— 纯运行时骨架，无工具      │
│  洋葱事件总线（session/llm/tool + prompt/base|permission|skills）│
│  内置 agent loop · SessionStore · LLM 配置解析               │
└─────────────────────────────────────────────────────────────┘
```

依赖方向（ADR-0003）：`@applepi/agent → @applepi/extensions → @applepi/core`。
Web 界面 `@applepi/web` 也只依赖 core（驱动 Harness + SessionStore + `runLoopStreamSegment`），不依赖 agent、也不依赖 extensions——能力集由 core 的扩展加载机制在运行时注入（详见 §9）。
跨包引用一律用包名（`@applepi/core` 等），解析到各包 `dist/`。

## 2. 核心运行时（`@applepi/core`）

核心只含骨架，**不含任何工具**。ADR-0005 把工具与 denylist 移出核心；ADR-0009
又把 SecurityPolicy（权限级别模型）移回核心作为内置机制（工具仍按 level 自决）。
core 的组成：

1. **洋葱事件总线** — 三个横切栈（`session` / `llm` / `tool`）+ 三个提示词块栈
   （`prompt/base` / `prompt/permission` / `prompt/skills`，ADR-0010），见 §4。
2. **加载器（Loader）** — 发现并加载扩展，见 §3。
3. **内置 agent loop** — 两个变体：CLI 的 `runLoop`（`generateText`，一轮跑完，§5）；
   web 的 `runLoopStreamSegment`（`streamText`，token 级分段流 + 暂停/恢复状态机，§9.1）。
4. **SessionStore** — 会话持久化（jsonl，同时充当流式 loop 的暂停点状态，§6）。
5. **LLM 配置解析** — settings.json + .env，见 §10。
6. **SecurityPolicy（内置）** — 三值级别模型 + `level/set` 事件与恢复 + 提示词
   权限段落 + `/level`；无运行时拦截中间件，工具 execute 读 level 自决（ADR-0009，§7）。
7. **trace（可观测性）** — Langfuse Cloud 埋点（每轮 trace + 每 LLM 调用 generation +
   每工具 span），CLI 与 web 双端自动受益；未配置为 no-op（ADR-0012，§9.4）。

> 为什么核心无工具：核心的消费方（未来的 web UI 等）不应被迫继承 shell 访问、
> 文件编辑和安全策略（ADR-0005 的问题陈述）。

## 3. 扩展协议

### 3.1 发现（自动发现）

- 单机场景下扩展即本地目录里的模块，默认扫描 `apps/agent/extensions/` 下的
  `*.ext.ts`，`import` 后调用其默认导出 `setup(api)`。
- （可选）支持 package.json `harness-ext` 字段加载 npm 包形式分发的扩展；
  **主路径是本地目录扫描**。
- **信任模型**：单机本地运行，扩展是用户自己维护的代码，信任闸门即
  "本机你自己的代码"，无需安装时授信。

### 3.2 加载（拉模式）

```ts
export default function setup(api: HarnessApi): void {
  api.registerTool({ /* ... */ });  // 注册工具
  api.use("tool", guardMw);         // 挂载中间件
}
```

### 3.3 `HarnessApi` 表面

```ts
interface HarnessApi {
  registerTool(spec: ToolSpec): void;        // 拉模式注册工具
  use(stack: "session" | "llm" | "tool" | "prompt/base" | "prompt/permission" | "prompt/skills", // 挂载中间件到某栈（ADR-0010）
      mw: Middleware,
      opts?: { priority?: number }): void;
  registerSlashCommand(name, handler): void; // 注册 slash 命令（ADR-0007 Q13）
  getSlashCommand(name): SlashHandler | undefined;
  emit(event, payload?): Promise<any>;       // 发布事件（唯一入口，ADR-0008 演进）
  ctx: SessionContext;                        // 会话状态读写
  getTools(): ToolSpec[];
}
```

**事件发布（emit）**：所有事件统一走 `emit(event, payload)`——没有逐事件的专用
方法。core 内置提示词重建事件族（`system_prompt` 全量入口 + `system_prompt/base|permission|skills`
块事件，重建全部块并持久化，返回 `{ prompt, sections }`）；其余事件
（`skill/start|end`、`reload/start|end`、`level/set`）回退为写一条生命周期事件行到
jsonl（P7）。

**emit 与洋葱栈正交**：emit 是「发布事件」（记录到审计日志 / 触发 core 内置
处理器）；洋葱栈是「执行横切逻辑」（中间件链）。两者是不同机制——提示词重建
事件**触发**三个 `prompt/*` 块栈运行（ADR-0010），但 emit 本身不是第 7 个栈。

系统提示词经三个块栈构建（ADR-0010）：块名 = 栈名（`prompt/base` 等），中间件用
`ctx.prompt.set(block, array | (old) => new)` 写入自己的块（PromptBag，只走 set、
无直接数组变异）；harness 按规范顺序 base → permission → skills 跑栈、join 非空块
并返回 `{ prompt, sections }`（sections = 非空块名列表）。顺序是**结构性保证**，
与注册顺序 / priority 无关——SecurityPolicy 即使最先安装也只写 `permission` 块。

### 3.4 `baseExtension`（默认能力集）

`@applepi/extensions` 导出一个 `SetupFn`：注册参考工具 `bashTool` +
`strReplaceEditorTool`，并贡献 `base` 提示词块（挂在 `prompt/base` 栈）。安全机制
由 core 内置（ADR-0009 SecurityPolicy，贡献 `permission` 块 + `/level`）。一行调用
即可还原默认能力集：

```ts
harness.registerExtension(baseExtension);
```

## 4. 洋葱事件总线（Hook 契约）

4 个中间件栈，每个都是**洋葱模型**（中间件栈，`next()` 串联，进出双向）：

| 栈 | 包裹范围 |
|---|---|
| `session` | 整个会话生命周期 |
| `llm` | 单次 LLM 调用（进：改 messages；出：改 response） |
| `tool` | 单次工具执行（进：改 args / 否决；出：改 result） |
| `prompt/base` | 系统提示词 base 块（ADR-0010，身份 + 工作方式） |
| `prompt/permission` | 权限块（Permission Level 声明） |
| `prompt/skills` | 技能块（已加载 skills，有内容才贡献） |

```ts
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;
```

- **观察**：读 `ctx`，调 `await next()`。
- **否决（veto）**：不调 `next()`（或 `throw`），内层与最终执行被截断。
  veto 只作用于**本块栈内**的后续中间件，跨块 veto 不存在（ADR-0010 Q15=a）；
  不拦持久化（ADR-0008 Q6 延续）。
- **改写**：`next()` 前改入参、`next()` 后改出参（mutate `ctx`）；提示词块用
  `ctx.prompt.set(block, ...)` 写入（只走 set，无直接数组变异）。

**排序**：同栈内按 `priority` 排序（高 = 外层，进入最先、退出最后）。
**块间顺序**：`buildSystemPrompt()` 按 base → permission → skills 固定顺序跑三个
块栈，与注册顺序 / priority 无关（结构性保证，ADR-0010）。

**软隔离**：总线在每层 `next()` 外包 `try/catch`，单个中间件抛错降级并 log，
不拖死整个 loop（tool 栈把异常转成 `ERROR` 结果）。

## 5. 内置 Agent Loop

```
loop:
  messages = ctx.history
  for each turn:
    resp = generateText({ model, messages, tools })   # 经 "llm" 栈
    if resp has toolCall:
      result = executeTool(toolCall)                  # 经 "tool" 栈
      append tool result to messages
      continue
    else:
      return resp.text
```

- **Provider 抽象**：经 **Vercel AI SDK**（`generateText` / `streamText` +
  provider 适配器），不自己写多模型适配。
- **工具暴露给模型**：扩展注册的工具经 AI SDK `tool({ description, parameters:
  zodSchema, execute })` 翻译给模型。
- **系统提示词注入**：每轮 `messages[0]` 由 `buildSystemPrompt()` 生成——按
  base → permission → skills 顺序跑三个 `prompt/*` 块栈拼装（ADR-0010），
  会话启动 / `/reload` 经 `emit('system_prompt')`、`/level` 经
  `emit('system_prompt/permission')` 重建并持久化新 system 消息行（ADR-0002
  replay 语义；任一块事件都全量重建，Q4）。

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
- **提示词携带级别**：SecurityPolicy 在 `prompt/permission` 块栈上贡献「Permission Level」
  系统提示词段落（级别声明，ADR-0010），启动/恢复/`/level` 切换时重建。
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
  - 事件行：`{"kind":"event","event":"system_prompt/start","payload":{...},"ts":<ISO>}`
    —— `event` 字段合并了类型与阶段（`system_prompt/skill/reload` × `start/end`）。
  - 消息行：`{"kind":"message","role":"system|user|assistant|tool","content":...,"ts":<ISO>}`。
  - 行内**不含** `session_id` / `workspace`：会话与工作区身份由文件路径承载，
    行不再自包含（旧 ADR-0002 的"每行可独立审计"语义已放弃）。
- **SessionStore 归核心**：`create` / `appendEvent` / `appendMessage` /
  `load`（replay 变换） / `list`。CLI 与未来 web UI 都驱动同一套核心方法。
  扩展**不直接**调 `appendEvent`——所有事件经 `emit(event, payload)` 发布
  （core 内置处理器或回退写事件行，ADR-0008 演进），`appendEvent` 是 emit
  底层的存储原语（P6/P7）。
- **Replay（只读）**：读取时过滤 message 行；若存在 `reload` 事件，最新重建的
  system 消息替换 `message[0]`；原 jsonl 永不被改写。
- **Resume / Reload**：`/resume <id>` 切换活动会话并继续追加；`/reload` 重建
  整个 Harness（保留 `session.scratch` + `session.history`），重新发现扩展并
  重建系统提示词。
- **系统提示词 = 三个块栈构建（ADR-0010，supersedes ADR-0008）**：中间件用
  `ctx.prompt.set(block, array | (old) => new)` 写入自己的块（PromptBag，只走
  set、无直接数组变异）；harness 按 base → permission → skills 固定顺序跑栈、
  join 非空块，返回 `{ prompt, sections }`（sections = 非空块名列表）。顺序是
  结构性保证，与注册顺序 / priority 无关。重建由 `system_prompt`（全量）或
  `system_prompt/<block>`（语义触发）事件驱动（core 内置处理器 = 构建 + 持久化，
  任一块事件都全量重建）。
- **Slash 命令（核心能力，非 CLI 专属）**：`/reload` `/resume <id>` `/new`
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
- 会话动作 API（`PATCH /api/session`）：rename / pin / unpin / archive / unarchive /
  notify / level；`GET /api/session?format=jsonl` 导出；级别切换写 `level/set` +
  重建提示词，与 CLI `/level` 同语义。

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
│   ├── core/               # @applepi/core：总线 / loader / loop / session / config / SecurityPolicy / trace（无工具）
│   └── extensions/         # @applepi/extensions：参考工具 + baseExtension + memory/skills
├── apps/
│   ├── agent/              # @applepi/agent：REPL 主入口 + *.ext.ts + scripts/check-*
│   └── web/                # @applepi/web：Next.js 界面（assistant-ui + Tailwind v4），§9
├── docs/
│   ├── README.md           # Wiki 首页
│   ├── architecture.md     # 本文档
│   ├── design-principles.md
│   ├── adr/                # ADR-0001 ~ 0012
│   └── agents/             # agent 协作约定
└── CONTEXT.md              # 术语表 + 已锁定决策（单一事实来源）
```

- **构建策略**：build-first，跑 agent / web / check 前先构建依赖包（`pnpm -r build`
  拓扑序自动处理）。
- **验证**：`pnpm verify` = build + 各包测试 + 七个 key-free 检查脚本
  （`check-ext` / `check-soft-isolation` / `check-session` / `check-skills` /
  `check-memory` / `check-denylist` / `check-security`）。

## 12. 已移除：MCP

MCP 功能整体移除（Q11，2026-08-19）：`mcp_call` 工具、`createMcpExtension`、
check-mcp、相关测试与文档全部删除。需要外部集成时凭 bash 即可触达，
或后续再评估枚举 mcp-cli servers。

## 13. 待确认项

1. `SessionContext` 字段（history / config / scratch）的精确结构。
2. ~~denylist 默认黑名单/白名单的具体内容~~ → 已由 ADR-0007 确认：denylist 8 条危险正则作为底线 + 权限级别白名单/路径规则。
3. 是否生成最小可运行脚手架（含 AI SDK 接入，需 API key）。
