# 工具

## 来自 `@earendil-works/pi-coding-agent`

工具不是自己写的，是 Pi 官方 coding agent 用的那一套。源码在那个仓库的
`packages/coding-agent/src/core/tools/`。

```
createCodingTools(cwd, options)     → [read, write, edit, bash]
createReadOnlyTools(cwd, options)   → [read, grep, find, ls]
```

另有 8 个单独的工厂：`createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` /
`createGrepTool` / `createFindTool` / `createLsTool` / `createPowerShellTool`，
以及对应的 `*Definition` 版本（不包装成可执行工具，只给扩展机制用）。

本项目用的是 `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` 四个。

## 换来了什么

自己写要花很多功夫、而且容易写漏的东西：

- **路径边界检查** —— 工厂第一个参数 `cwd` 在构造时就烤进闭包，模型跑不出这个目录
- **文件变更串行化** —— `withFileMutationQueue`，并发 `edit` 不会互相踩
- **截断策略** —— `truncateHead` / `truncateTail`，大文件不会把上下文撑爆
- **bash 超时与子进程回收** —— 含 signal-killed shell 的退出码约定

## 那层适配

官方 `AgentTool`（类型来自 pi-agent-core）的 execute 是**四个**参数：

```ts
execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>
```

本项目只需要前三个（`onUpdate` 是给 UI 流式刷进度用的，我们没有这个需求）。
`src/tools.ts` 的 `adapt()` 做两件事：

1. **签名收窄** —— 丢掉 `onUpdate`，成本项目的 `AgentTool` 形状
2. **补两个字段** —— `label`（官方给的是英文工具名；界面现在也显示英文工具名，
   详见 [surfaces](surfaces.md#为什么不自己画这四种样式)，所以这个 label 只留在本项目内部）；
   `details` 归一（官方有些工具返回 `undefined`，本项目要求有值）

逻辑一行不改。于是 `effects.ts` 完全不知道 pi-coding-agent 存在，环的逻辑一行都不用改。

> 界面渲染用的是 `create*ToolDefinition()`（`src/tui/app.ts`），不是这里的 `AgentTool` ——
> 前者带 `renderShell`（`edit` 是 `"self"`），后者不带。两者形状不同，别混用。

## 五个参数不是公开契约

官方工具的 execute 在实现上是五个参数（末尾还有个 `ctx`，给 `bash` 传 `cwd` 用），
但 `AgentTool` 类型只声明了四个。**照类型走，只传四个**。

`bash` 的 `cwd` 是**工厂函数**的参数（`createBashTool(cwd)`），不是 execute 的第五个参数 ——
第一次接的时候传错了，报 `Working directory does not exist: undefined`。

## 注册表按 cwd 缓存

```ts
const registries = new Map<string, readonly AgentTool[]>();

export function getTools(cwd = process.cwd()) {
  const key = path.resolve(cwd);
  let tools = registries.get(key);
  if (!tools) { tools = build(cwd); registries.set(key, tools); }
  return tools;
}
```

必须按 cwd 缓存，不能用单个全局值：官方工具在构造时就把 cwd 烤进闭包了，
换个 cwd 还复用旧实例的话，路径边界还是老的。用 `path.resolve` 做 key，免得 `'x'` 和 `'./x'`
各建一份。

## 执行路径

工具由环自己跑，不在 effect 表里：

```
llm.done（有 toolCall）
  → 接线发 Cmd.run(executeToolCalls)
      → executeToolCalls 内部：dispatch(tool/start)   ← 开 tool.attempt 节点
                          await getTool(name).execute(call.id, args, signal)
                          dispatch(tool.result)      ← 开 tool.result / error 节点
      → 成功 actionCreator：tool.batch.done
```

`tool/start` 与 `tool.result` 是 `executeToolCalls` 内部 dispatch 的，所以轨迹上的工具节点
和 LLM 节点是同一套机制。

工具抛错不会炸环：`runToolCall` catch 住，包成 `isError: true` 的 `ToolResultMessage`，
在树上开一个 `error` 节点（**不推进 tip**），然后照常回到 LLM。

## 工具在哪执行

这四个工具全都直接摸真实文件系统、起真实子进程，所以它们**只在 Node 侧的环里**执行。
界面只是发消息、画结果，不注册任何工具。

## 加自己的工具

本项目 `AgentTool` 形状很简单（`src/agent-tool.ts`），照着写再 push 进 `build()`：

```ts
const myTool: AgentTool = {
  name: 'my_tool', label: '我的工具', description: '…',
  parameters: Type.Object({ x: Type.String() }),
  execute: async (id, params, signal) => ({
    content: [{ type: 'text', text: '…' }],
    details: null,
  }),
};
```

`details` 必须是 `JsonValue`（pi-ai 1.x 收紧了）—— 它要进消息流、存盘、发给 provider，
所以本来就得能真的 JSON 序列化。

## Skill —— 也在 pi 那一侧（`src/skills.ts`）

skill **不是工具**，是给模型看的「遇到这类任务怎么做」的说明书：一个带 frontmatter
（`name` + `description`）的 `SKILL.md`，正文是说明书。

模型**不会自动加载**正文 —— prompt 里只列一张清单（名字 + 描述 + 文件位置），任务对上号时
它自己调 `read` 去读那个文件。省 token 是这一层的全部意义。

目录与 pi 完全一致：

```
~/.pi/agent/skills/<名字>/SKILL.md    ← 用户级
<工作目录>/.pi/skills/<名字>/SKILL.md ← 项目级
```

再加 `--skill <路径>`（可重复）。

### 复用了 pi 的什么

整套都是官方的，本项目只做三件薄薄的事：

| 本项目 | 直接调 pi 的 |
| --- | --- |
| `loadSkillRegistry()` | `loadSkills()` |
| `skillsPrompt()` | `formatSkillsForPrompt()`（Agent Skills 标准的 XML） |
| `expandSkillCommand()` | 与 pi 的 `_expandSkillCommand()` 逐字同形 |

**不自己扫目录、不自己解析 frontmatter、不自己拼 XML。** 那样只会得到一个会漂移的副本：
pi 改了标准的细节，我们这边不会跟着动。

`/skill:<名字> [问题]` 展开成 `<skill name=… location=…>正文</skill>` 加在问题前面 ——
所以官方 `parseSkillBlock()` 能还原，界面用官方 `SkillInvocationMessageComponent`
画成可折叠块（Ctrl+O 展开）。形状与 pi 一致。

### 两个坑

- **家目录走 `configHome()`**（它转发 pi 的 `getAgentDir()`），而不是各处自己拼路径。
  早先本项目另有 `REDUX_AGENT_DIR` 且优先级高于 pi 的那个，而 pi 不认它 —— 那个状态下
  skill 会永远从真实家目录加载。现在只剩一个变量，两边不可能分家。
- **清单是 `prompt.init` 时定下的。** 之后往目录里加 skill 不会自动生效，要 `/new`
  换个会话（system prompt 在装载时拼好）。界面因此只认 `state.prompt.skills`，
  不重新扫目录 —— 重新扫会得到一个**模型看不到**的清单。

### 与 prompt 的关系

`formatSkillsForPrompt()` 的输出**接在基础 system prompt 后面**，由 reducer 在
`prompt.init` 时拼（`src/reducer.ts`）。走 action 而不是内核里拼，是因为这样会被落盘、
被回放 —— 回放时读到 init 段就知道当时发给模型的完整 prompt 是什么，不必重新扫目录
（那时的目录内容可能已经变了）。轨迹树上也有一个 `prompt.skills` 节点。
