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
2. **补两个字段** —— `label`（官方给的是英文工具名，界面要中文展示名）；
   `details` 归一（官方有些工具返回 `undefined`，本项目要求有值）

逻辑一行不改。于是 `effects.ts` 完全不知道 pi-coding-agent 存在，环的逻辑一行都不用改。

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

## 浏览器侧

浏览器**不注册任何工具**。这四个全都直接摸真实文件系统、起真实子进程，浏览器里一个都用不了。

Web 的工具能力来自「内核在 Node」—— 浏览器发消息，Node 跑环，工具在那里执行。见
[kernel](kernel.md)。

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
