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
| `web-protocol.ts` | `@ela/core` | **线协议**：状态与事件的形状（前后端唯一共同语言） |
| `web/bridge.ts` | `@ela/tui` | 内核 → 线协议：订阅 store、映射状态、派发提问/中止/换模型 |
| `web/server.ts` | `@ela/tui` | HTTP 静态资源 + `/ws`（WebSocket） |
| `src/remote-agent.ts` | `@ela/webui` | 线协议 → pi-web-ui：`Agent` 形状的替身 |
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

## 模型列表（与 TUI 一致）

浏览器里那个模型选择器**不是 pi-web-ui 自带的**。

它自带那个列的是「它打包进去那一代 pi-ai 的内置目录」（1500+ 条，含大量本机根本没配的
provider），而内核能真发出去的只有 `ModelRuntime.getAvailableSnapshot()` 那些 —— 正好
是 TUI 的 `/model` 面板列的那一份。两边不一致的症状是：在浏览器里挑一个本机没有的模型，
发出去报错，而原因只在服务端日志里。

所以：

- **服务端**在 `hello` 里带上目录（`WebModelRef[]`，紧凑投影：provider / id / name / reasoning）
  与作用域（`settings.json` 的 `enabledModels`，`null` = 全开）。目录的取法与 TUI
  **逐字相同**：`modelRuntimeFor(runtime).getAvailableSnapshot()`（`main.ts` 用 `modelRefs(...)`
  投影；后者只是把整份 `Model` 削成四条字段 —— 整份 436 条约 250KB，没必要）。
- **浏览器**走 pi-web-ui 留的口子接管：`ChatPanel.setAgent({ onModelSelect })`。设了它，
  `AgentInterface` 就**不弹**自己那个（`components/AgentInterface.js` 里那个分支），
  改弹 `model-picker.ts`。

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
- 后台刷新目录（`ModelRuntime.refresh()`，会打网络）—— 所以列表是**启动那一刻**的快照；
- `/scoped-models`（改作用域的界面）—— 浏览器里只能看，要改去 TUI。

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