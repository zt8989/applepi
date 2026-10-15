# 浏览器界面（webui）

TUI 之外的第二块界面：**浏览器里的 pi-web-ui**，环仍然是终端进程里的那一份。

## 一句话

浏览器只做两件事 —— **渲染服务端推来的状态**、**把话发回服务端**。它不碰模型、
不跑工具、拿不到密钥。

## 为什么不在浏览器里跑 agent

`@earendil-works/pi-web-ui` 官方 example 是**前后端一体**的：浏览器里 new 一个
`pi-agent-core` 的 `Agent`，直连 provider，状态存 IndexedDB。本项目不能那么做，两个原因：

1. **铁律「环只有一份」**（见 [overview](overview.md)）。再来一份 agent 就有两处发
   LLM 调用、两套消息历史、文件可能被写两次 —— 终端与浏览器会看到互不相干的两条对话。
2. **工具与密钥在服务端**。内置工具摸的是真实文件系统（`--cwd` 是边界），API key 在
   `~/.pi/agent/auth.json`。把它们搬到浏览器既做不到，也不该做。

所以我们只取 pi-web-ui 的**渲染层**（`ChatPanel` / `AgentInterface`），把它的
`session` 换成一个「长得像 `Agent`、实现是网线」的替身。

## 三个部件

| 部件 | 在哪 | 干什么 |
| --- | --- | --- |
| `web-protocol.ts` | `@ela/core` | **线协议 + HTTP 接口的形状**（前后端唯一共同语言） |
| `web/bridge.ts` | `@ela/tui` | 内核 → 线协议：订阅 store、映射状态、派发提问/中止/换模型 |
| `web/api.ts` | `@ela/tui` | **非会话数据的 HTTP 接口**（`/api/*`：命令表、模型目录、settings…） |
| `web/history.ts` | `@ela/tui` | 「完整历史」那一页的服务端渲染（`GET /api/history`） |
| `web/server.ts` | `@ela/tui` | HTTP 静态资源 + `/api/*` + `/ws`（WebSocket） |
| `src/remote-agent.ts` | `@ela/webui` | 线协议 → pi-web-ui：`Agent` 形状的替身 |
| `src/api.ts` | `@ela/webui` | `/api/*` 的客户端 |
| `src/command-palette.ts` | `@ela/webui` | 输入 `/` 时的命令补全下拉 |
| `src/commands.ts` | `@ela/webui` | `/` 命令在浏览器侧的执行（弹面板 / 调接口） |
| `src/context-panels.ts` | `@ela/webui` | 顶栏那三个入口：完整历史 / 系统 / 工具 |
| `src/modal.ts` | `@ela/webui` | 通用模态框（列表 / 纯文本） |
| `src/model-picker.ts` | `@ela/webui` | 模型选择器（**接管**了 pi-web-ui 自带那个，见下） |
| `src/main.ts` | `@ela/webui` | 挂 `ChatPanel`、铺 `AppStorage`、连 `/ws` |

数据流（一次提问）：

```
浏览器输入框 → RemoteAgent.prompt → WS {type:'prompt'} → bridge
  → store.dispatch('user.message') → 环（真实 LLM + 工具）
  → store 变化 → bridge.snapshot() → WS {type:'state'} + {type:'event'}
  → RemoteAgent 写进自己的 state / 转成事件 → pi-web-ui 重画
```

## 桥的映射

pi-web-ui 只有两个落点（见它 `components/AgentInterface.js`）：

- **稳定列表** `session.state.messages` —— 每条消息渲染一次；
- **流式容器** `session.subscribe` 的 `message_update` —— 当前这条还没落进列表的。

内核的 `streamingText` / `thinkingText` 是流式期的中间态（**不进 `messages`**），
恰好对上「部分助手消息」。所以 `bridge.ts` 每次 store 变化就：

1. 组一份**整份状态**（`sessionId` / `messages` / `model` / `thinkingLevel` /
   `isStreaming` / `streamingMessage` / `pendingToolCalls` / `errorMessage`）发出去；
2. 补**事件**：`agent_start` + `turn_start`（开跑）、`message_update`（流式文本变了才发）、
   `message_end` + `agent_end`（收工）。

**顺序是先状态后事件**：`message_update` 的处理里要读 `state.isStreaming`，
状态后到就会读到上一帧。

`message_update` 只在**内容真的变了**才发（`JSON.stringify(content)` 做 key）——
每个 store 变化都推一帧会把浏览器刷成幻灯片。

工具卡不需要单独的事件：`AgentInterface` 用 `state.messages`（助手消息里的 `toolCall` 块
+ `toolResult` 消息）渲染工具块，用 `pendingToolCalls` 标「跑着」。所以桥不发
`tool_execution_*`。

## 提示也在聊天流里（错误 / 配置切换 / 压缩）

`state.messages` 不是 `state.messages` 原样转出去的 —— 它是**从轨迹派生**的（见
[stream](stream.md)）：真消息原样，而错误 / 配置切换 / 压缩这些提示变成一条**合成消息**
（`role = 'ela-notice'`）插在正确的消息之间。

浏览器侧用 pi-web-ui 留的口子注册一个 renderer：

```ts
registerMessageRenderer('ela-notice', { render: (msg) => html`…` });
```

`MessageList` 对每个消息先试 `renderMessage(role)` —— 命中就渲染它。不注册的话
那个 role 会被当成未知消息直接跳过（症状：切换模型 / 报错，浏览器里什么都不多）。

合成消息**只活在线协议上**：内核的 `messages` 一个字节不动，更不会发给模型
（`renderStats` 只看 `role === 'assistant'`，也不受影响）。

这修掉了一个旧症状：`errorMessage` 虽然一直在 `WebAgentState` 里，但 pi-web-ui 的
`AgentInterface` **根本不读它** —— 所以 LLM 调用失败在浏览器里根本看不到。

## 模型列表（与 TUI 一致）

浏览器里那个模型选择器**不是 pi-web-ui 自带的**。

它自带那个列的是「它打包进去那一代 pi-ai 的内置目录」（1500+ 条，含大量本机根本没配的
provider），而内核能真发出去的只有 `ModelRuntime.getAvailableSnapshot()` 那些 —— 正好
是 TUI 的 `/model` 面板列的那一份。两边不一致的症状是：在浏览器里挑一个本机没有的模型，
发出去报错，而原因只在服务端日志里。

所以：

- **服务端**用 `GET /api/models` 给目录（`WebModelRef[]`，紧凑投影：provider / id / name /
  reasoning）与作用域（`settings.json` 的 `enabledModels`，`null` = 全开）、以及当前模型。
  目录的取法与 TUI **逐字相同**：`modelRuntimeFor(runtime).getAvailableSnapshot()`
  （`main.ts` 用 `modelRefs(...)` 投影；后者只是把整份 `Model` 削成四条字段 ——
  整份 436 条约 250KB，没必要）。**不再随 `hello` 来**（v3 起）：那是按需数据，
  塞进握手就等于前端抄了一份快照。
- **浏览器**走 pi-web-ui 留的口子接管：`ChatPanel.setAgent({ onModelSelect })`。设了它，
  `AgentInterface` 就**不弹**自己那个（`components/AgentInterface.js` 里那个分支），
  改弹 `model-picker.ts`（目录现取 `/api/models`）。

与 TUI 对齐的行为：有作用域时**默认只看作用域内**（TUI 那边是
`scope = scopedModels.length > 0 ? "scoped" : "all"`）、`Tab` 切 all/scoped、当前模型置顶打勾、
搜索按 id / 名字 / provider。

作用域条目按 `provider/id` 比对，可以带思考级别后缀（`provider/id:high`）。这里有个坑：
**模型 id 自身就可能带冒号**（`cn:deepseek-v4.1-flash`），所以只有**最后**一段是合法档位时
才当后缀切（与 CLI 的 `-m provider/id:high` 同一个判据）。这条有单测
（`packages/webui/test/pure.test.ts`）。

选择器是**纯 DOM**：那一小块没有响应式状态要维护，而 Lit 的装饰器要给本项目再配一套编译
开关。pi-web-ui 自己的组件照旧是 Lit，互不影响。

刻意**没做**的（都属 pi 那套 settings / catalog 的入口）：

- `Ctrl+S` 存默认（写 `settings.json` 的 `defaultModel`）；
- 后台刷新目录（`ModelRuntime.refresh()`，会打网络）—— 所以列表是**取的那一刻**的快照。

作用域现在能改了：`/scoped-models` 命令给一个勾选列表（`module.ts` 的通用模态框），
勾一下即写 `settings.json`（见下）。

## 前端那几个「不得不」的地方

`RemoteAgent` 是个替身，但它必须糊住 pi-web-ui 的几个假设：

- **`streamFn` 给一个自己的函数，`getApiKey` 给个占位**。`AgentInterface` 会拿
  `session.streamFn === streamSimple` 判断「要不要给浏览器装 CORS 代理」，并顺手
  覆盖 `getApiKey` —— 我们不想让它动这两样（请求根本不到浏览器）。
- **`onApiKeyRequired` 返回 `true`**。发送前那道闸是
  `getAppStorage().providerKeys.get(provider)` —— 浏览器里没有密钥（也不该有），
  不返回 true 就永远发不出去。它只是放行，不代表浏览器拿到了 key。
- **必须 `setAppStorage()`**。`getAppStorage()` 没初始化会抛，而 `AgentInterface`
  的发送路径**一定会读它**。所以 `main.ts` 铺了一份 IndexedDB 后端的 `AppStorage`
  —— 我们不用它的会话存储（会话在服务端），但得让它存在。

还有一个 pi-web-ui 没给的东西：**状态变了它不会自己重画**（它只在事件上 `requestUpdate`）。
所以 `main.ts` 在每次收到 `state` 之后手动调一次 `chatPanel.agentInterface?.requestUpdate()`。

## 非会话数据走 HTTP 接口（`/api/*`）

会话本身（消息、流式文本、工具状态）仍然走 WebSocket —— 那一份必须**推送**，因为它在
秒级变化。而「模型目录 / 命令表 / 作用域 / settings / 键位」是**按需数据**：塞进
`hello` / `state` 的结果是前端抄一份服务端的事实，改了 TUI 那边浏览器还拿着旧的。

所以它们改成了 HTTP：

| 接口 | 回什么 |
| --- | --- |
| `GET /api/commands` | `/` 补全下拉念的命令表（内置的标了 `web` 的 + 扩展注册的） |
| `GET /api/models` | 目录 + 作用域 + 当前模型 |
| `GET /api/skills` | 进了 prompt 的 skill 清单 |
| `GET /api/thinking` | 当前档位 + 这个模型支持的档位 + 默认档 |
| `GET /api/settings` | 自动压缩 / 隐藏思考块 / 默认思考级别 |
| `GET /api/system-prompt` | 模型实际收到的系统提示词（`text` + `sections`） |
| `GET /api/tools` | 模型看到的工具定义（`name` / `description` / `parameters`） |
| `GET /api/history` | 完整会话记录 —— **一整页 HTML**（其余接口都是 JSON） |
| `POST /api/model` | `{arg}` → 精确命中就换（内核的 `setModel()`） |
| `POST /api/thinking` | `{level}` |
| `POST /api/settings` | `{autoCompact?, hideThinking?, defaultThinkingLevel?}` |
| `POST /api/scoped-models` | `{ids}`（`null` = 全开） |
| `POST /api/command` | `{name, arg}` → 跑一条**扩展**命令 |

读写与 TUI 的 `/model`、`/thinking`、`/settings`、`/scoped-models` 面板落在**同一批函数**
（内核的 `setModel()` / `settings.json` 的读写），所以两边不会不一致。

## `/` 命令（浏览器侧）

命令补全与执行在 `command-palette.ts` + `commands.ts`：

- 输入框以 `/` 开头时弹出下拉（命令表来自 `GET /api/commands`，**与 TUI 的补全同一份**）；
  `↑↓` 选 · `Tab` / `Enter` 补全 · 已是完整命令名时 `Enter` 直接执行。
- 执行时不发给模型（`RemoteAgent.prompt` 里拦下，见 `onPrompt`）—— 与 TUI 的 `runCommand`
  同一个分工：命令是「跟界面说」的通道，消息才是「跟模型说」。
- `/model` 弹已有的模型选择器；`/thinking` `/settings` `/scoped-models` 弹通用模态框；
  `/skills` `/help` 是纯文本弹窗；扩展命令走 `POST /api/command`。
- `/skill:<名字> [问题]` **不是命令**（与 TUI 一致）：它要把 SKILL.md 展开成 `<skill>` 块
  发给模型，而文件在磁盘上 —— 所以浏览器**不拦**，当普通消息发出去，
  `bridge` 收到后用 `@ela/core/skills` 的 `expandSkillCommand()` 展开（与 TUI 同一个函数）。

**只做非会话类**：`/new` `/sessions` `/resume` `/clean` `/compact` 服务端**不下发**
（命令表里没标 `web: true`），所以浏览器里打它们会得到「浏览器里只支持非会话类命令」——
那几件要动会话本身（换文件、删历史、整份换 messages），它们的界面还在终端那边。

## 扩展对话框（`ctx.ui.select` / `confirm` / `input`）

`ask_user_question` 这类扩展按 `ctx.mode` 选路：`'tui'` 走它自己那个全屏问卷
（`ctx.ui.custom()` 的组件），`'rpc'` 走 `ctx.ui.select/input` 的逐题回退。本项目两路都有，
而且**同一份问卷在终端与浏览器里同时弹，谁先回答谁算数**：

- **浏览器连上时**把扩展宿主模式切成 `'rpc'`（`extension-host.ts` 的 `setUiMode`，
  连接进来/全断开时由 bridge 的 `onPresenceChange` 驱动），全断开时切回 `'tui'`。
- `ctx.ui.select/confirm/input` 由 core 的 `raceDialog` 把两份并起来：
  终端那一份是 pi 自己的 `ExtensionSelectorComponent` / `ExtensionInputComponent`，
  挂进与 `custom()` 同一个输入区槽位；浏览器那一份走 WebSocket
  （`ui-request` / `ui-response` / `ui-cancel`）。
- 先回答的那一端赢，另一端立刻撤掉（终端组件卸下 / `.ela-modal` 弹窗收到 `ui-cancel` 关掉）。
- 浏览器后连（刷新页面 / 新标签页）时，还没答的请求会**补发**给这个连接 —— 否则界面里
  什么都看不到，而服务端还卡在那里等答案。

代价：浏览器连着时终端也走逐题回退（没有多题 tab / 预览 / 备注 —— 那是
`runRpcQuestionnaire` 固有的）。这是「两端都能答」的必然取舍。

## 底栏统计行（与 TUI 逐字同形）

终端底栏那一行是 `↑362k ↓310k R121M CH99.9% 52%/1.0M`（`statsLine()`）。pi-web-ui 自带
的 `formatUsage()` 只到 `↑ ↓ R W $cost` —— 没有 `CH`（缓存命中率）与上下文占用。

所以这一行**由服务端算好发过去**（`WebAgentState.statsText` / `statsLevel`，桥通过
`stats` 回调拿 `statsLine()` 的返回值），浏览器只负责画：`stats.ts` 把 pi-web-ui 的
`renderStats()` 换成我们的整行（预先算好的字串 + 告警色）。

为什么不让浏览器自己算：`CH` 与上下文占用两段的口径都是「**最近一次**有效调用」，
而那个「有效」的过滤条件（token>0 / 不是 aborted / 不是 error）与服务端那份必须一致 ——
两边各算一份的结果是「同一个会话，终端与浏览器底栏对不上」。

顺带两处「数字」的口径：

- **不逐条显示用量**。pi-web-ui 的 `assistant-message` 会给每条带 `usage` 的助手消息
  渲染一行 `↑186 ↓1.2k R164k`（它自己的 `formatUsage()`），而底栏那一行是服务端按
  `statsLine()` 算的整行 —— 两个口径同时挂着只会让人对不上账。所以 `remote-agent.ts`
  在收到快照时把助手消息的 `usage` 抹掉（ `stripAssistantUsage()`；服务端照发，线协议不动）。
- **工具耗时不在浏览器里计**。工具在服务端跑，浏览器只看到「开始 / 结束」两条消息，
  相减得到的是传输延迟（恢复历史时更是连起点都没有）。所以用内核的
  `state.toolTimings`（见 [tools](tools.md)），经线协议发过去（`WebAgentState.toolTimings`），
  `tool-view.ts` 按 `toolCallId` 查；文案格式照 Pi Web 的 `formatToolDuration`（`1.2s`）。
  工具跑着的时候表里还没这一条，那一格就留给转圈的状态图标。

## 顶栏那三个入口（完整历史 / 系统 / 工具）

照 Pi Web（github.com/agegr/pi-web）顶栏那三个按钮搬的。它们回答的是同一个问题：
**模型这一轮到底收到了什么**。

| 入口 | 给什么 | 数据从哪来 |
| --- | --- | --- |
| **完整历史** | 整段会话记录（含被压缩掉的早期消息），新标签页打开 | `GET /api/history`（读会话文件，服务端渲染成一页） |
| **系统** | 模型实际收到的 system prompt | `GET /api/system-prompt`（`state.prompt.systemPrompt`） |
| **工具** | 模型看到的工具定义：描述 + 参数（JSON Schema） | `GET /api/tools`（`state.prompt.tools`） |

三者都在**打开的那一刻**取（`context-panels.ts` 调 `/api/*`），不缓存。缓存一份的坏处很具体：
TUI 那边换了模型 / 改了工具开关，浏览器里还显示着旧的那份 —— 而这两个面板的整个意义就是
「**现在**这一轮发出去的是什么」。

「工具」拿的是 `state.prompt.tools` 而**不是**重算一遍 `declaredToolset()`：前者是请求里那份声明
（`prepareLoadout` 重写过的描述已经在里面），重算会给出「现在」的工具集，而面板要回答的是
「这一轮模型看到了什么」。

### 为什么「完整历史」读会话文件，而不是内存里的 `messages`

内存里那份是**压缩之后**的当前上下文：被 `/compact` 掉的早期消息在那里根本不存在，
而那一段正是「完整历史」要给人看的。所以服务端用 `findSessionFile(sessionId, cwd)` 读会话文件
（与终端、与 `pi` 是**同一份**），只认三种 entry（`message` / `model_change` /
`thinking_level_change`）；文件还没落盘（新会话一句话都没说过）时才退回内存，页面上会写明
「来源：还没落盘」。

渲染在 `web/history.ts`，全部 `escapeHtml` —— 会话内容里 `<script>` 也好、`&` 也好，
一个字符都不能漏出去。

### 为什么是「新标签页 + 顶栏下内联面板」

- **完整历史是一页文档**：要能 Ctrl-F、能打印、能和聊天区并排看 —— 所以新标签页，
  与 Pi Web 的 `export?inline=1` 同一个形状。
- **系统 / 工具要边看边对着聊天记录**（提示词里写了什么、模型刚才为什么那么干），
  模态框一盖就看不见对话了。所以与 Pi Web 同形：顶栏下面摊开一块（高度封顶
  `min(600px, 75dvh)`、自己滚），再点收起，点另一个直接换内容。

面板的样式用 pi-web-ui 的**语义变量**（`--border` / `--secondary` / `--muted-foreground` /
`--background` / `--foreground`）—— 它们在 `.dark` 下会被重定义，所以深色模式自动跟着变。
（早先那种 `--color-*` 写法里只有 `--color-border` 真的存在，其余靠 fallback 顶着。）

## 启动与端口

`ela` **默认随终端一起起** web server：

- 只绑 `127.0.0.1`（`web/server.ts` 的默认值），默认端口 `30141`；被占就往后试 10 个，
  真地址写在界面提示行里（终端那边也报一行）。
- `--web-port <n>` 换端口，`--no-web` 关掉。
- 终端界面退出时 server 一并关掉 —— 否则监听端口会让进程退不下来。

## 构建

前端要走一次 Vite：

```bash
pnpm build          # = pnpm --filter @ela/webui build
```

产物在 `packages/webui/dist/`（**不在版本库里**，`dist/` 被 gitignore）。
没构建也能起：`/` 会给一页说明（「先跑 pnpm build」），终端界面不受影响。

## 边界与已知取舍

- **没有认证，也不要挂到局域网上。** 这个端点能驱动一个能跑任意命令的 agent
  （工具没有沙箱，见 [architecture](../architecture.md) 的「边界与已知不对齐」）。
  要远程访问请自己套一层带认证的反向代理。
- **前后端各带一代 pi**：pi-web-ui `0.75.3` 依赖 `pi-ai@^0.75.3`，而内核用 `pi-ai@^1.0`。
  两者**只交换 JSON**（协议里的 `Message` / `Model` 形状两代一致），所以不冲突。
  模型列表不走它那一代（见下面的「模型列表」）。
- **前端那些「浏览器里跑」的工具不参与**：artifacts 面板、附件、JS REPL 是
  pi-web-ui 自带的能力，它们假设 agent 在浏览器里。工具在服务端跑，所以这些面板
  不会真的有事可做（`ChatPanel` 仍会渲染它们，只是没有插件往里喂数据）。
- **`pnpm-workspace.yaml` 关掉了 `blockExoticSubdeps`**：pi-web-ui 的 `xlsx` 依赖走 URL
  （`cdn.sheetjs.com`），pnpm 11 默认拦这种「exotic 子依赖」，而它没有 allowlist 粒度。
  这是本项目唯一一处放宽供应链策略，写在那个文件里。