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
没有额外的包装层。TUI 和 Web 都调它，没有第二处装配。

## 为什么不能有两个环

环有副作用：真的调模型、真的读写文件、真的起子进程。如果浏览器里也跑一份 store、也跑环：

- 两边都发起 LLM 调用（双倍 token）
- 两边的消息流不一致（浏览器看到的和实际发生的对不上）
- 文件被写两次（`write` / `edit` 尤其糟）

所以 `web/` 下**没有 store，也没有任何 Cmd**。它只有 `remote-session.ts`（SSE + POST）和渲染。

## 装配了什么

```
createKernel
├── runtime          provider.ts：createModels + deepseekProvider，或 demo 的 faux
├── sessionId        trace.ts 的 newSessionId()
├── sink             trace-file.ts：追加写 ~/.redux-agent/traces/<id>.jsonl
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

`--cwd` 因此有两层含义：工具能碰哪些文件，以及静态文件目录的默认位置（`<cwd>/web/dist`）。

## 两个界面各自的启动

```
npm start              →  src/tui.ts     → createKernel() → runTui({store})
npm run serve          →  src/serve.ts   → startServer() → createKernel() → http 服务
```

`startServer()` 内部也调 `createKernel()`，参数从命令行来。

## 服务端

`src/server.ts`，零依赖（只用 `node:http`）。

| 端点 | 作用 |
| --- | --- |
| `GET /api/events` | SSE：状态一变推一帧（含整棵轨迹树） |
| `GET /api/snapshot` | 首屏拿全量状态 |
| `POST /api/message` | 发一句话。**环在跑时返回 409**，不会双跑 |
| `POST /api/abort` | 中断当前回合 |
| `POST /api/model` | 换模型 |
| `POST /api/reset` | 新对话 |
| `GET /api/tools` | 工具清单 + cwd |
| `GET /*` | 静态文件（`web/dist`），带目录穿越防护 |

### 为什么是 SSE 而不是 WebSocket

这个方向是**纯服务端推送**（浏览器只发不读）。SSE 走普通 HTTP，浏览器自带断线重连，
服务端零依赖。双向那条路（发消息）用 POST 就够。

### 为什么推完整状态而不是增量

状态树本身不大（消息 + 轨迹节点），而增量要处理「客户端漏帧」的问题——漏一帧就得有恢复机制。
序列化成字符串再量过，比维护增量协议简单得多。

### 40ms 攒帧

流式 token 进来时每秒几十帧，逐帧推会把 socket 打满。`server.ts` 里用一个 40ms 的定时器把
连发的变化合成一帧。实测一轮完整对话推 3 帧。

### 心跳与断线

每 25s 发一个 `: ping` 注释行，防止代理掐掉闲置连接。客户端断开时 `req.on('close')` 把它
从集合里摘掉；写失败（客户端已断）只跳过一次，不影响其他人。

## 相关

- 环怎么转 → [loop](loop.md)
- 两个渲染层 → [surfaces](surfaces.md)
- 工具 → [tools](tools.md)
