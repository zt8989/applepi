# event-loop-agent

用 **Redux Loop**（[redux-loop](https://github.com/redux-loop/redux-loop)，Elm Architecture 移植到
Redux 的那个开源库）做 **Agent Loop**，模型走 **Pi**（`@earendil-works/pi-ai`，与你的 DeepSeek
Harness 同一套 provider 装配），配一个简易 CLI 和一个用 **pi-web-ui** 做的网页界面。

一句话：**没有 while 循环的 agent** —— 循环不是写出来的，是 reducer 与副作用互相 dispatch 出来的环。

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
| `llm.done`（有 toolCall） | 追加 assistant 消息，相位 → `calling-tools` | `[tool.call]` |
| `llm.done`（无 toolCall） | 相位 → `idle`，**环在这里闭合** | 无 |
| `tool.call` | 记下待执行的工具调用 | `[tool.batch.done]`（effect 回流） |
| `tool/start` / `tool.result` | 记 executing / `toolResult` 并入 messages | 无 |
| `tool.batch.done` | 相位 → `thinking`（撞上限则回 `idle`） | `[agent.run]` ← 回到 LLM |
| `llm.failed` | 记错误，相位 → `idle` | 无 |

`user.message → LLM → 工具 → LLM → … → idle` 就是 agent 循环；它由数据（Action）驱动，
因此每一步都能在测试里断言，不需要 mock 一个 while 循环。

## 一张 reducer，两套 effect 表

这是整个设计的核心：**reducer 里没有 `if (kind === 'agent')`**，Agent 只是一个 Action
（`agent.run`）。谁执行它，是**接线**时注入的 effect 表决定的：

| 接线 | `agent.run` 的实现 | 环由谁驱动 |
| --- | --- | --- |
| `createPiAiEffectTable` | `models.streamSimple(...)`（自己调 pi-ai） | redux-loop + 本仓库的 `effects.ts` |
| `createAgentDrivenEffectTable` | `Agent.prompt(...)`（交给 pi-agent-core） | pi-agent-core 的 `Agent`；桥把事件翻译成 action |

所以 CLI 和 Web 共用**同一个 reducer、同一个状态树**，只是各接一张表。

- CLI（`src/effects.ts`）：LLM 与工具自己跑，token 增量经 `Cmd.dispatch` 回流。
- Web（`web/src/`）：pi-web-ui 的聊天组件直接调 `session.prompt()`（pi-agent-core 的 `Agent` 驱动），
  `web/src/bridge.ts` 把 Agent 的 lifecycle 事件翻译成同一套 action 灌进状态树；
  接线四行全部置空，避免 reducer 和 Agent 双跑一轮。

## Provider：Pi（和 DeepSeek Harness 一样）

`src/provider.ts` 与 `my-pi-desktop/src/main/agent/runtime.ts` 是同一套路：

```ts
const models = createModels();
models.setProvider(deepseekProvider());          // pi-ai 自带 providers/deepseek
const model = models.getModel('deepseek', id);   // 模型目录来自 provider
models.streamSimple(model, context, options);    // 流式调用，事件是 AssistantMessageEvent
```

- 鉴权：CLI 读 `DEEPSEEK_API_KEY`（provider 自带的 `envApiKeyAuth`）或 `--api-key`；
  Web 侧由 pi-web-ui 弹窗填，存进 IndexedDB。
- 模型：默认取 deepseek provider 目录里的第一个（当前是 `deepseek-v4-flash`），`-m` / `?model=` 可换。
- 换 provider：CLI `-P anthropic|openai`；Web `?provider=xxx`。

## 用法

### CLI

```bash
npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY

npm start                   # 交互式 REPL
npm start -- -p "今天几号？" # 一次性提问后退出
npm start -- --demo         # 不打网络：用 pi-ai 自带的 faux provider 跑完整条环
```

REPL 里：`/tools` 看工具，`/history` 看消息链，`/state` 看整棵状态树（Redux 的那个 state），
`/reset` 清空对话，`/exit` 退出，Ctrl-C 中断当前回合。

选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、`--api-key`、`--demo`。

### Web（pi-web-ui）

```bash
npm run web                                  # http://localhost:5273
open http://localhost:5273/?demo=1          # 离线 demo（faux provider，不用 key）
open 'http://localhost:5273/?provider=deepseek&model=deepseek-v4-flash'
```

界面就是 `agent-interface`（pi-web-ui 的聊天组件）：消息流、流式渲染、工具卡片、模型/思考级别
选择器、附件、API key 弹窗、IndexedDB 会话存储，都是 pi-web-ui 自带的。我们只加了顶栏
（轮数 / 消息数 / 花费）、主题切换和「新对话」。

> `read_file` 工具在浏览器里不可用（要读真实文件系统），`main.ts` 里过滤掉了。

### 加工具

`src/tools.ts` 里加一个对象即可，CLI 和 Web 都会用：

```ts
const myTool: AgentTool = {
  name: 'read_file', label: '读文件', description: '…',
  parameters: Type.Object({ path: Type.String() }),
  execute: async (id, params, signal) => ({ content: [{ type: 'text', text: '…' }], details: null }),
};
```

## 测试

```bash
npm test          # 6 个离线测试：环闭合、轮数上限、错误路径、reducer 纯性、
                  # faux provider 端到端、Web 桥（Agent 事件 → 状态树）
npm run typecheck # tsc --noEmit（src + test）+ tsc --noEmit -p web
```

## 目录

```
src/
  actions.ts   所有 Action（Elm 里的 Msg）
  state.ts     单一状态树
  reducer.ts   transitions 表（纯函数）+ 接线（action type → Cmd[]）
  effects.ts   两张 effect 表：pi-ai 版（CLI）/ agent-driven 版（Web）
  store.ts     createStore + redux-loop 的 install()，以及 waitForIdle
  tools.ts     内置工具（now / calc / read_file）
  provider.ts  Pi(pi-ai) 装配：createModels + deepseekProvider + streamSimple
  cli.ts       REPL / 一次性模式 / 增量渲染
web/
  src/main.ts  pi-web-ui 装配：Agent + 状态树 + 顶栏
  src/bridge.ts Agent 事件 → Redux action
test/          离线测试（faux provider，不打网络）
```

## 边界

- 工具在本地直接执行（`read_file` 读真实文件），没有沙箱；只当自己机器上的小助手用。
- `--demo` / `?demo=1` 走 pi-ai 自带的 faux provider，只为演示与自检，不会真的调模型。
- Web 侧的会话持久化用了 pi-web-ui 的 `SessionsStore`，但本项目没接它的 session 列表 UI
  （顶栏的「新对话」是清空，不落盘）；要接的话看 `web/src/main.ts` 里的 `sessions` store。
