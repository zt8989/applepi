# 架构（Architecture）

> 状态：锁定（2026-08-18/19，经 `/grill-me` 16 轮 + `/grill-with-docs` 多轮访谈）。
> 本页是系统设计的权威入口，细节与决策依据见各 ADR。

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
│  安全扩展 权限级别系统（permission，含 denylist 底线）        │
│  baseExtension（一键还原默认能力集）· memory · skills         │
└───────────────▲─────────────────────────────────────────────┘
                │ 依赖：extensions → core（单向）
┌───────────────┴─────────────────────────────────────────────┐
│  packages/core  (@applepi/core)  —— 纯运行时骨架，无工具      │
│  洋葱事件总线（session/llm/tool/system_prompt 四栈）· loader   │
│  内置 agent loop · SessionStore · LLM 配置解析               │
└─────────────────────────────────────────────────────────────┘
```

依赖方向（ADR-0003）：`@applepi/agent → @applepi/extensions → @applepi/core`。
跨包引用一律用包名（`@applepi/core` 等），解析到各包 `dist/`。

## 2. 核心运行时（`@applepi/core`）

核心只有五样东西，**不含任何工具**（ADR-0005 把工具与 denylist 全部移出核心）：

1. **洋葱事件总线** — 四个中间件栈（`session` / `llm` / `tool` / `system_prompt`），见 §4。
2. **加载器（Loader）** — 发现并加载扩展，见 §3。
3. **内置 agent loop** — 会话循环，见 §5。
4. **SessionStore** — 会话持久化（jsonl），见 §6。
5. **LLM 配置解析** — settings.json + .env，见 §7。

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
  use(stack: "session" | "llm" | "tool" | "system_prompt", // 挂载中间件到某栈
      mw: Middleware,
      opts?: { priority?: number }): void;
  registerToolFilter(fn: ToolFilter): void;  // 裁剪模型可见的工具 schema（ADR-0007）
  registerSlashCommand(name, handler): void; // 注册 slash 命令（ADR-0007 Q13）
  getSlashCommand(name): SlashHandler | undefined;
  emitSystemPrompt(): Promise<{ prompt: string; sections: string[] }>; // 重建+持久化（ADR-0008）
  appendEvent(event, payload?): Promise<void>; // 写生命周期事件到 jsonl（P7）
  ctx: SessionContext;                        // 会话状态读写
  getTools(): ToolSpec[];
}
```

系统提示词经 `system_prompt` 栈构建（ADR-0008）：中间件在入口
`ctx.promptParts.push(section)`（可整体改写数组）、`ctx.sections.push(label)`，
harness 收尾 `join('\n\n')` 归一化并返回 `{ prompt, sections }`。

### 3.4 `baseExtension`（默认能力集）

`@applepi/extensions` 导出一个 `SetupFn`：注册参考工具 `bashTool` +
`strReplaceEditorTool`，并挂载权限扩展（`createPermissionExtension`——权限中间件
priority 1000 最外层 + 工具裁剪 + 权限提示词段落 + `/level` 命令）。一行调用即可
还原默认能力集：

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
| `system_prompt` | 系统提示词构建（进：push 段落 + 标签 / 可整体改写；ADR-0008） |

```ts
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;
```

- **观察**：读 `ctx`，调 `await next()`。
- **否决（veto）**：不调 `next()`（或 `throw`），内层与最终执行被截断。
  `system_prompt` 栈上 veto 只跳过后续段落，不拦持久化（ADR-0008 Q6）。
- **改写**：`next()` 前改入参、`next()` 后改出参（mutate `ctx`）。

**排序**：同栈内按 `priority` 排序（高 = 外层，进入最先、退出最后）。
`system_prompt` 栈约定 base 挂 priority 1000 使段落最前（ADR-0008 Q3）；安全
扩展据此卡在 tool 栈最外圈审最终参数。

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
- **系统提示词注入**：每轮 `messages[0]` 由 `buildSystemPrompt()` 生成——运行
  `system_prompt` 栈拼装段落（ADR-0008），会话启动 / `/reload` / `/level` 时
  同时持久化新 system 消息行（ADR-0002 replay 语义）。

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

## 7. 安全模型（Permission Levels, ADR-0007）

- **权限级别系统**：`readonly` / `workspace` / `fullaccess`，会话级单一主级别，统一作用于所有工具。
  每个级别由「可读 × 可写」两维构成——读一律全盘，写范围分级（readonly 不可写；workspace 仅限
  project root=cwd realpath 内；fullaccess 任意）。
- **双层机制**：注册面裁剪（`registerToolFilter` 裁剪模型可见的工具 schema，readonly 下
  `str_replace_editor` 只剩 `view`、`memory_write` 隐藏）+ 运行时拦截（`permissionMiddleware`
  挂 tool 栈 priority 1000 最外层，ENTRY veto + EXIT 审计内层改写后的最终参数）。
- **denylist 底线**：原 8 条危险正则作为**任何级别下都生效的绝对底线**，内嵌于权限中间件
  （`fullaccess` 也不允许 `rm -rf`、fork bomb 等）。
- **提示词携带级别**：权限扩展在 `system_prompt` 栈上贡献「Permission Level」
  系统提示词段落（级别声明 + 可用能力清单，ADR-0008），
  启动/恢复/`/level` 切换时重建。
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
- **Replay（只读）**：读取时过滤 message 行；若存在 `reload` 事件，最新重建的
  system 消息替换 `message[0]`；原 jsonl 永不被改写。
- **Resume / Reload**：`/resume <id>` 切换活动会话并继续追加；`/reload` 重建
  整个 Harness（保留 `session.scratch` + `session.history`），重新发现扩展并
  重建系统提示词。
- **系统提示词 = `system_prompt` 栈构建（ADR-0008）**：中间件 push 段落到
  `ctx.promptParts`（可整体改写数组），并 push 标签到 `ctx.sections`；
  base 挂 priority 1000 最外层，扩展默认 0；harness 统一 `join('\n\n')` 归一化，
  返回 `{ prompt, sections }`（取代 Q10=c 的 `addSystemPromptContributor` 与
  更早的 llm 中间件注入）。
- **Slash 命令（核心能力，非 CLI 专属）**：`/reload` `/resume <id>` `/new`
  `/sessions` `/config` `/help` `/exit`。

## 9. LLM 配置

见 ADR-0004 完整决策。要点：

- `~/.applepi/settings.json` 是 **LLM 配置唯一来源**（不再读 process.env）：
  `{ provider, model, apiKey, baseURL? }`。
- `~/.applepi/.env` 存真实密钥（`dotenv.parse`，纯解析不污染环境变量）。
- **解析规则**：`apiKey` 字段是密钥名，`realKey = dotenv[apiKey] ?? apiKey`。
- 配置解析原语归核心（`loadSettings` / `loadDotenv` / `resolveApiKey` /
  `resolveLlmConfig`），agent 负责组装 provider 实例。
- `/config` 重新读配置并重建模型；`/reload` **不**触碰 provider。

## 10. 仓库布局

```
applepi/
├── package.json            # workspace 编排器（build / dev / test / verify）
├── pnpm-workspace.yaml     # packages: ["packages/*", "apps/*"]
├── tsconfig.base.json      # 共享编译配置
├── packages/
│   ├── core/               # @applepi/core：总线 / loader / loop / session / config（无工具）
│   └── extensions/         # @applepi/extensions：参考工具 + 权限级别系统 + baseExtension + memory/skills
├── apps/
│   └── agent/              # @applepi/agent：REPL 主入口 + *.ext.ts + scripts/check-*
├── docs/
│   ├── README.md           # Wiki 首页（本页）
│   ├── architecture.md     # 本文档
│   ├── design-principles.md
│   ├── adr/                # ADR-0001 ~ 0008
│   └── agents/             # agent 协作约定
└── CONTEXT.md              # 术语表 + 已锁定决策（单一事实来源）
```

- **构建策略**：build-first，跑 agent / check 前先构建依赖包（`pnpm -r build`
  拓扑序自动处理）。
- **验证**：`pnpm verify` = build + 各包测试 + 七个 key-free 检查脚本
  （`check-ext` / `check-soft-isolation` / `check-session` / `check-skills` /
  `check-memory` / `check-denylist` / `check-permission`）。

## 11. 已移除：MCP

MCP 功能整体移除（Q11，2026-08-19）：`mcp_call` 工具、`createMcpExtension`、
check-mcp、相关测试与文档全部删除。需要外部集成时凭 bash 即可触达，
或后续再评估枚举 mcp-cli servers。

## 12. 待确认项

1. `SessionContext` 字段（history / config / scratch）的精确结构。
2. ~~denylist 默认黑名单/白名单的具体内容~~ → 已由 ADR-0007 确认：denylist 8 条危险正则作为底线 + 权限级别白名单/路径规则。
3. 是否生成最小可运行脚手架（含 AI SDK 接入，需 API key）。
