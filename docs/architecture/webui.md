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
| `src/attachments.ts` | `@ela/webui` | 附件的两个投影：发送（`extractAttachments`）/ 展示（`withUserAttachments`） |
| `src/api.ts` | `@ela/webui` | `/api/*` 的客户端 |
| `src/command-palette.ts` | `@ela/webui` | 输入 `/` 时的命令补全下拉 |
| `src/commands.ts` | `@ela/webui` | `/` 命令在浏览器侧的执行（弹面板 / 调接口） |
| `src/context-panels.ts` | `@ela/webui` | 顶栏那三个入口：完整历史 / 系统 / 工具 |
| `src/modal.ts` | `@ela/webui` | 通用模态框（列表 / 纯文本） |
| `src/model-picker.ts` | `@ela/webui` | 模型选择器（**接管**了 pi-web-ui 自带那个，见下） |
| `src/stats.ts` | `@ela/webui` | composer 下面那一行：左端工作目录、右端统计（两段都由服务端算好） |
| `src/sidebar.ts` | `@ela/webui` | 左侧边栏：历史会话（按 cwd 分组）+ 新建 / 搜索 + 底栏三个入口 |
| `src/format.ts` | `@ela/webui` | 界面上的纯格式化（相对时间、路径末段） |
| `src/main.ts` | `@ela/webui` | 外壳（侧边栏 + 主区）、挂 `ChatPanel`、铺 `AppStorage`、连 `/ws` |

数据流（一次提问）：

```
浏览器输入框 → RemoteAgent.prompt → WS {type:'prompt'} → bridge
  → store.dispatch('user.message') → 环（真实 LLM + 工具）
  → store 变化 → bridge.snapshot() → WS {type:'state'} + {type:'event'}
  → RemoteAgent 写进自己的 state / 转成事件 → pi-web-ui 重画
```

## 桥的映射

会话身份（`sessionId` / `cwd`）**不在桥的构造参数里** —— 它从 `state.session` 读，
与 TUI 同一个地方。早先是桥自己接一个 `getSessionId` 回调、`cwd` 用启动目录的常量，
于是「两端共享一个 store」在会话身份上并不成立（症状：浏览器点了新会话，另一边还是
老 id）。见 [kernel](kernel.md) 的「会话身份住在状态里」。

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
| `GET /api/commands` | `/` 补全下拉念的命令表（内置的标了 `web` 的 + prompt 模板 + 扩展注册的 + skill） |
| `GET /api/models` | 目录 + 作用域 + 当前模型 |
| `GET /api/sessions` | 侧边栏那份会话列表（每个 cwd 的历史会话，**不含**已归档的；另带 `archivedCount`） |
| `GET /api/sessions/archived` | 归档那一栏的明细（带 `archivedAt`，按归档时刻倒序） |
| `GET /api/skills` | 进了 prompt 的 skill 清单 |
| `GET /api/thinking` | 当前档位 + 这个模型支持的档位 + 默认档 |
| `GET /api/settings` | 自动压缩 / 隐藏思考块 / 默认思考级别 |
| `GET /api/system-prompt` | 模型实际收到的系统提示词（`text` + `sections`） |
| `GET /api/tools` | 模型看到的工具定义（`name` / `description` / `parameters`） |
| `GET /api/history[?sessionId=<id>]` | 完整会话记录 —— **一整页 HTML**（其余接口都是 JSON）；带 `sessionId` 就开那一个会话（按 id 跨目录找文件，找不到回 404） |
| `POST /api/model` | `{arg}` → 精确命中就换（内核的 `setModel()`） |
| `POST /api/thinking` | `{level}` |
| `POST /api/settings` | `{autoCompact?, hideThinking?, defaultThinkingLevel?}` |
| `POST /api/scoped-models` | `{ids}`（`null` = 全开） |
| `POST /api/command` | `{name, arg}` → 跑一条**扩展**命令 |
| `POST /api/sessions/archive` | `{ids, archived}` → 归档 / 恢复一批会话（`archived: false` 是恢复） |
| `POST /api/sessions/delete` | `{ids}` → 真删会话文件 + 轨迹文件（当前会话拒绝；环在跑时拒绝） |

读写与 TUI 的 `/model`、`/thinking`、`/settings`、`/scoped-models` 面板落在**同一批函数**
（内核的 `setModel()` / `settings.json` 的读写），所以两边不会不一致。

## `/` 命令（浏览器侧）

命令补全与执行在 `command-palette.ts` + `commands.ts`：

- 输入框以 `/` 开头时弹出下拉（命令表来自 `GET /api/commands`，**与 TUI 的补全同一份**）；
  `↑↓` 选 · `Tab` / `Enter` 补全 · 已是完整命令名时 `Enter` 直接执行。
- 执行时不发给模型（`RemoteAgent.prompt` 里拦下，见 `onPrompt`）—— 与 TUI 的 `runCommand`
  同一个分工：命令是「跟界面说」的通道，消息才是「跟模型说」。**例外是未命中的 `/xxx`**：
  不报错、不拦，当普通消息发出去（与 pi、终端一致）。
- `/model` 弹已有的模型选择器；`/thinking` `/settings` `/scoped-models` 弹通用模态框；
  `/skills` 是纯文本弹窗；扩展命令走 `POST /api/command`。
- **`/help` 没有**（与 pi 一致：它的入口是补全 —— 打 `/` 就把整张表摆出来）。
- `/skill:<名字> [问题]` **不是命令**（与 TUI 一致）：它要把 SKILL.md 展开成 `<skill>` 块
  发给模型，而文件在磁盘上 —— 所以浏览器**不拦**，当普通消息发出去，
  `bridge` 收到后用 `@ela/core/skills` 的 `expandSkillCommand()` 展开（与 TUI 同一个函数）。
  名字没命中时原样发送（pi 的 `_expandSkillCommand()` 也是认不出就原样返回）。
- prompt 模板（`[Prompts]` 那批，`source: 'prompt'`）同理：下拉里列出来（与 TUI 同序：
  内置 → 模板 → 扩展 → skill），选中后当普通消息发出去，`bridge` 用
  `@ela/core/prompts` 的 `expandPromptTemplate()` 展开；`commands.ts` 只负责认出它们
  并放行，不把它们当命令执行。

**只做非会话类**：`/new` `/resume` `/compact` `/session` `/name` `/copy` `/quit` 服务端**不下发**
（命令表里没标 `web: true`），所以下拉里看不到它们；直接在浏览器里打这些名字也不会
报错 —— 它们同样走「未命中 → 当普通消息」那条路（那几件要么动会话本身、要么是终端
的事，界面还在终端那边）。

## 扩展对话框（`ctx.ui.select` / `confirm` / `input`）与问卷

- **一次一问的对话框**由 core 的 `raceDialog` 把两份并起来：终端那一份是 pi 自己的
  `ExtensionSelectorComponent` / `ExtensionInputComponent`（挂进与 `custom()` 同一个
  输入区槽位），浏览器那一份走 WebSocket（`ui-request` / `ui-response` / `ui-cancel`）
  —— **谁先回答谁算数**，另一端立刻撤掉。
- **问卷**（`ask_user_question`，多题那种）另走一条：它现在本项目的**内置扩展**（带
  patch，见 [extensions](extensions.md) 那一节）。**终端那份由扩展自己的组件画**
  （多题 tab / 预览 / 备注 / 折叠都是它的），**浏览器这份由我们画**：
  扩展把题目交给宿主（`ctx.ui.externalQuestionnaire`），宿主开一个弹窗
  （`webui/questionnaire.ts`），两边同时开着、谁先答都算数。帧走
  `ui-questionnaire` / `ui-questionnaire-intent`：服务端持那份状态
  （[questionnaire.ts](../../packages/core/src/questionnaire.ts) 的 `QuestionnaireSession`），
  浏览器只把点击/按键变成**意图**发回去 —— 「现在停在第几题」「哪几题留空」都由服务端拍。
- 浏览器后连（刷新页面 / 新标签页）时，还没答的请求与**当前那份问卷快照**会补发
  给这个连接 —— 否则界面里什么都看不到，而服务端还卡在那里等答案。
- 留空也能提交（信封里列成 `unanswered:`）、每题有备注、提交页有整份备注 —— 与扩展
  自己那份 TUI 对齐。**备注是实时同步过去的**（浏览器那份失焦就发一条 `note` 意图，
  宿主转给扩展的 `setHostNote`）：终端面板上看得见同一条，而且万一是终端提交的，
  备注照样跟着答案回给模型。反向（终端 → 浏览器）没有通道 —— 终端那份备注在扩展
  自己组件的内部状态里，宿主读不到。
- **分页语义也与终端一致**：答完一题自动进下一页（最后一题答完落到提交页），
  问题页上只有「上一页 / 下一页」，**提交只在最后一页**（那页底栏才是「提交」）。
  这条跟上游的 `computeAutoAdvanceTab` 同规则 —— 早先我们这边"不自动跳提交页"，
  那是为了躲键盘重复引起的误提交；重复已经在两个渲染器里都滤掉了，所以改回来。

## 附件（图片 / 文档）

pi-web-ui 的 composer 本来就带那个回形针（`ChatPanel.setAgent()` 把 `enableAttachments`
打开），差的只是两段：`session.prompt()` 的入参到我们这里只剩文字，服务端历史里的
content 块界面也不会画。两头都补上之后是这么走的：

- **发送**：`RemoteAgent.prompt()` 用 `extractAttachments()`（`src/attachments.ts`）把
  `user-with-attachments` 里的附件挑出来，随 `{type:'prompt', text, attachments}` 发出去；
  桥用 `promptContent()`（`web/bridge.ts`）折成 `user.message` 的 content 块 ——
  图片是「`[Image: 文件名]` 文本块 + `image` 块」，文档是「`[Document: 文件名]` + 正文」
  的文本块。消息于是仍是标准的 pi user 消息（`content` 是 `TextContent | ImageContent[]`），
  TUI、会话文件、模型看到的是同一份。中间还有一道校形门 `parseClientMessage()`
  （`web-protocol.ts`）：它只抄认识的字段，附件必须在那里被显式带上 —— 漏了的话浏览器
  发的 `attachments` 在这一步就消失，桥后面写得再对也收不到（e2e 踩过：模型回
  「没有附带任何图片」）。
- **文档只带正文**：`WebAttachment` 里文档的 `content` 是空串。原文件 base64 对模型没用，
  传一遍再写进会话文件只会把轨迹撑大。（图片相反：模型真的要看图，base64 必须带，
  它就是 `ImageContent.data`。）
- **界面展示**：服务端历史里是 pi 的 content 块，`RemoteAgentState.apply()` 在装进
  `state.messages` 之前先用 `withUserAttachments()` 还原成 `user-with-attachments` ——
  `content` 只留人打的那句话，`attachments` 交给 pi-web-ui 的 `UserMessage` 画缩略图 /
  文件格子，点开是它自带的 `AttachmentOverlay`（图片大图、文档正文）。
- **文件名藏在文本块里**：`ImageContent` 只有 `data` / `mimeType`，没有名字；而名字要
  跨刷新、跨历史恢复活下来。所以桥在图片前插一条 `[Image: 名字]`，展示层消费掉它。
  只有「下一块真的是图片」时才认这个标签 —— 用户自己打的这行字不会被吃掉。
  文档块只认桥那种带两个前导换行的形状（`\n\n[Document: …]`）。
- **只发附件**：`text` 允许是空串（只发附件），轨迹 / 排队那一行用文件名顶上
  （`（附件：a.png、b.pdf）`）。
- **用不了的附件会说一句**：空文件 / 单张图片超过 20MB / 图片合计约 45MB /
  文档抽不出正文 / 超过 10 份，服务端丢掉并回一条 warn。`usablePromptAttachments()`
  是信任边界，类型 / MIME / 大小 / 正文逐项再验一遍（浏览器那道 `MessageEditor` 的限制
  只是体验，不是安全边界）。合计上限还有一条很实际的理由：`ws` 默认 `maxPayload` 是
  100MiB，10 × 20MB 的图片不封顶会直接把连接撑断。
- **带附件时不拦斜杠命令**：`/model` 那些只认纯文字。带附件时那句话是给模型的 ——
  命令拦下就等于把 pi-web-ui 已经清掉的附件白丢了。
- 协议 **v5**：`prompt` 多了 `attachments`。旧前端不认识这个字段，带附件的消息会静默
  丢附件，所以版本号跟着走（与问卷那次同一个理由）。

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
- **工具结果里的图片直接画出来**（`read` 读图）。pi 的 `read` 遇到图片返回
  `[{type:'text', text:'Read image file [image/png]'}, {type:'image', data, mimeType}]`，
  于是那份 base64 **本来就在消息里** —— 不必再回服务端取一次。`tool-view.ts` 把它们拼成
  `<img>` 缩略图（封顶 180px；一张截图铺满对话列会把上下文冲走），点开是盖一层的原图
  （`openImageOverlay()`；不走 `window.open`，因为 `data:` 顶层导航会被浏览器拦掉）。

## 侧边栏：历史会话（按 cwd）+ 恢复

Pi Web 那种左侧栏：**每个 cwd 的历史会话**列一列，点一条就恢复它；底栏三个入口
（模型 / 技能 / 设置）。它与顶栏那三个入口不是一类东西：那些是**只读快照**，这个要
**改会话本身**（换 id、换文件），所以恢复必须走内核。

```
GET  /api/sessions                    → WebSessionRef[]（id / cwd / title / 时间 / 条数）
   ↑ 服务端用 @ela/core 的 listSessions() 扫 sessions/，标题 = 名字 → 第一句话 → id
WS   {type:'resumeSession', id, cwd}  → bridge → 内核的 restoreSession(file)
   ↑ 只传 id + cwd：路径由 main.ts 用 findSessionFile() 拼（浏览器不知道也不需要知道磁盘布局）
```

几条口径：

- **分组在浏览器**（`sidebar.ts` 的 `groupSessions()`）。服务端只给一份平列表 ——
  「哪几个 cwd 算同一组」（大小写、尾分隔符）那条归一化只该有一份，它在服务端的
  `normalizeCwd()` 里；浏览器按拿到的 `cwd` 字符串归堆就够。
- **子会话（子代理）不列**：`parentSession` 有值的那些属于某个父会话，单独列出来只会把
  列表塞满。（顺带修了 `listSessions()` 一个漏字段：`parentSession` 从 header 读到了却
  没放进返回值，见 `config-home.ts`。）
- **标题不单独读文件**：取 `SessionSummary.firstMessage`（`listSessions()` 那一遍读头部
  512KB 找 `session_info` 时顺手带出来的）。早先这里自己按 **64KB** 扫一遍找第一句话 ——
  那是个错假设：pi v3 的 head（system prompt 分段 + 工具表）本身就 ~64KB，用户的第一句话
  紧跟其后，于是**新会话全都扫不到**，侧边栏那一行显示成一串 uuid（老会话 head 小才碰巧
  有标题）。读整个文件（`sessionTitle`）同样不可接受：一个 18MB 的目录就是 18MB 的解析。
- **环在跑时整列与「新建」一起锁上**：换会话会把正在写的那个文件丢掉，所以那段时间
  每行都 `aria-disabled`（点了给一句提示，不静默）。服务端还有第二道闸 —— `bridge`
  收到 `resumeSession` / `newSession` 时判 `phase !== 'idle'` 并回一条警示
  （TUI 的 `/resume` `/new` 也是同一条规矩）。
- **恢复不换工作目录**：`cwd` 是内核启动时定的（reducer 的 `conversation.reset` 带
  `state.session.cwd` 过去，见 [kernel](kernel.md)）。所以跨目录恢复时**工具仍在原来的
  目录里跑** —— 这件事由服务端在提示里说清楚（「它的目录是 X；工具仍在 Y 里跑」），
  不说的话用户会以为「点了 beta 的会话就是在 beta 里干活」。
- 列表在**连上、一轮跑完、恢复之后**刷新（`main.ts` 的 `onStatus` / `onStateApplied`）。
  不做轮询：`listSessions()` 要读每个会话的头部与尾部，没有理由每几秒来一次。

### 行上的悬停动作：归档与删除

照 Pi Web 的侧边栏（`docs/architecture` 里其它几处也是这么对齐的）：

- **项目名加粗、右边不再挂条数**。那是节标题，不是一行数据；条数在悬停提示
  （`title`）里还在，列表上省掉这一格。
- **项目行悬停出两个**：`+`（在这个项目里新建会话）与垃圾桶（删掉这个项目的全部会话，
  会先问一句「删 X 个会话」）。`+` 只有**当前项目**能真做 —— 内核的 cwd 是启动时定的
  （见上一节「恢复不换工作目录」），别的项目点了给一句「请在 <cwd> 里启动 ela」，
  不假装成功。服务端那两条写操作在环跑着时都拒绝（与其它写操作同一口径）。
- **会话行悬停出两个**：归档与删除；悬停时右端那格时间让位给它们（两者都靠右，会叠）。
  行的 DOM 因此从「整行一个 `button`」变成 `div` 里一个 `button` + 两个图标 `button`
  —— 按钮里不能套按钮，而这两个图标必须长在行里。图标用 `opacity` 收起而不是
  `display: none`：后者会把它们从 Tab 序列里摘掉，键盘 / 屏幕阅读器就永远按不到。
- **归档 = 服务端记一个时刻**，会话文件不动。状态在
  `<家目录>/ela-webui-sidebar-state.json`（`@ela/core/sidebar-state`）：
  `GET /api/sessions` 过滤掉归档的并带一份 `archivedCount`，底部「已归档 · N」切到那一栏
  （`GET /api/sessions/archived`），行末变成恢复 / 删除。为什么不写进会话 `.jsonl`：
  那是「这次对话发生过的事」，归档是「我现在不想看见它」，而删会话时那份标记本来就该
  跟着没（`POST /api/sessions/delete` 会顺手清掉）。
- **删除是真删文件**（会话 + 轨迹，复用 `cleanSessions()`），所以先弹一次确认：
  `modal.ts` 的 `message` 说明 + 两行「取消 / 删除」，默认高亮落在**取消**上。
  删当前会话会被服务端拒绝 —— 记录器还拿着那个文件，下一次说话会写进一个已删掉的文件里。

## 外壳（会话 id 不显示，cwd 在输入框左下）

- 顶栏只剩：侧边栏开关、那三个入口、连接状态。**会话 id 不显示** ——
  它是内部身份，人认的是标题（侧边栏那一列）。早先它是 `id · cwd` 一行；
  品牌 `ela` 也搬进了侧边栏顶栏（照 Pi Web：一行 36px 的格子条 —— 左边品牌，
  右边「＋新建」与搜索两个格子，中间一条竖线分隔），侧边栏收起时品牌随之不见。
- 两栏的顶栏是**同一条线**：高度都由 `.ela-layout` 上的 `--ela-header-height`
  （36px）定，底边是同一种 `--border` —— 各写一个数就会差几像素。
- 顶栏那些入口也是**同一种格子**（`.ela-top-btn`）：图标 + 文字、格子之间一条竖线、
  顶上一条 2px 的线（打开时变强调色）。侧边栏开关是一个 36px 的方格子。
- **工作目录那一行在 composer 下面那一行的左端**（`stats.ts`）：`~/proj (main)` ——
  家目录缩 `~`、括号里是 git 分支。它与右端的统计**同一行**（终端底栏同形状）。
  这一行由服务端算（`WebAgentState.cwdText`，桥的 `cwdLabel` 回调走 TUI 的
  `cwdLine()` + `gitBranch()`）：`~` 要服务端的家目录才缩得对，分支要读 `.git/HEAD`；
  与 `statsText` 同一个理由 —— 两端各算一份迟早会漂。
- **cwd 搬到输入框左下**（`main.ts` 的 `installComposerCwd()`）：插进 pi-web-ui 的
  `message-editor` 那一行左端（附件 / 思考级别旁边），显示目录名、全路径在 `title` 里。
  插进去的是一个只读 `span`，lit 重画那一行时可能被抹掉，所以**每一帧状态**上补一次
  （状态帧本来就每秒都有，代价是一次 `querySelector`）。
- **开场那条「已装扩展：…」不再进浏览器**（`main.ts` 不再把它放进桥的 notices）。
  扩展清单是终端那边的开场信息（`[Extensions]`），在 web 里一条盖一条只占地方；
  装载**诊断**（加载失败）照旧发 —— 那是要人看见的。

## 顶栏那三个入口（完整历史 / 系统 / 工具）

照 Pi Web（github.com/agegr/pi-web）顶栏那三个按钮搬的。它们回答的是同一个问题：
**模型这一轮到底收到了什么**。

| 入口 | 给什么 | 数据从哪来 |
| --- | --- | --- |
| **完整历史** | 整段会话记录（含被压缩掉的早期消息），新标签页打开 | `GET /api/history?sessionId=<当前会话>`（读会话文件，服务端渲染成一页） |
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

**请求头部（system prompt + 工具表）单独画一张卡**：会话文件第一条 `message` 就是 pi v3 的
head（`sections` = 各段正文、`toolsAdded` = 装载时那批工具的完整声明），早先它落到 `default`
分支只读 `content`（head 的 content 通常是空串），页面上只剩一个空壳 —— 而那正是「模型到底
收到了什么提示词、拿到了哪些工具」的唯一证据。现在每段、每个工具各一个 `<details>`（折叠着
也看得见段名 / 工具名，也就搜得到），头部那张卡的副标题写着「系统提示词 N 段 · 工具 M 个」。
内存兜底那条路（还没落盘）也要补一条同样的 head：`state.prompt` 那份用 `buildPromptHead()` 造，
与 `effects.ts` 发给模型的是同一个造法 —— 内存里的 `messages` 本来就不含 head。

**图片同样是 `<img>`**，不是 `[图片]` 占位：`read` 读图的结果、用户发的图片附件，都是会话
文件里现成的 base64（`imageBlocks()`）。缩略图封顶 60vh，点一下用**另一层**（`.shot-overlay`）
看大图 —— 原来那张不动：把它改成 `position: fixed` 会从文档流里抽走，卡片上留个空洞、
后面的内容整体上移，看着像「点一下把图删了」。那一层里是另一个 `<img>`，`src` 取
`currentSrc`（同一份 data URL，不再嵌一遍 base64），Esc / 点任意处关；开着时锁住底下滚动，
打印时整层隐藏。

**`?sessionId=`：有个 id 就能打开那一段。** 不带参数是当前会话；带上就按 id 跨 `sessions/`
下每个 `--<cwd>--` 目录找文件（`config-home` 的 `findSessionFileById()`）—— 于是不必先知道它
当初在哪个 cwd 里，也顺手治了另一件事：`resume` 别的项目的会话时内核 cwd 不变，按
`(id, cwd)` 拼出来的路径是空的，页面上会误报「还没落盘」。找不到就 404，页面写「找不到这个
会话」，与「还没落盘」分开（后者是当前的会话还没写过文件）。顶栏那个按钮也带上了
`sessionId`：这一页在导航之后才加载，中间换了会话就不该跟着变。

### 为什么是「新标签页 + 顶栏下内联面板」

- **完整历史是一页文档**：要能 Ctrl-F、能打印、能和聊天区并排看 —— 所以新标签页，
  与 Pi Web 的 `export?inline=1` 同一个形状。
- **系统 / 工具要边看边对着聊天记录**（提示词里写了什么、模型刚才为什么那么干），
  模态框一盖就看不见对话了。所以与 Pi Web 同形：顶栏下面**浮**出一层
  （绝对定位在顶栏正下方，高度封顶 `min(600px, 75dvh)`、自己滚），再点收起，
  点另一个直接换内容，**点面板外面也收起**。
  它是 `.ela-panel-host` 的绝对定位层，所以展开与收起**不改变对话区与 composer 的
  布局**（内联展开会把它们顶下去 —— 读一句话就要重新找位置）。空的时候宿主是
  `hidden`：不占位、也不吃指针事件。

面板的样式用 pi-web-ui 的**语义变量**（`--border` / `--secondary` / `--muted-foreground` /
`--background` / `--foreground`）—— 它们在 `.dark` 下会被重定义，所以深色模式自动跟着变。
（早先那种 `--color-*` 写法里只有 `--color-border` 真的存在，其余靠 fallback 顶着。）

## 启动与端口

`ela --web` 起 web server（**默认不起** —— 那是一个监听端口的服务，不开就不该占端口）：

- 只绑 `127.0.0.1`（`web/server.ts` 的默认值），默认端口 `30141`；被占就往后试 10 个，
  真地址写在界面提示行里（终端那边也报一行）。
- `--web-port <n>` 换端口，**给了它就隐含 `--web`**（说要一个端口就是要那个服务）。
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
- **前端那些「浏览器里跑」的工具不参与**：artifacts 面板、JS REPL 是 pi-web-ui
  自带的能力，它们假设 agent 在浏览器里。工具在服务端跑，所以这些面板不会真的有事可做
  （`ChatPanel` 仍会渲染它们，只是没有插件往里喂数据）。**附件是例外**：它已经接上了
  线协议（见上面的「附件」一节），图片 / 文档照样能发、能显示。
- **`pnpm-workspace.yaml` 关掉了 `blockExoticSubdeps`**：pi-web-ui 的 `xlsx` 依赖走 URL
  （`cdn.sheetjs.com`），pnpm 11 默认拦这种「exotic 子依赖」，而它没有 allowlist 粒度。
  这是本项目唯一一处放宽供应链策略，写在那个文件里。