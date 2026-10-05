# 总览

## 三条铁律

这三条是判断「某个改动该不该做」的依据。别的都是细节。

### 1. 环只有一份，跑在 Node 里

`createKernel()`（`src/kernel.ts`）是**唯一**的装配点。TUI 和 Web 都调它，没有第二处。

这不是为了好看。环有副作用：真的调模型、真的读写文件、真的起子进程。如果浏览器里也跑一份
store、也跑环，就会出现两边都发起 LLM 调用、消息流不一致、文件被写两次。

所以：

- `npm start`（TUI）直接读 `kernel.store`
- `npm run serve`（Web）起同一个内核，浏览器通过 SSE 订阅、POST 发消息

**浏览器里没有 store，也没有任何 Cmd。** `web/` 下只有渲染层。

### 2. reducer 里没有 `if (kind === 'agent')`

Agent 只是一个 Action（`agent.run`），和 `tool.call`、`user.message` 完全平级。谁执行它，
是**接线**时注入的 effect 表决定的 —— `loopWiring()` 是一张纯数据表，没有一行 `if`。

reducer 只做两件事：算下一个状态、查「这个 action 类型的 effect 是谁」。

### 3. 失败和成功一样入树

错误节点不是状态里的一句字符串，是轨迹树上的一个节点，和成功节点走同一条路落盘。

推论：重试是**分叉**，不是「覆盖上次的结果」。见 [trace](trace.md)。

## 进程与端口

| 入口 | 命令 | 进程 | 端口 |
| --- | --- | --- | --- |
| TUI | `npm start` | 只有自己 | 无（直接用终端） |
| Web | `npm run serve` | Node 内核 + 静态文件 | 5273（被占则 +1，最多试 10 次） |
| Web 开发 | `npm run serve` + `npm run web` | 两个 | 内核一个 + vite 5173 |

`--port 0` 让 OS 挑端口，启动横幅打印真正绑到的那个。

## 一次请求的路径（Web）

```
浏览器                     Node 内核
  │                            │
  │  POST /api/message         │
  ├───────────────────────────►│  store.dispatch({type:'user.message'})
  │                            │
  │                            │  reducer 迁移：追加 user 消息、开一个 user 节点
  │                            │  接线：Cmd.action(agent.run)
  │                            │        ↓ 再走一次 dispatch
  │                            │  reducer 迁移：开一个 llm.attempt 节点（parent = tip）
  │                            │  接线：Cmd.run(callLlm)
  │                            │        ↓ effect 真去调模型
  │  ◄── SSE 一帧 ──────────────┤  状态一变就推（40ms 攒帧）
  │                            │        ↓ token 增量 → llm.delta ×N
  │  ◄── SSE 一帧 ──────────────┤
  │                            │  llm.done → 开 llm.result（有工具则 tool.call → runTools）
  │                            │  tool.batch.done → agent.run → 下一轮
  │  ◄── SSE 一帧（phase:idle）─┤  环闭合
```

浏览器**不参与**中间任何一步，它只在状态变化时被告知。

## 数据流的三种形状

| 形状 | 例子 | 落点 |
| --- | --- | --- |
| 状态 | `AgentState` | `state.ts`，一棵纯数据树 |
| 动作 | `AgentAction` | `actions.ts`，13 种 |
| 副作用 | `Cmd` | `effects.ts` 的 `createPiAiEffectTable`，两张表（pi-ai 版 / 测试注入） |

## 相关

- 环怎么转 → [loop](loop.md)
- 轨迹树 → [trace](trace.md)
- 内核装配 → [kernel](kernel.md)
- 工具 → [tools](tools.md)
- 两个渲染层 → [surfaces](surfaces.md)
