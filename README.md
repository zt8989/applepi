# event-loop-agent

用 **Redux Loop** 做 **Agent Loop**，用 **Pi**（`@earendil-works/pi-ai`，与 DeepSeek Harness 同一套
provider 装配）驱动模型，外加一个简易 CLI。

一句话：**没有 while 循环的 agent** —— 循环不是写出来的，是 reducer 与副作用互相 dispatch 出来的环。

## 环长什么样

```
                        dispatch(Action)
   CLI / REPL ────────────────────────────► agentReducer（纯函数）
        ▲                                        │
        │                                        │ 返回 S 或 loop(S, Cmd)
        │  store.subscribe(state, action)        ▼
        │                              redux-loop 的 install() enhancer
        │                                        │  执行 Cmd.run
        │                                        ▼
        └──────────── Action 回流 ◄────── LLM 流式调用 / 工具执行
                     （Cmd.dispatch）
```

reducer 里没有一个 `await`、没有一个 `fetch`：它只做两件事 —— 算下一个状态、把副作用
描述成 `Cmd` 丢出去。真正干活的 `Cmd.run` 把结果（包括 token 增量）作为 action 再 dispatch 回来。

### 环上每一步

| 进来的 Action | 新状态 | 产生什么 Cmd |
| --- | --- | --- |
| `prompt` | 追加 user 消息，相位 → `thinking` | `Cmd.run(callLlm)` |
| `llm/delta` / `llm/thinking` | 累积流式文本 | 无（渲染用） |
| `llm/done`（有 toolCall） | 追加 assistant 消息，相位 → `calling-tools` | `Cmd.run(executeToolCalls)` |
| `llm/done`（无 toolCall） | 相位 → `idle`，**环在这里闭合** | 无 |
| `tool/start` | 记下正在执行的工具 | 无 |
| `tool/result` | `toolResult` 消息并入 messages | 无 |
| `tools/done` | 相位 → `thinking` | `Cmd.run(callLlm)` ← 回到 LLM |
| `llm/failed` | 记错误，相位 → `idle` | 无 |

`prompt → LLM → 工具 → LLM → … → idle` 就是 agent 循环；它由数据（Action）驱动，
因此每一步都能在测试里断言，不需要 mock 一个 while 循环。

## Provider：Pi（和 DeepSeek Harness 一样）

`src/provider.ts` 与 `my-pi-desktop/src/main/agent/runtime.ts` 是同一套路：

```ts
const models = createModels();
models.setProvider(deepseekProvider());          // pi-ai 自带 providers/deepseek
const model = models.getModel('deepseek', id);   // 模型目录来自 provider
models.streamSimple(model, context, options);    // 流式调用，事件是 AssistantMessageEvent
```

- 鉴权：`DEEPSEEK_API_KEY`（provider 自带的 `envApiKeyAuth`），或 `--api-key` 直接给；
- 模型：默认取 deepseek provider 目录里的第一个（当前是 `deepseek-v4-flash`），`-m` 可换；
- 换别的 provider：`-P anthropic` / `-P openai`（各自读 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）。

我们**不用** `pi-agent-core` 的 `Agent` —— 那一层正是被 Redux Loop 取代的东西：
本仓库的 `src/effects.ts` 自己实现「调模型 / 跑工具」这两个副作用。

## 用法

```bash
npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY

npm start                   # 交互式 REPL
npm start -- -p "今天几号？" # 一次性提问后退出
npm start -- --demo         # 不打网络：用 pi-ai 自带的 faux provider 跑完整条环
```

REPL 里：`/tools` 看工具，`/history` 看消息链，`/state` 看整棵状态树（Redux 的那个 state），
`/reset` 清空对话，`/exit` 退出，Ctrl-C 中断当前回合。

CLI 选项：`-p/--print`、`-P/--provider`、`-m/--model`、`-s/--system`、`--max-turns`、`--api-key`、`--demo`。

内置工具（`src/tools.ts`）：`now`、`calc`、`read_file`。加工具只写一个对象：

```ts
const myTool: AgentTool = {
  name: 'read_file', label: '读文件', description: '…',
  parameters: Type.Object({ path: Type.String() }),
  execute: async (id, params, signal) => ({ content: [{ type: 'text', text: '…' }], details: null }),
};
```

## 测试

```bash
npm test          # 离线：假 streamFn + pi-ai 自带 faux provider，跑完 prompt→LLM→工具→LLM→idle
npm run typecheck
```

## 目录

```
src/redux-loop 相关
  actions.ts   所有 Action（Elm 里的 Msg）
  state.ts     单一状态树
  reducer.ts   agentReducer：纯函数，返回 S 或 loop(S, Cmd)
  effects.ts   Cmd.run 的两个副作用：callLlm（流式）、executeToolCalls
  store.ts     createStore + redux-loop 的 install()，以及 waitForIdle
  tools.ts     内置工具
  provider.ts  Pi(pi-ai) 装配：createModels + deepseekProvider + streamSimple
  cli.ts       REPL / 一次性模式 / 增量渲染
```

## 边界

- 工具在本地直接执行（`read_file` 读的是真实文件），没有沙箱；只当自己机器上的小助手用。
- `--demo` 走 faux provider，只为演示/自检，不会真的调模型。
