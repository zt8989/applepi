# event-loop-agent

用 **Redux Loop**（[redux-loop](https://github.com/redux-loop/redux-loop)，Elm Architecture 移植到
Redux 的那个开源库）做 **Agent Loop**，模型走 **Pi**（`@earendil-works/pi-ai`，与你的 DeepSeek
Harness 同一套 provider 装配），配一个 **pi-tui** 终端界面和一个用 **pi-web-ui** 做的网页界面。

Agent 不是一个对象，也不是一个类 —— 它只是 `agent.run` 这一个 Action，和 `tool.call`、
`user.message` 完全平级。两个界面也只是渲染层：它们不驱动环，环跑在 Redux 里。

执行历史不是一条流水，而是一棵**像 git log 一样的树**：一次尝试一个节点，失败和超时也留在树上，
重试是分叉。见下面「轨迹树」。

## 环长什么样

```
                      dispatch(Action)
  CLI / Web UI ─────────────────────────────► agentReducer（纯函数）
       ▲                                          │
       │                                          │ 算状态 + 查「这个 action 的 effect 是谁」
       │  store.subscribe(state, action)          ▼
       │                                 redux-loop 的 install() enhancer
       │                                          │ 执行 Cmd.run
       │                                          ▼
       └────────── Action 回流 ◄───────── LLM 流式调用 / 工具执行
                   （Cmd.dispatch）
```

reducer 里没有一个 `await`、没有一个 `fetch`：它只做两件事 —— **算下一个状态**、**把副作用描述成
Cmd 丢出去**。真正干活的 `Cmd.run` 把结果（包括 token 增量）作为 action 再 dispatch 回来。

### 环上每一步

| 进来的 Action | 状态迁移 | 接线发出什么 |
| --- | --- | --- |
| `user.message` | 追加 user 消息，相位 → `thinking` | `[agent.run]` |
| `agent.run` | 相位 → `thinking` | `[llm.done]`（effect 回流） |
| `llm.delta` / `llm.thinking` | 累积流式文本 | 无（渲染用） |
| `llm.started` | 流式累积清零，`streamSeq` 加一 | 无 |
| `llm.delta` / `llm.thinking` | 累积流式文本 | 无（渲染用） |
| `llm.done`（有 toolCall） | 追加 assistant 消息，相位 → `calling-tools` | `Cmd.action(tool.call)` |
| `llm.done`（无 toolCall） | 相位 → `idle`，**环在这里闭合** | 无 |
| `tool.call` | 记下待执行的工具调用 | `[tool.batch.done]`（effect 回流） |
| `tool/start` / `tool.result` | 记 executing / `toolResult` 并入 messages | 无 |
| `tool.batch.done` | 相位 → `thinking`（撞上限则回 `idle`） | `[agent.run]` ← 回到 LLM |
| `llm.failed`（可重试且还有次数） | 树上挂 error 节点，**相位留在 `thinking`** | `[agent.run]` ← 自动重试 |
| `llm.failed`（重试用尽 / 不可重试） | 树上挂 error 节点，相位 → `idle` | 无（环闭合） |

`user.message → LLM → 工具 → LLM → … → idle` 就是 agent 循环；它由数据（Action）驱动，
因此每一步都能在测试里断言，不需要 mock 一个 while 循环。

## 一张 reducer，一张 effect 表

这是整个设计的核心：**reducer 里没有 `if (kind === 'agent')`**，Agent 只是一个 Action
（`agent.run`）。谁来执行它，是**接线**时注入的 effect 表决定的。

接线的形状（`loopWiring`）是纯数据，没有一行 `if`：

| 进来的 Action | 接线发出什么 |
| --- | --- |
| `user.message` | `Cmd.action(agent.run)` ← 让迁移先开出一个 attempt 节点 |
| `agent.run` | `Cmd.run(streamFn)` |
| `llm.started` | 无（纯状态变更：流式累积清零） |
| `llm.done` | 有工具时 `Cmd.run(执行工具)` |
| `llm.failed` | 可重试且还有次数 → `Cmd.action(agent.run)`；否则无 |
| `tool.call` | `Cmd.run(执行工具)` |
| `tool.batch.done` | `Cmd.action(agent.run)` ← 环在这里闭合 |

几处刻意的「绕一圈」（`Cmd.action` 而不是直接调下一个 effect）：`user.message`、
`llm.failed`（重试）、`tool.batch.done`。它们都要让 reducer **再看到一次** `agent.run`，
好让 `agent.run` 的迁移在轨迹树上开出一个新的 `llm.attempt` 节点。直接调下一个 effect 的话，
这一轮 LLM 在树上就没有节点，result 会变成孤儿。

`llm.done` 是唯一例外：它发的是 `Cmd.run(执行工具)` 而不是绕一圈。因为 `llm.done` 是从
`Cmd.run` 的 `successActionCreator` 进来的，此时 redux-loop 的 `cmdsQueue` 已经被外层
`dispatch` 取走，从这里再 dispatch 一个 action，它触发的 Cmd 没人冲刷 —— 环会停在
`calling-tools`。工具的 attempt 节点由 `tool/start` 的迁移开，而 `tool/start` 本来就是
`executeToolCalls` 内部 dispatch 的第一条 action，所以不会漏。

TUI 和 Web 共用**同一个 reducer、同一个状态树、同一张 effect 表**。
## 轨迹树（trace tree）：像 git log 一样的执行历史

Agent 的执行历史不是一条流水。`src/trace.ts` 把它做成**一棵树**，概念直接照搬 git：

| git | 这里 |
| --- | --- |
| commit 有 parent | 每个节点有 `parentId` |
| commit 有分支（`--graph` 里的 `\|` `/` `\`） | **重试就是分支** |
| HEAD 指向当前所在的线 | `tipId` = 最后一条闭合节点 |
| `git reflog` 只追加不改写 | `.trace/<id>.jsonl` 追加写 JSONL |

### 关键规则：attempt 的父 id 取「发起时」的 tip

这是最容易做错的地方，所以写成了不变量：

> **只有 `user` / `llm.result` / `tool.result` / `stop` 这四类节点推进 tip。**
> `llm.attempt`、`tool.attempt` 是容器（分叉点），`error` 是失败记录 —— 它们**都不推进 tip**。

于是 LLM 第一次调用超时后的重试，树上长这样：

```
✓ n1 user: 今天几号？
├── ✗ n2 llm.attempt: 第 1 次尝试 407ms
│  └── ✗ n3 error: LLM 调用超时（400ms） (kind=timeout)
├── ✗ n4 llm.attempt: 第 2 次尝试（重试） 414ms
│  └── ✗ n5 error: LLM 调用超时（400ms） (kind=timeout)
└── ✓ n6 llm.attempt: 第 3 次尝试（重试） 1.2s
   └── ✓ n7 llm.result: 10 月 5 日
HEAD → n7
```

注意 `n4` 的父 id 是 **`n1`**（超时前的那个节点），不是 `n3`（失败节点）。
失败与重试是**兄弟**，这正是 git 的语义 —— 如果错误节点推进了 tip，重试就会被挂到
「错误的子节点才是正史」下面，那就不是 git 了。

环上对应的那一步：`llm.failed` 判出「可重试且还有次数」时，把相位**留在 `thinking`**
（环不闭合），接线看到就补一条 `agent.run`；而 `agent.run` 的迁移开新节点时取的正是
此刻的 tip —— 那个从没动过的 `n1`。

### 错误也持久化

error 节点和成功节点走**同一条路**落盘，所以「失败过」这件事不会随着对话滚出屏幕而消失。
`createTracePersistence` 是个 store 订阅器（不是 effect 表里的一行），因为它几乎每次 dispatch 都要跑，
而且**对成功与失败一视同仁** —— 这正是需求要的那种语义：出错的那条路径也必须落盘。

写盘失败（磁盘满、权限）不会打断环：游标不推进，下次状态变化再试一遍。

回放时坏行直接跳过 —— 崩溃只会丢掉最后没写完的那半行。

### 在哪儿看

- **TUI**：`Ctrl+T` 切换轨迹面板；一次性模式（`-p`）直接把纯文本的树打到 stdout。
- **Web**：底部可折叠的「轨迹」条，展开就是同一棵树（两个界面共用 `renderTree`）。
- **文件**：`.trace/<sessionId>.jsonl`，一行一个节点（`add` / `close` 两种 op）。

`src/trace.ts` 是纯函数：没有 IO、没有 `Date.now()`、没有随机数，节点 id 由 reducer 单调自增。
所以同一串 Action 必然产出同一棵树 —— 能在测试里逐字断言，也能在 TUI 侧从 JSONL 回放重建。

## 界面

### 终端（pi-tui）

```bash
npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY

npm start                          # 交互式（pi-tui 差分渲染）
npm start -- -p "今天几号？"        # 跑一条就退出，顺带打印轨迹树
npm start -- --demo                # 不打网络：pi-ai 自带的 faux provider
npm start -- --llm-timeout 30000 --attempts 3   # 短超时 + 三次尝试，好看到重试分叉
```

界面里：`Ctrl+T` 切换轨迹面板，`Ctrl+C` 中断当前回合（空闲时退出）。

选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、
`--llm-timeout`、`--attempts`、`--api-key`、`--demo`、`--no-trace`、`--session`、`-h/--help`。

### Web（pi-web-ui）

```bash
npm run web                                  # http://localhost:5273
open http://localhost:5273/?demo=1          # 离线 demo（faux provider，不用 key）
```

> `read_file` 工具在浏览器里不可用（要读真实文件系统），`main.ts` 里过滤掉了。

## Web 侧怎么接的（为什么不需要 pi-agent-core）

pi-web-ui 在**运行时从不 import pi-agent-core** —— 对它的引用 100% 是 `import type`。
它唯一碰「session」的地方是 `AgentInterface`，而它要的是**鸭子类型**，不是 `instanceof Agent`：

```ts
session.state.messages / .tools / .model / .thinkingLevel
session.state.isStreaming / .pendingToolCalls
session.subscribe(cb) => unsubscribe   // 唯一的更新驱动
session.prompt(input)                  // 发送
session.abort()                        // 停止
```

它只 `switch` 7 种 lifecycle 事件（`message_start` / `turn_start` / `turn_end` /
`agent_start` / `message_end` / `agent_end` / `message_update`），其余一概不看。

`web/src/session-adapter.ts` 就是这层翻译，而且是**全仓库唯一**知道 pi-web-ui 存在的地方：

1. 从 Redux 状态树造出上面那个 `state` 结构（每次都是新对象 / 新数组，pi-web-ui 按引用判断重渲染）。
2. 订阅 `store`，把状态变化翻译成那 7 种事件。

为什么从**状态树**推导而不是转发 action？因为 `Cmd.dispatch` 走的是 redux-loop 自己的
dispatch，绕过了我们能包装的那一层；状态树是环的收敛点，从它出发不会漏掉任何一条 action。

这也意味着 Web 侧**没有**任何「特殊接线」：不置空任何一行，不双跑一轮 ——
因为环本来就该由 Redux 驱动。

两个容易踩的坑，adapter 里都处理了（`main.ts` / adapter 里有注释）：

- `state.messages` 必须每次给**新的数组**，否则工具回合之后最后一条回答不显示。
- `MessageEditor` 是**直接写** `session.state.thinkingLevel = level` 的，所以 adapter 把这两个
  字段做成 setter，把赋值翻成 `thinking.changed` / `model.changed`，而不是改一个没人看的新对象。

## Provider：Pi（和 DeepSeek Harness 一样）

`src/provider.ts` 与 `my-pi-desktop/src/main/agent/runtime.ts` 是同一套路：

```ts
const models = createModels();
models.setProvider(deepseekProvider());          // pi-ai 自带 providers/deepseek
const model = models.getModel('deepseek', id);   // 模型目录来自 provider
models.streamSimple(model, context, options);    // 流式调用，事件是 AssistantMessageEvent
```

- 鉴权：TUI 读 `DEEPSEEK_API_KEY`（provider 自带的 `envApiKeyAuth`）或 `--api-key`；
  Web 侧由 pi-web-ui 弹窗填，存进 IndexedDB。
- 模型：默认取 deepseek provider 目录里的第一个，`-m` / `?model=` 可换。
- 换 provider：TUI `-P anthropic|openai`；Web `?provider=xxx`。

### 加工具

`src/tools.ts` 里加一个对象即可，TUI 和 Web 都会用：

```ts
const myTool: AgentTool = {
  name: 'read_file', label: '读文件', description: '…',
  parameters: Type.Object({ path: Type.String() }),
  execute: async (id, params, signal) => ({ content: [{ type: 'text', text: '…' }], details: null }),
};
```

## 测试

```bash
npm test          # 29 个离线测试
npm run typecheck # tsc --noEmit（src + test）+ tsc --noEmit -p web
```

覆盖：环闭合、轮数上限、错误路径、reducer 纯性、faux provider 端到端、Web adapter，
以及轨迹树本身 —— 包括**「超时后重试的父 id 指向超时前的节点」**这条不变量、
错误节点落盘、从 JSONL 回放重建、界面与命令行渲染出同一棵树。


## 目录

```
src/
  actions.ts      所有 Action（Elm 里的 Msg）
  state.ts        单一状态树（含轨迹树与重试/超时字段）
  reducer.ts      transitions 表（纯函数）+ 接线（action type → Cmd[]）
  effects.ts      effect 表：agent.run → Cmd.run(streamFn)，工具也由自己的 Cmd 跑
  trace.ts        轨迹树：节点/父子/tip/渲染/序列化（纯函数，无 IO）
  trace-store.ts  轨迹落盘：JSONL 追加写 + 回放 + 驱动器
  trace-file.ts   Node 端 sink：写 .trace/<sessionId>.jsonl
  store.ts        createStore + redux-loop 的 install()，waitForIdle，createPersistentStore
  tools.ts        内置工具（now / calc / read_file）
  provider.ts     Pi(pi-ai) 装配：createModels + deepseekProvider + streamSimple
  tui.ts          入口：装配 + 落盘，然后交给 tui/app.ts
  tui/app.ts      pi-tui 界面：对话区 + 轨迹面板（Ctrl+T）
web/
  src/main.ts            pi-web-ui 装配：Redux 状态树 + adapter + 顶栏
  src/session-adapter.ts 状态树 → pi-web-ui 的 lifecycle 事件
  src/trace-panel.ts     底部轨迹面板（与 TUI 共用 renderTree）
test/            离线测试（faux provider，不打网络）
  trace.test.ts         轨迹树：重试父 id、不变量、端到端超时
  trace-persist.test.ts 错误落盘、JSONL 回放、界面渲染一致性
.trace/         运行时生成的轨迹 JSONL（已 gitignore）

## 边界

- 工具在本地直接执行（`read_file` 读真实文件），没有沙箱；只当自己机器上的小助手用。
- `--demo` / `?demo=1` 走 pi-ai 自带的 faux provider，只为演示与自检，不会真的调模型。
- Web 侧没接会话持久化：`SessionsStore` 只是在 `AppStorage` 构造函数里占位（pi-web-ui 强制要四个
  store），顶栏的「新对话」是清空，不落盘。要接的话看 `web/src/main.ts` 里的 `sessions`。
- pi-web-ui 自带一份嵌套的 `pi-ai@0.75.5`，本项目根目录是 `0.84.4`。两边都是纯数据交互，
  实测（浏览器 demo）没问题，但这是「碰巧兼容」，不是「设计上兼容」。
