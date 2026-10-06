# 内核

## 一个装配点

`createKernel()`（`src/kernel.ts`）是整个应用**唯一**跑环的地方。

```ts
export function createKernel(options: KernelOptions): Kernel {
  // 1. runtime（真 provider，或 demo 的 faux）
  // 2. sessionId（决定 traces/<id>.jsonl 的文件名）
  // 3. 落盘 sink（traceDir === null 则完全不落盘）
  // 4. createPersistentStore({...})  ← 环在这里诞生
  return { store, runtime, sessionId, persistence, dispose };
}
```

它返回的就是 `createPersistentStore` 的结果加上 `runtime` / `sessionId` / `dispose`，
没有额外的包装层。界面（`src/tui/`）调它，没有第二处装配。

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
├── sink             trace-file.ts：追加写 ~/.pi/agent/traces/<id>.jsonl
└── createPersistentStore
    ├── store         createStore + redux-loop 的 install()
    ├── trace         trace.ts 的 createTraceTree（sessionId 相同）
    └── persistence   trace-store.ts：订阅 store，把新节点刷进 sink
```

`createPersistentStore` 与 `createAgentStore` 的差别只有一处：前者额外挂一个订阅器做落盘。
后者保持只返回 store，因为测试要的就是 store 本身。

## 工具的工作目录

`KernelOptions.cwd` 决定工具的路径边界，一路传到 `getTools(cwd)`。

官方工具（`createReadTool(cwd)` 等）在**构造时**就把 cwd 烤进闭包，所以 `src/tools.ts` 的注册表
**按 cwd 缓存**（key 是 `path.resolve(cwd)`）：同一个 cwd 复用同一批实例，换 cwd 必须重建，
否则边界还是旧的。

`--cwd` 因此只决定工具能碰哪些文件。

## 界面启动

```
npm start              →  src/tui.ts     → createKernel() → runTui({store})
```

## 相关

- 环怎么转 → [loop](loop.md)
- 渲染层 → [surfaces](surfaces.md)
- 工具 → [tools](tools.md)
