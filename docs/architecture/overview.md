# 总览

## 三条铁律

这三条是判断「某个改动该不该做」的依据。别的都是细节。

### 1. 环只有一份，跑在 Node 里

`createKernel()`（`packages/core/src/kernel.ts`）是**唯一**的装配点。界面（`packages/tui/src/`）调它，没有第二处。

这不是为了好看。环有副作用：真的调模型、真的读写文件、真的起子进程。如果另有一处也跑一份
store、也跑环，就会出现两处都发起 LLM 调用、消息流不一致、文件被写两次。

所以：

- `npm start` 读 `kernel.store`，界面只订阅、只 dispatch，**不自己跑环**。
- 浏览器界面（[webui](webui.md)）是**同一个 store 的第二个订阅者** —— 它连 tui 的 web
  server，状态与事件都由桥从这一个 store 映射出去；两边说的话进的是同一个环。

配置这一层**直接用 pi-coding-agent 的 `ModelRuntime`**（它自己读 `~/.pi/agent` 的
models.json / auth.json、做 schema 校验、拼凭证优先级，并自带 44 个内置 provider 的
完整目录）。我们不手写那套，只保留手写路径作降级与离线测试。见 [provider](provider.md)。

### 2. reducer 里没有 `if (kind === 'agent')`

Agent 只是一个 Action（`agent.run`），和 `tool.call`、`user.message` 完全平级。谁执行它，
是**接线**时注入的 effect 表决定的 —— `loopWiring()` 是一张纯数据表，没有一行 `if`。

reducer 只做两件事：算下一个状态、查「这个 action 类型的 effect 是谁」。

### 3. 失败和成功一样入树

错误节点不是状态里的一句字符串，是轨迹树上的一个节点，和成功节点走同一条路落盘。

推论：重试是**同一个容器里的下一次尝试**（error 与后续产出平级、顺序即先后），不是「覆盖上次的结果」，也不另开 step。见 [trace](trace.md)。

## 进程与端口

| 入口 | 命令 | 进程 | 端口 |
| --- | --- | --- | --- |
| TUI | `npm start` | 只有自己 | 无（直接用终端） |

## 一次消息的路径（TUI）

```
终端界面                      Node 内核
  │                            │
  │  dispatch({type:'user.message'})
  ├───────────────────────────►│
  │                            │  reducer 迁移：追加 user 消息、开一个 user 节点
  │                            │  接线：Cmd.action(turn.start)
  │                            │        ↓ 再走一次 dispatch
  │                            │  reducer 迁移：开一个 turn.start 容器（回合层）
  │                            │  接线：Cmd.action(step.start) + Cmd.action(agent.run)
  │                            │        ↓ 再走一次 dispatch
  │                            │  reducer 迁移：开一个 step.start 容器（parent = 回合容器）
  │                            │  接线：Cmd.run(callLlm)
  │                            │        ↓ effect 真去调模型
  │  ◄── 订阅回调 ──────────────┤  状态一变就重绘
  │                            │        ↓ token 增量 → llm.delta ×N
  │  ◄── 订阅回调 ──────────────┤
  │                            │  llm.done → 开 llm.result（有工具则 tool.call → runTools）
  │                            │  tool.batch.done → 关掉 step → step.start → 下一轮
  │  ◄── 订阅回调（phase:idle）─┤  环闭合
  │                            │        ↓ （turn.end 是 idle 之后才冲刷的）
  │  ◄── 订阅回调 ──────────────┤  关掉回合容器（推进 tip）
```

生成中还能说话：发 `queue.input`（`as: 'steer' | 'followUp'`）。steer 在「工具跑完、下一次
LLM 调用前」投递并**留在当前回合**；followUp 在「回合收工」时投递并**开新回合**。
详见 [loop](loop.md) 与 [trace](trace.md)。

界面**不参与**中间任何一步，它只在状态变化时被告知。

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
- 渲染层 → [surfaces](surfaces.md)
