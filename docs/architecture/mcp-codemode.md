# MCP 与 codemode

这一篇讲两件一起接进来的事：**MCP 服务器**（外面的工具进得来）与 **codemode**（模型写
一段 JS 把这些工具与内置工具一起调）。

两件是同一个决定的产物：MCP 的默认暴露方式就是「不进模型的工具表、只给 codemode 脚本调」。
只接其中一件都会得到一半的东西 —— 接了 MCP 而不接 codemode，服务器工具没有任何一条路
到模型跟前；接了 codemode 而没有 MCP，脚本只能调本地那几个工具。

## 复用官方内置扩展，不重写

pi 那边这两个都是**内置扩展**（`createMcpExtension()` / `createCodemodeExtension()`），
本项目原样装载它们（`extension-host.ts` 的 `loadExtensionFiles`/`builtinFactories`），
不移植任何一行实现：

| 官方件 | 干什么 |
| --- | --- |
| `createMcpExtension()` | 读 `mcp.json`、连服务器、mcp 工具命名（`mcp__<服务器>__<工具>`）、OAuth、资源工具、`/mcp` 面板 |
| `createCodemodeExtension()` | `codemode` 工具定义、QuickJS 沙箱、`tools` / `ALL_TOOLS` / `searchTools()` / `models` |

重写一遍等于把 MCP 客户端与那个沙箱重做一次，而且会漂移。本项目只提供**自己那一半**：
环、store、工具注册表，以及官方扩展要的 ctx 成员。

### `tool_search`：**装了**

pi 的内置扩展一共四个（还有 `llama.cpp`）。本项目装三个：`mcp` / `codemode` /
**`tool-search`**（不装 `llama.cpp` —— 那是本地模型跑的，见 `provider.md`）。

> 另外还有一个**本项目自己的**内置扩展：`ask_user_question`（`@juicesharp/rpiv-ask-user-question`
> 的 pinned 依赖 + `patches/`，终端归它画、浏览器归我们画）—— 见
> [extensions](extensions.md) 的「ask_user_question：内置扩展 + patch」一节。

`tool_search` 干的事就一件：BM25 搜 `codemode` / `deferred` 暴露的工具，命中的走
`setActiveTools()` 装载成 declared，下一轮模型就能直接调。

早先本项目**刻意不装**它，理由是「它要中途改工具声明，与本项目『工具集装载时定死』
冲突」。那条不变式换成「**中途可变，但变了要声明**」之后（见
[extensions](extensions.md#一工具集中途可变但变了要声明)），它依赖的三样东西本项目都有：

| 它要的 | 本项目给的 |
| --- | --- |
| `pi.getAllTools()` 的 `exposure` / `namespace` | 真的读注册表（`registeredToolInfos()`） |
| `pi.getActiveTools()` | 当前**声明**（`state.prompt.tools`） |
| `pi.setActiveTools()` | 真的改（`tools.changed` → `agent.run` 的声明增量） |

注册是 `defaultActive: false`（pi 也一样）：要用得在 `settings.json` 的 `defaultTools` 里
写 `+tool_search`。测试里钉住了整条路（`packages/core/test/mcp-codemode.test.ts` 的
「`+tool_search` 能把 deferred 工具搜出来」）。

于是 `deferred` 归入 codemode（官方文档原话：codemode 或 deferred 的工具都能从两种
间接机制到达，脚本本来就能调它）—— 脚本用 `searchTools()` / `ALL_TOOLS` /
`describeNamespace()` 找它，只是它不进 codemode 的描述清单。

## exposure：五种取值

同名概念在 pi 那边叫 `ToolExposure`。本项目的注册表（`tools.ts`）**保留**它，不再是
「全都 declared」：

| exposure | 声明给模型 | 能从脚本调 | 谁给 |
| --- | --- | --- | --- |
| `direct` | 开（激活时） | 开 | 内置工具、普通扩展工具、MCP 配了 `direct` 的 |
| `model-only` | 开 | **否** | codemode 自己（脚本不能再起脚本） |
| `codemode` | 否（除非显式激活） | 开 | MCP 工具的配置默认值 |
| `deferred` | 否 | 开 | `tool_search` 装载（搜到才声明）；搜不到就从 codemode 脚本调 |
| `hidden` | 否 | 否 | 服务器已撤下的工具 |

两个容易踩的点：

- **`direct` 也要激活才可调**（与 pi 的 `_getCallableTools` 一致）。`defaultTools` 关掉的
  内置工具，脚本里也调不到 —— 那是对的，否则「关掉 grep」只关了模型那一半。
- **MCP 扩展会把配置里的 `codemode` 注册成 `deferred`**（官方 `toToolExposure()` 的映射）。
  两者对模型都是「不声明」；差别看 `tool_search` —— 现在本项目装了它，所以这层差异
  **看得见**：模型能把它们搜出来装进声明。`mcp_servers` 段里写的仍是配置的那个词。

## 声明集：装载时算一次，之后随 `setActiveTools()` 更新

`state.prompt.tools`（= 当前声明）装载时由 `prompt.init` 装进去，之后每次
`setActiveTools()`（`tools.changed`）重算一份 —— 而「变了」这件事由 `agent.run`
在请求前 diff 成 `toolsAdded` / `toolsRemoved` 声明给模型（见
[extensions](extensions.md#一工具集中途可变但变了要声明)）。每次重算都走
`declaredToolset()`（`tools.ts`）：

```
激活集 ∩ 注册表（去 hidden） → 跑一遍 prepareLoadout 钩子 → 声明
```

`prepareLoadout` 是 codemode 用来「把自己的描述换成此刻能调哪些工具」的钩子（官方机制）。
两个模式都支持：

- `codemode.mode: "on"`（默认）：已声明的直调工具**不重复列**在 codemode 描述里，而是给
  它们各自的描述**追加**一句「从脚本怎么调」；
- `"only"`：直调工具从声明里藏掉（`hiddenDeclarations`），只列在 codemode 描述里。

装载完就 **`freezeActiveTools()`**：之后的 `setActiveTools()` 一律拒绝，只记**一条**诊断。
理由与扩展工具集同一条（见 [extensions](extensions.md)）：中途换声明会让已发出的消息与
prompt 对不上，而 prompt-cache 的前缀整个作废。

### 激活怎么发生

`codemode` 注册时是**不激活**的（`defaultActive: false`），两条路把它打开：

1. **配置**：`settings.json` 的 `defaultTools` 里写 `+codemode`（`+` 是「在默认那四个上
   再加一个」，不是替换）；
2. **MCP 自动**：`mcp.json` 里有 `codemode`（或 `deferred`）暴露的服务器时，MCP 扩展
   在 `session_start` 里自己激活它。`mcp.json` 顶层的 `"autoEnableCodemode": false` 可以关掉。

两条都必须发生在 `prompt.init` **之前** —— 所以内核的顺序是：

```
loadExtensionHost()       装扩展、绑 core、扫一遍工具
startSession()            发 session_start：MCP 读 mcp.json、连服务器、激活 codemode
collectPromptSections()   只跑**内置**扩展的 before_agent_start：等 direct 服务器（≤10s）、收 mcp_servers 段
declaredToolset() + prompt.init + freezeActiveTools()
```

## 我们自己补的几个接缝

官方扩展要的东西，本项目原来一个都没有：

| 官方扩展要什么 | 本项目给什么 | 在哪 |
| --- | --- | --- |
| `session_start` / `session_shutdown` | 内核在装载前后各发一次 | `extension-host.ts` 的 `startSession()` / `dispose()` |
| `ctx.executeTool()` / `ctx.tools` | 走本项目的可调表（`callableTools()`），**失败回 `isError` 不抛** | `extension-host.ts` 的 `executeTool` |
| `pi.registerTool()` 的**动态**注册 | `refreshTools` 真的重扫 runner 的注册表（MCP 服务器连上后走这里） | `extension-host.ts` 的 `syncExtensionTools()` |
| `pi.getAllTools()` 的 exposure / namespace | 真的读注册表 | `tools.ts` 的 `registeredToolInfos()` |
| `pi.getSettings()` | 真的读 `~/.pi/agent/settings.json` | `pi-config.ts` 的 `loadPiSettings()` |
| `systemPromptOptions.sections` | 装载时收集一次拼进 prompt；之后每轮 `before_agent_start` 写回的段**按段 patch**（变了才追加一条消息） | `system-prompt.ts` 的 `sections` / `extension-prompt.ts` |
| `tool_call` 事件 | 环在每次工具执行前发（顶层 + 脚本的嵌套调用） | `effects.ts` 的 `onToolCall` / `extension-host.ts` 的 `beforeToolCall` |

### 为什么 `tool_call` 那一条不能省

MCP 的 `tool_call` handler 做一件很具体的事：**codemode 脚本点名了一个还没连上的服务器时，
在那里等它**。少了这个事件，脚本第一句 `await tools.mcp__foo__bar(...)` 会报「未知工具」——
而服务器其实一两秒后就绪。`beforeToolCall` 的返回里还带着 `block` / 改写后的 `input`，
权限类扩展以后可以从这里接。

嵌套调用（脚本里 `tools.<name>()`）走 `ctx.executeTool`，那个也发同一个事件、带
`parentToolCallId`（官方契约），嵌套 id 是 `<父 id>/<n>`。

### 工具表的那一层

`tools.ts` 现在是三张视图，别混：

| 视图 | 是什么 | 谁读 |
| --- | --- | --- |
| `getTools()` | 内置（按 `defaultTools` 开着的）+ 全部扩展工具（去 hidden） | 注册表视图、初始 state、`getTool()` |
| `declaredToolset()` | 激活集 ∩ 注册表，跑过 `prepareLoadout` | `prompt.init`（发给模型的那份） |
| `callableTools()` | `codemode` / `deferred` + 激活的 `direct` | `ctx.executeTool`、codemode 的 `tools` |

## 配置

与 pi **同一份文件、同一套规则**：

```
~/.pi/agent/mcp.json       用户级（带凭证的、个人的放这儿）
<cwd>/.pi/mcp.json         项目级（项目要求的才放这儿；同名覆盖用户级）
```

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "internal-tools": { "exposure": "direct", "command": "uvx", "args": ["tools-mcp"] }
  },
  "autoEnableCodemode": true
}
```

- 不写 `exposure` = `codemode`（模型看不见，脚本调得到）；
- 想让它直接出现在模型工具表里就写 `"exposure": "direct"`；
- `toolExposure` 可以按工具名（或 `*` 通配）单独覆盖。

本项目**不做项目信任判断**（与 `SYSTEM.md` 同一个取舍，见 [init](init.md#一处与-pi-的差异项目信任)），
所以 `<cwd>/.pi/mcp.json` 一律生效 —— 与同目录的 `AGENTS.md` 风险相同，后者本来就无条件读。

`/mcp` 命令来自内置扩展，可用来查看连接状态、登录 OAuth、重连、改暴露方式、启用/禁用。
（它用 `ctx.ui.custom()` 画面板，本项目那一条接了；`ctx.ui.select` / `input` 那条路没接，
非 TUI 模式下的 OAuth 登录会明说不支持。）

## 已知边界

- **装载后连上的 `direct` 服务器，工具不会被补进模型的工具表。** pi 会在下一个请求里补，
  本项目不会（声明只在 `setActiveTools()` 之后更新，而它不会为了等一个服务器去重算）。
  装载时 `direct` 服务器**等 10 秒**（官方那个上限），等到的就在；
  之后连上的仍能从脚本调（`refreshTools` 会进可调表）—— 只是模型不知道它存在，
  要 `/new` 换会话才进工具表。慢服务器建议配成 `codemode`（脚本里会等）。
- **`/new` 不重发 `session_start`**，所以 MCP 服务器不会重读 `mcp.json`、也不会重连。
  改了 `mcp.json` 要重启（与改 `settings.json` 的 `defaultTools` 同一条）。
- **`deferred` 要靠 `tool_search` 装载**：它默认不进声明（模型看不见），两条路到它 ——
  模型调 `tool_search` 搜出来，或 codemode 脚本直接调。
- **MCP 工具不进权限确认**：本项目还没有权限扩展那一层，`tool_call` 的 `block` 已经把口子
  留好了（`beforeToolCall` 的返回值），但还没有谁用它。

## 退出时怎么收子进程

MCP 的 stdio 服务器是**子进程**，握着事件循环。一次性模式（`-p`）跑完那一刻如果还有
一个**连到一半**的（`npx -y rea-agents` 还在解析 / 下载 / 握手），进程会被它**卡死**
（实测卡到 600s 超时）—— 优雅的 `session_shutdown` 收不掉它：那一刻它的 client 还没挂到
connection 上，`close()` 是空转。

收尾因此分两层：

1. `ExtensionHost.dispose()` / `Kernel.dispose()` **可等待**，退出路径上 `await` 它们 ——
   让已经连上的服务器走完 `session_shutdown` 的正常关闭。给 5s 上限：某个服务器赖着
   不走时不再等，免得把退出反过来挂死。
2. `main.ts` 末尾等 stdout 排空后**显式 `process.exit()`**。官方 stdio 传输自己装了
   `process.on('exit')` 钩子：进程退出时把还活着的服务器**进程组**一并杀掉。上面那个
   连到一半的就靠这一层收。

交互模式不走这条 —— `runTui` 挂在 `await new Promise(() => {})` 上，退出走 `app.ts` 的
`process.exit(0)`，同样会触发那个钩子。

回归测试：`packages/tui/test/mcp-exit.test.ts`（真的拉起 `main.ts -p` + 一个握手永不返回的
fixture，断言进程自己退出、子进程被收掉）。

## 代码在哪

| 文件 | 干什么 |
| --- | --- |
| `packages/core/src/tools.ts` | 注册表：exposure、激活集、`declaredToolset`、`callableTools`、`prepareLoadout` |
| `packages/core/src/extension-host.ts` | 装内置扩展；`session_start`、`executeTool`、`refreshTools`、`beforeToolCall`、`collectPromptSections` |
| `packages/core/src/extension-tools.ts` | 工具适配（带上 `outputSchema`）、`activeToolsFromState` / `applyActiveTools` |
| `packages/core/src/effects.ts` / `packages/core/src/store.ts` | 环在每次工具执行前发 `tool_call` 的钩子 |
| `packages/core/src/system-prompt.ts` | `sections`（`mcp_servers` 段进 prompt） |
| `packages/core/src/extension-prompt.ts` | `before_agent_start` 事件的 `systemPromptOptions.sections` |
| `packages/core/src/kernel.ts` | 装载顺序：`startSession` → `collectPromptSections` → 声明 → 冻结 |

测试：`packages/core/test/mcp-codemode.test.ts`。前半是注册表（纯内存），后半**真的**起一个 MCP stdio
服务器（`packages/core/test/fixtures/fake-mcp-server.mjs`，离线）走完整条链路 —— 真的 MCP 客户端、
真的 QuickJS 沙箱，只有服务器那一端是假的。

## 相关

- 扩展宿主与它踩过的坑 → [extensions](extensions.md)
- 工具表怎么来的 → [tools](tools.md)
- 装载顺序与 prompt → [init](init.md)