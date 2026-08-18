# 极简 Agent Harness 工程设计规格（锁定版）

> 本文档是 `/grill-me` 多轮访谈后锁定的设计。所有决策均经逐条确认，
> 括号内标注来源轮次（Q1–Q16）。任何偏离都需重新走 grill 流程。

---

## 0. 设计定位

- **性质**：**单机（本地）运行的 agent**，不是给别人 embed 的框架。（Q1，2026-08-18 更正：原答"框架"作废）
- **极简边界**：极简的是**核心运行时**（事件总线 + 2 个内置工具 + 加载器 + 内置 agent loop）；其余皆为内部模块/扩展，无需对外暴露公共 API。（Q5）
- **能力注入**：所有增量能力（memory / skills / mcp …）都是 extension，运行时注入。（Q2）

---

## 1. 锁定的决策清单

| # | 议题 | 决策 |
|---|---|---|
| Q1 | 产品形态 | **单机（本地）agent**（非框架；原"框架"作答作废，2026-08-18 更正） |
| Q2 | extension vs hook | extension=能力载体（注册 tool/skill）；hook=extension 借以注入的生命周期手段 |
| Q4 | bash 安全 | (b) denylist / allowlist 命令过滤层 |
| Q5 | 极简落点 / loop | 核心运行时极简；**agent loop 内置核心** |
| Q6 | 扩展隔离 | (a) 同进程模块，**零进程隔离**，崩了同崩 |
| Q7 | hook 权力 | (iii) 可观察 + 可否决 + 可改写参数 |
| Q8 | mcp 落地 | (A) 同进程注册；mcp 经 **bash + mcp-cli** 调用，无需专用桥 |
| Q9 | extension 契约 | 拉模式（`api.registerTool`）；`api` 暴露 `ctx`（会话状态读写） |
| Q11 | provider 抽象 | 第三方统一层 → **Vercel AI SDK**（TS） |
| Q12 | 加载方式 | **自动发现**（package.json `harness-ext` 字段） |
| Q13 | 语言/适配层 | TypeScript/Node + Vercel AI SDK（tool 用 **zod** schema） |
| Q14 | 发现协议 | package.json 加 `"harness-ext": "./dist/ext.js"`，loader 扫已装包该字段 |
| Q15 | hook 执行模型 | **洋葱模型**（中间件栈，`next()` 串联，进出双向） |
| Q16 | denylist 落点 | (B) 特权内置扩展，**最外层、不可被覆盖**，核心保持极简 |

---

## 2. 核心运行时（Core Runtime）

仅四件东西，其余全靠扩展：

1. **事件总线（洋葱中间件）** — 见 §4。
2. **内置工具**：`bash`、`str_replace_editor`。
3. **加载器（Loader）** — 见 §3。
4. **内置 agent loop** — 见 §5。

> 注：denylist 不写死在 bash 工具里（否则核心不纯）；它是特权内置扩展（§6）。

---

## 3. Extension 协议

### 3.1 发现（自动发现，Q12/Q14）
- 单机 agent 场景下，扩展即本地目录里的模块，无需发布成 npm 包。默认 **扫描本地 `extensions/` 目录**，按约定（如 `*.ext.ts` 或各子目录的 `index.ts`）`import` 并 `setup(api)`。
- （可选）仍可保留 package.json `harness-ext` 字段机制，用于加载以 npm 包形式分发的扩展；但**主路径是本地目录扫描**。
- **信任模型**：单机本地运行，扩展由你自己维护，信任闸门即"本机你自己的代码"，无需安装时授信那一层顾虑。（Q14，随 Q1 更正而简化）

### 3.2 加载（拉模式，Q9）
Loader 对每个扩展调用其默认导出：
```ts
export default function setup(api: HarnessApi): void {
  api.registerTool({ /* ... */ });   // 注册工具
  api.use("tool", guardMw);          // 挂载中间件（见 §4）
}
```

### 3.3 `HarnessApi` 表面（Q9）
```ts
interface HarnessApi {
  registerTool(spec: ToolSpec): void;     // 拉模式注册工具
  use(stack: "session" | "llm" | "tool",  // 挂载中间件到某栈
      mw: Middleware,
      opts?: { priority?: number }): void;
  ctx: SessionContext;                    // 会话状态读写（Q9-b）
}
```

---

## 4. Hook 洋葱契约（Q15，取代离散事件表）

**取消** Q10 的 7 个离散事件（`pre_llm`/`post_llm`/`pre_tool_call`…）。
改为 **3 个中间件栈**，每个都是洋葱模型：

| 栈 | 包裹范围 |
|---|---|
| `session` | 整个会话生命周期 |
| `llm` | 单次 LLM 调用（进：改 messages；出：改 response） |
| `tool` | 单次工具执行（进：改 args / 否决；出：改 result） |

**中间件签名**：
```ts
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>;
```
- **观察**：读 `ctx`，调 `await next()`。
- **否决（veto）**：不调 `next()`（或 `throw`），后续内层与最终执行被截断。
- **改写**：`next()` 前改入参、`next()` 后改出参（mutate `ctx`）。

**排序**：同栈内按 `priority` 排序注册；洋葱语义下，**先注册=最外层**（进入最先、退出最后），天然保证特权扩展（denylist）卡在最外圈审最终参数。（Q16）

**软隔离**：即便同进程，核心在每层的 `next()` 外包 `try/catch`——单个中间件抛错降级并 log，不拖死整个 loop。（建议，待确认）

---

## 5. 内置 Agent Loop（Q5）

```
loop:
  messages = ctx.history
  for each turn:
    emit "llm" middleware around: resp = aiSdk.generateText({ model, messages, tools })
    if resp has toolCall:
      emit "tool" middleware around: result = executeTool(toolCall)
      append tool result to messages
      continue
    else:
      return resp.text
```

- **Provider 抽象**：经 **Vercel AI SDK**（`generateText` / `streamText` + provider 适配器），不自己写多模型适配。（Q11/Q13）
- **工具暴露给模型**：extension 注册的 tool 经 AI SDK `tool({ description, parameters: zodSchema, execute })` 翻译给模型。（§6 映射）

---

## 6. Tool 与 Vercel AI SDK 映射（Q13）

Extension 注册工具时用 **zod** 而非裸 JSON Schema（修正 Q9 strawman）：
```ts
api.registerTool({
  name: "grep",
  description: "在文件中搜索正则",
  parameters: z.object({ pattern: z.string(), path: z.string() }),
  execute: async (args) => runGrep(args),
});
```
核心在注册时把 `ToolSpec` 转成 AI SDK `tool()`，并入 `generateText({ tools })`。

---

## 7. 安全模型（Q4 / Q16）

- **denylist = 特权内置扩展**：
  - 随核心默认加载，**第一个注册到 `tool` 栈** ⇒ 洋葱最外层。
  - 在 `tool` 中间件中审 `bash` 工具的命令参数，命中黑名单则 **veto**（不调 `next`）。
  - 因为最外层、退出最晚，能审到所有内层改写后的最终命令 ⇒ (b) 安全层在 (iii) 下依然有效（修正 Q7 误判）。
- **信任边界**：extension 同进程 = 等价授信；denylist 防的是**模型自主用 bash 犯错**，不是防扩展。（Q6 推理结论）

---

## 8. MCP（Q8）

- 无专用桥。mcp server 经 **bash 工具调用 `mcp-cli <server> <tool> <args>`** 触达。
- 可选：提供一个 `mcp` 参考扩展，封装常用 mcp-cli 调用为注册工具，提升易用性（非必需）。

---

## 9. 参考扩展接口定义

### 9.1 memory 扩展
```ts
api.registerTool({ name: "memory_read",  parameters: z.object({ key: z.string() }), execute });
api.registerTool({ name: "memory_write", parameters: z.object({ key: z.string(), value: z.string() }), execute });
// 存储后端可插拔：flat file / sqlite / vector；后端接口由扩展自定。
```

### 9.2 skills 扩展
```ts
// 加载 skill 的 markdown 指令，经 "llm" 中间件注入 system prompt / context。
api.use("llm", async (ctx, next) => {
  ctx.messages[0].content += loadSkill(ctx.activeSkill);
  await next();
});
```
- skill 表现形式：带 frontmatter 的 markdown 指令文件；激活即注入。

### 9.3 mcp 扩展（可选）
```ts
// 把 mcp-cli 调用封装为注册工具，隐藏命令行细节。
api.registerTool({ name: "mcp_call", parameters: z.object({ server: z.string(), tool: z.string(), args: z.string() }), execute: bashMcpCli });
```

---

## 10. 建议目录骨架

```
harness/
├── package.json            # 自身声明 + 依赖 ai-sdk
├── src/
│   ├── core/
│   │   ├── bus.ts          # 洋葱中间件总线
│   │   ├── loader.ts       # 扫描 harness-ext 字段、import、setup
│   │   ├── loop.ts         # 内置 agent loop（调 AI SDK）
│   │   └── ctx.ts          # SessionContext
│   ├── tools/
│   │   ├── bash.ts         # 内置工具
│   │   └── str_replace_editor.ts
│   └── builtin/
│       └── denylist.ts     # 特权内置扩展（最外层 tool 中间件）
├── extensions/             # 参考扩展
│   ├── memory/
│   ├── skills/
│   └── mcp/
└── examples/
    └── hello-ext/          # 最小扩展示例（含 package.json harness-ext 字段）
```

---

## 11. 待确认 / 下一步

1. **软隔离**：§4 的 `try/catch` 包裹是否纳入核心？（建议是）
2. **ctx 结构**：`SessionContext` 字段（history / config / scratch）需细化。
3. **denylist 名单**：默认黑名单/白名单内容。
4. **脚手架**：是否按 §10 生成可 `npm install && run` 的最小骨架（含 AI SDK 接入，需 API key）。

---

*锁定于 2026-08-18，经由 /grill-me 16 轮访谈。Q1 于同日更正为"单机 agent"（原"框架"作废），相应修订 §0 / §1 / §3.1。*
