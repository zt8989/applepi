# 内核

## 一个装配点

`createKernel()`（`packages/core/src/kernel.ts`）是整个应用**唯一**跑环的地方。

```ts
export function createKernel(options: KernelOptions): Kernel {
  // 1. runtime（真 provider，或 demo 的 faux）
  // 2. 会话身份（sessionId + cwd）→ 进 store 的 `state.session`
  //    文件名由 id 决定：traces/<时间戳>_<id>.jsonl、sessions/<cwd>/<时间戳>_<id>.jsonl
  // 3. 落盘 sink（traceDir === null 则完全不落盘）
  // 4. createPersistentStore({...})  ← 环在这里诞生
  return { store, runtime, sessionId, persistence, dispose };
}
```

它返回的就是 `createPersistentStore` 的结果加上 `runtime` / `sessionId` / `dispose`，
没有额外的包装层。界面（`packages/tui/src/`）调它，没有第二处装配。

## 会话身份（id / cwd）住在状态里

`state.session = { id, cwd }` 是**唯一真相**：TUI、浏览器（桥）、`/api/*` 都读它。

早先这两样不在状态里 —— id 住在内核闭包里（`current.sessionId`，那是**资源句柄**：
轨迹 sink 与会话文件绑在哪个 id 上），cwd 是内核常量加上桥构造时抄的一份。于是
「同一个进程里两个界面共享一个 store」在**会话身份**这里并不成立：谁要 id 就各自去问
内核、谁要 cwd 就各自抄一份 —— 抄的时间不对，症状就是「浏览器点了新会话，另一边还是
老 id」，而两处都看不出原因。

现在内核里那对 `current` 仍然管文件（换会话要换 sink / 记录器），但**对外只暴露 store
里那一份**：`kernel.sessionId` 也只是 `store.getState().session.id` 的转发。开新会话 /
恢复历史走 `conversation.reset` / `conversation.restored`（两者都带 id），reducer 通过
`createInitialState({ sessionId, cwd })` 重建 `state.session`。

## 为什么不能有两个环

环有副作用：真的调模型、真的读写文件、真的起子进程。如果别处也跑一份 store、也跑环：

- 两处都发起 LLM 调用（双倍 token）
- 两处的消息流不一致（看到的和实际发生的对不上）
- 文件被写两次（`write` / `edit` 尤其糟）

所以界面层里**没有 store，也没有任何 Cmd**，它只订阅状态、只发 dispatch。

## 装配了什么

```
createKernel
├── runtime          provider.ts：createModels + deepseekProvider，或 demo 的 faux
├── sessionId        trace.ts 的 newSessionId()
├── sink             trace-file.ts：追加写 ~/.pi/agent/traces/<时间戳>_<id>.jsonl
└── createPersistentStore
    ├── store         createStore + redux-loop 的 install()
    ├── trace         trace.ts 的 createTraceTree（sessionId 相同）
    └── persistence   trace-store.ts：订阅 store，把新节点刷进 sink
```

`createPersistentStore` 与 `createAgentStore` 的差别只有一处：前者额外挂一个订阅器做落盘。
后者保持只返回 store，因为测试要的就是 store 本身。

## 工具的工作目录

`KernelOptions.cwd` 决定工具的路径边界，一路传到 `getTools(cwd)`，同时进
`state.session.cwd`（界面上显示的那个工作目录就是它）。

官方工具（`createReadTool(cwd)` 等）在**构造时**就把 cwd 烤进闭包，所以 `packages/core/src/tools.ts` 的注册表
**按 cwd 缓存**（key 是 `path.resolve(cwd)`）：同一个 cwd 复用同一批实例，换 cwd 必须重建，
否则边界还是旧的。

`--cwd` 因此只决定工具能碰哪些文件。

## 界面启动

```
npm start              →  packages/tui/src/main.ts     → createKernel() → runTui({store})
```

## 换模型

`kernel.setModel(provider, modelId)`：**一条** action —— `model.changed`，载荷与 `model.init`
**完全一致**（`ModelSpec`：provider / modelId / thinkingLevel / reasoning / capabilities /
contextWindow）。

两条 action 只差语义：`model.changed` 是「**切**成了什么」（轨迹里看得见），`model.init` 是
「**装载**了什么」（开局那一次）。能力（`supportsMidConvoSystemMessages` / `contextWindow`
这些）在模型之间**不一样**，所以必须与切换**同一次**装到位 —— 能力错的后果是发出一份
provider 拒收的请求，而那种失败长得像「随机 400」；早先「先保守清零、等 `model.init` 补」
的两段式因此被去掉了。

两个决定值得记下：

- **先查模型存在再 dispatch**：从 `runtime.models` 取那个 Model 对象，取不到就返回
  `false`、状态原封不动。半换（说要用某个模型、但没人知道它的能力）比拒绝更糟。
- **不改 `runtime.spec` / `runtime.model`**：那是**初始**装配，`extensionModelRegistry()` 与
  `createRuntime()` 都还指着它。改它等于「把历史也改了」—— `/new` 之后本该能回到命令行
  给的那个模型。effect 表每次请求现取（`store.ts` 的 `resolveModel`），所以只换 state 就够。

## 相关

- 环怎么转 → [loop](loop.md)
- 渲染层 → [surfaces](surfaces.md)
- 工具 → [tools](tools.md)
