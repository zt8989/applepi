# 环

## 环长什么样

```
                      dispatch(Action)
  界面（TUI） ────────────────────────────►  agentReducer（纯函数）
       ▲                                          │
       │                                          │ 算状态 + 查「这个 action 的 effect 是谁」
       │  store.subscribe(state)                   ▼
       │                                 redux-loop 的 install() enhancer
       │                                          │ 执行 Cmd.run
       │                                          ▼
       └────────── Action 回流 ◄───────── LLM 流式调用 / 工具执行
                   （Cmd.dispatch）
```

reducer 里没有一个 `await`、没有一个 `fetch`。真正干活的 `Cmd.run` 把结果（包括 token 增量）
作为 action 再 dispatch 回来。

## 三张表

| 表 | 在哪 | 是什么 |
| --- | --- | --- |
| transitions | `reducer.ts` 的 `transitions` | action → 下一个状态（纯函数） |
| 接线（effects） | `reducer.ts` 的 `loopWiring` | action → Cmd[]（纯数据，无 `if`） |
| effect 表 | `effects.ts` 的 `createPiAiEffectTable` | `agent.run` / `tool.call` 的真正实现 |

15 种 action 里，`transitions` 全部有对应项。其中 **`llm.giveup` 目前没有任何地方 dispatch**
（`llm.failed` 在重试用尽时直接把相位推到 `idle` 就够了），留着是给「显式收工」用的备用口。

## 环上每一步

| 进来的 Action | 状态迁移 | 接线发出什么 |
| --- | --- | --- |
| `user.message` | 追加 user 消息，开一个 `user` 节点，相位 → `thinking` | `Cmd.action(turn.start)` |
| `turn.start` | 开一个 `turn.start` 容器（回合层），`turnIndex` +1 | `Cmd.action(step.start)` + `Cmd.action(agent.run)` |
| `step.start` | 开一个 `step.start` 容器（parent = 回合容器），清上一次的错误 | `Cmd.action(agent.run)` |
| `agent.run` | 相位 → `thinking`，流式缓冲清零 | `Cmd.run(streamFn)` |
| `llm.started` | 流式累积清零，`streamSeq` +1 | 无 |
| `llm.delta` / `llm.thinking` | 累积流式文本 | 无（渲染用） |
| `llm.done`（有 toolCall） | 追加 assistant 消息，开 `llm.result`，相位 → `calling-tools` | `Cmd.run(执行工具)` |
| `llm.done`（无 toolCall） | 开 `llm.result`，**关掉 step**，相位 → `idle`，**环在这里闭合** | `Cmd.action(turn.end)` |
| `tool.start` | 开一个 `tool.attempt` 节点 | 无 |
| `tool.result` | 开 `tool.result`（失败则开 `error`），并入 messages，累加本步工具数 | 无 |
| `tool.batch.done` | **关掉 step**，相位 → `thinking`（撞上限则 → `idle` + `stop` 节点） | steer 有货：`Cmd.action(queue.delivered)`；否则 `step.start` + `agent.run` |
| `llm.failed`（可重试且还有次数） | 开 `error` 节点、**关掉这个 step**，**相位留在 `thinking`** | `Cmd.action(step.start)` + `agent.run`（重试是**兄弟** step） |
| `llm.failed`（重试用尽 / 不可重试） | 开 `error` 节点，关掉 step，相位 → `idle` | `Cmd.action(turn.end)` |
| `turn.end` | 关掉回合容器（**推进 tip**）；队列里还有 followUp 则**接着开新回合** | 无（`turn.start` 由迁移直接开） |
| `queue.input` | 运行中则入队；**空闲时直接转成 `user.message`** | 转 user.message 时：`Cmd.action(turn.start)` |
| `queue.delivered`（steer） | 插入 user 消息，节点挂在**当前回合容器**下，**不开新回合** | `step.start` + `agent.run` |
| `queue.delivered`（followUp） | 插入 user 消息，**关掉旧回合 + 开新回合** | 有下一条 followUp 时 `Cmd.action(turn.start)` |
| `trace.persisted` | 落盘游标前移 | 无 |

## 队列：生成中也能说话

`queue.input` 带 `as: 'steer' | 'followUp'`（语义与 pi 的 `steer()` / `followUp()` 一致）：

- **steer**：当前 step 的工具跑完后、**下一次 LLM 调用前**插进去（投递点在 `tool.batch.done`）。
  它属于**当前回合** —— 不新开 turn。
- **followUp**：等模型没有工具调用了（回合收工）才插，然后**开一个新回合**
  （投递点在 `turn.end` 的迁移里）。

两列队列各自 FIFO、互不排队。

## 接线表里几处刻意的「绕圈」

`user.message`、`llm.failed`（重试）、`tool.batch.done` 三处发的是「再 dispatch 一次」
而不是直接调 `runAgent()`。原因是：**只有让 reducer 再看到一次 `step.start`，它的迁移才会开出
一个新的 step 容器。** 直接调下一个 effect 的话，这一轮 LLM 在树上就没有节点，
它的 `llm.result` 会变成孤儿（parent 为 null，浮在根上）。

## 两个必须记住的 redux-loop 陷阱

**1. 接线返回**裸 Cmd**，不能包 `Cmd.list`。**
`createAgentReducer` 收到一个命令数组，长度为 1 走 `loop(state, cmd)`，大于 1 才走
`loop(state, Cmd.list(cmds))`。若接线返回 `Cmd.list([...])` 而调用方又把它当一个命令放回
数组，就得到 `Cmd.list([Cmd.list([...])])` —— **嵌套 LIST**。redux-loop 的
`handleParallelList` 对嵌套的非 batch LIST 会把内层返回的 `[]` 一路吞掉，那条 action
**既没执行也没报错**。症状是「该开的节点都开了，就是链路最后一步静默断掉」。

**2. `turn.end` 的 Cmd 是在「phase 已经 idle」之后才被冲刷的。**
`waitForIdle` / 落盘器监听的是 `phase === 'idle'`，而 `turn.end` 是 `llm.done` 的接线在那之后
才发出来的。所以：`waitForIdle` 返回的状态**不包含** `turn.end`（回合容器还开着），
读 `stats.turns` 会得到 0。要断言回合数得等一拍再重新读 `store.getState()`。

`llm.done` 的工具分支是同一个陷阱的另一面：它发的是 `Cmd.run(执行工具)` 而不是 `redispatch`，
因为 `llm.done` 是从 `Cmd.run` 的 `successActionCreator` 进来的。工具的 `tool.attempt` 节点由
`tool/start` 的迁移开，而 `tool/start` 本来就是 `executeToolCalls` 内部 dispatch 的第一条
action，所以不会漏。

## 接线读的是**迁移之后**的状态

`createAgentReducer` 里 `emit(typed, nextState)` 传的是 `nextState`，不是 `state`。

原因：`llm.failed` 判出的 `retrying` 是它的迁移**刚算出来**的。传旧状态的话，接线永远看不到
本次 action 造成的新事实，重试就发不出去。

这也是为什么 `llm.done` 的接线里不能用 `phase === 'thinking'` 判定 ——
`llm.done` 的迁移已经把相位推到 `calling-tools` 了，那个条件永远为假，工具永远不跑。
该跑的判据是「这次确实带工具调用」。

## 超时与重试

超时是 effect 侧的事（`effects.ts`）：

- 每次 LLM 调用起一个 `setTimeout`，到点 `controller.abort(new LlmTimeoutError(...))`。
- 流被 abort 后没有 `done` 事件，所以 `callLlm` **主动**检查 `timedOut` / `signal.aborted` 并抛出
  真正的原因 —— 否则会落到下面那句「流在 done 之前结束」，报一个与真实原因无关的错误，
  超时也就不会被判定为可重试。
- `LlmTimeoutError` 是一个专门的 Error 类型，分类时不必去猜文案。

分类与重试判定：

| 类别 | 可重试 | 判据 |
| --- | --- | --- |
| `timeout` | ✓ | `LlmTimeoutError`，或文案含 timeout / 超时 |
| `network` | ✓ | fetch failed / ECONNRESET / socket hang up / 网络 |
| `auth` | ✗ | 401 / 403 / api key / 鉴权 |
| `model` | ✗ | model / 模型 |
| `aborted` | ✗ | 手动中断（Ctrl-C） |
| `unknown` | ✗ | 兜底 |

`llm.failed` 的迁移做判定：可重试 **且** `llmAttempts < maxLlmAttempts`（默认 2，即失败后重试一次）
→ 相位留在 `thinking`；否则 → `idle`。接线看到 `state.retrying` 为真就补一条 `agent.run`。

一轮结束（`tool.batch.done`）时 `llmAttempts` 归零，下一轮又从第 1 次尝试开始。

## 轮数上限

`tool.batch.done` 时若 `turns >= maxTurns`，开一个 `stop` 节点（它是闭合的，
所以推进 tip）、相位 → `idle`。这一步必须在 reducer 里闭合，否则 `waitForIdle` 永远等不到。

**默认不设上限**（`maxTurns = Infinity`，见 `state.ts`）。曾经默认 25，代价很实际：
一次提问（「把图片上传做完」）触发的 ReAct 循环跑到第 25 轮被砍，现象是「模型干着活突然停了」，
而用户只发了一条消息 —— 容易被误判成 bug 或模型自己放弃了。

注意 `turns` 数的是**LLM 调用次数**，不是工具调用次数：一次 `llm.done` 加 1，
哪怕这一轮并行发了 5 个工具调用。`user.message` 时归零，所以它管的是「一个用户消息 + ReAct 循环」。
需要兜底时用 `--max-turns <n>`。

## 相关

- 这些节点为什么长成那样 → [trace](trace.md)
- 谁在调 `agent.run` → [kernel](kernel.md)
