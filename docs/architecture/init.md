# 装载（prompt / model）与零 token 回放

这一篇讲「内核起来时装了什么」以及「回放时怎么不重跑」。

## 两块，分开装载

`AgentState` 里有两块**会话级**状态，它们是两个独立 action 装进来的：

| 块 | 装它的 action | 装了什么 |
| --- | --- | --- |
| `state.prompt` | `prompt.init` | 基础 system prompt + 工具的**完整定义** + `seeded` |
| `state.model` | `model.init` | provider / model / thinkingLevel / **能力** + `seeded` |

为什么分开：prompt 是「跟模型说什么」，model 是「用哪个模型说」。两者独立变
（换模型不该动 prompt，追加 prompt 片段不该动模型），落盘时也各自独立。

`seeded` 是「装过了没有」。回放时据此判断 init 段读到没有 —— 没读到就只能重新装配。

## 为什么走 action 而不是直接写进 createInitialState

因为「装载」和「跑一轮对话」是**同一类事** —— 都是状态迁移。走 action 才能：

- 被落盘器看见（`createTracePersistence` 是个 store 订阅器，它只认 action 造成的状态变化）
- 被回放
- 在测试里逐字断言

所以 `createKernel()` 建好 store 之后，连着 dispatch 两条 init。

### 扁平别名

`state.systemPrompt` / `providerName` / `modelId` / `thinkingLevel` 仍在 —— 它们是
`prompt` / `model` 里常用字段的**扁平别名**，为了让既有代码（UI、adapter、轨迹渲染）不必到处写
`state.prompt.systemPrompt`。真相在两块里，别处只读，不算独立来源。

每条会改它们的 transition 都要同时更新两边（`prompt.init`、`model.init`、
`model.changed`、`thinking.changed`），漏一处就会出现两份不一致的真相。

## 工具的完整定义进了 state

`prompt.init` 装的是 `PromptToolDefinition[]`：**name / description / parameters 三样**，
不是只装名字。装全的后果：

- `effects.ts` 的 `toolSchemas(state)` 直接从 state 读，不用每次 `getTools()` 现算
  （官方工具在构造时读目录、做边界计算，每次现算不便宜）
- 回放时不必重新装配工具，就知道当时发给模型的是什么

`execute` 不在里面 —— 执行用的工具和发给模型的不是一回事：
`runToolCall` 按名字从注册表取。

`label` 也不在里面（那是我们界面用的中文展示名，不发给模型），
但 `state.toolNames` 有它，因为 UI 要。

## 模型能力

`model.init` 带一个 `ModelCapabilities`，只收三个**真正影响本项目行为**的标志
（pi-ai 的 `Model` 上有几十个 `supports*`，其余对我们没意义）：

```ts
interface ModelCapabilities {
  midConvoSystemMessages: boolean;   // 对话开始后还能插 system/developer
  midConvoToolAdditions: boolean;    // system 消息能否中途引入新工具
  developerRole: boolean;            // 用 developer 而不是 system（OpenAI Responses 一族）
}
```

位置不一样，所以 `readCapabilities()` 分开取：前两个在 `BaseModel` 顶层（pi-ai 的 `Model`
类型没把它们带进公开面，所以按运行时字段读），`developerRole` 在 `compat` 里。

**读不到就当 false。** 保守是对的：「以为支持但实际不支持」会让 pi-ai 把消息发出去然后被
provider 拒；反过来「以为不支持但实际支持」只是少用了个特性。同一个常量
`UNKNOWN_CAPABILITIES` 也用在 `model.changed` 之后 —— 换模型时能力先清成保守值，
等新的 `model.init` 补上。

## 中途插入 system / developer

`prompt.segment.added` 追加一段 prompt，role 是 `system` 或 `developer`。

它落进 **`state.messages`**，不是 `state.prompt`：

- 它是 Conversation 的一部分，所以会被一起落盘、一起回放
- 它是**追加**不是替换 —— `state.prompt.systemPrompt` 不受影响

模型支不支持是**模型**的事（`state.model.capabilities.midConvoSystemMessages`），
我们不自己折：pi-ai 会在模型不支持时把后来的 system 消息折进开头那条
（见 pi-ai 的 `normalizeContext`）。所以 `prompt.segment.added` 的迁移只管把消息放进去。

## thinking（reasoning）

三个概念要分清：

| | 是什么 |
| --- | --- |
| `state.model.thinkingLevel` | **请求参数**（reasoning effort）。`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `ThinkingContent` | **输出**。`{type: 'thinking', thinking: string}` —— 确实是文本 |
| `state.thinkingText` | 本轮流式累积的思考文本（UI 用） |

所以「思考输出是文本」—— 但它**不是 assistant 正文**。它走独立的 `thinking` content 块，
和正文 `text` 块分开，在 `AssistantMessage.content` 里是两种 entry。

它也是**请求参数而不是输出格式**：设了 `high` 不代表模型一定回馈 thinking，
很多模型直接不给。回馈时才走 `thinking_delta` 事件。

`effects.ts` 里读的是 `state.model.thinkingLevel`（不是扁平别名），因为那是 model 块的真相。

## Hooks = 洋葱式 middleware

「Hooks」在本项目里**不是** system prompt 的附属品，而是一层横切所有 action 的拦截器
（`src/middleware.ts`）：

```
dispatch(action)
  → m1 前 ── m2 前 ── [reducer] ── m2 后 ── m1 后
```

`before` 正序（外 → 内，最后一个离 reducer 最近），`after` **逆序**（内 → 外，最外层最后收尾）。

为什么需要两种时机：agent 里有些事必须在**状态变化之前**决定（改写 action、丢弃它），
有些必须在**之后**做（审计、追加 prompt 片段、埋点）。prompt 装载是后者的典型。

`promptSegmentMiddleware` 是唯一的实例：它看到 `user.message` 就在其后 dispatch 一条
`prompt.segment.added`。它不需要知道 prompt 是什么，也不需要改 reducer ——
**reducer 因此完全不需要知道这个扩展点存在。**

### 现在是骨架

类型与洋葱语义都在，但**没有注册表、也没挂进 dispatch 的时机** —— 那要等 store 层接上去。
在那之前 middleware 只能被手动调用（`applyMiddleware`），这也是测试里唯一能证明语义正确的方式。

测试覆盖了四件事：洋葱顺序（`外前 → 中前 → 内前 → 内后 → 中后 → 外后`）、
`before` 返回 `null` 丢弃整条 action、`before` 改写、`after` 追加。

## 落盘：两个文件

装载段和轨迹**分开两个文件**，因为生命周期不同：装载是会话级的（起来时装一次），
轨迹节点是这次对话的产物。混在一起会让「回放一段对话」先跳过一堆无关的装载记录。

| 文件 | 内容 | 记录类型 |
| --- | --- | --- |
| `~/.redux-agent/traces/<id>.init.jsonl` | 装载 | `prompt.init`、`model.init`（各一条） |
| `~/.redux-agent/traces/<id>.jsonl` | 对话 + 轨迹 | `message`、`add`、`close` |

`message` 记录是**零 token 回放**的关键：每条对话消息（user / assistant / toolResult /
中途插的 system 段）都追加一行，回放时按顺序重放就重建出 `messages`。

## 零 token 回放

```ts
const init = await loadInit(sessionId);      // { prompt, model }
const session = await loadSession(sessionId); // { tree, messages }
```

有了这两个：

- 当时发给模型的是什么（prompt + tools 定义）—— 不用重装配工具
- 这个模型支持什么（capabilities）—— 不用再问 provider
- 模型答了什么、工具返回了什么 —— 不用再调一次模型

**一条 token 都不花**，一整轮对话连同轨迹树原样复现。回放跳过的坏行只有一种：
崩溃时截断的半行（`JSON.parse` 失败直接丢）。

`loadTrace()` 保留着（只要树不要消息），给不想重建 messages 的调用方用。

## 相关

- 环怎么转 → [loop](loop.md)
- 轨迹树本身 → [trace](trace.md)
- 内核装配 → [kernel](kernel.md)
