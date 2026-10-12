# 扩展

本项目能装 **pi 扩展**（`settings.json` 的 `packages`），装上来的工具与 prompt 片段
在**装载时**并进内核。

接了两个：

| 包 | 给模型什么 |
| --- | --- |
| `@juicesharp/rpiv-ask-user-question` | 结构化多选对话框（多问题 tab、notes、`preview` 侧栏、折叠） |
| `pi-web-access` | web 搜索 / 抓取 / PDF 提取 / GitHub / 视频理解（5 个工具；答案与摘要要自己调模型） |

```bash
pi install npm:@juicesharp/rpiv-ask-user-question   # 与 pi 共用同一份 settings.json
```

装完就生效（重启即可）。`--no-extensions` 可以完全跳过。

## 为什么不自己重写

那个扩展的对话框有两千多行：多问题 tab、单选/多选、每题 notes、`preview` 侧栏、
`Ctrl+]` 折叠、ESC 放弃。它还带着一堆**踩过才写出来**的处理 —— jiti 的模块缓存中毒后
无法在进程内恢复、overlay 折叠后必须有 raw input 才能复原、notes 草稿被 submit 键静默
吞掉。

重写一遍等于把它重做一次，而且会漂移。所以走 pi 官方的扩展运行时。

## 复用了官方的哪几样

| 官方件 | 干什么 |
| --- | --- |
| `DefaultPackageManager.resolve()` | `settings.json` 的 `packages` → 扩展入口路径 |
| `loadExtensions()` | jiti 装载 |
| `ExtensionRunner` | 事件分发、ctx 构造、工具上下文 |

### `loadExtensions()` 是**必需**的，不是「顺手用了」

扩展源码 `import { type Theme } from "@earendil-works/pi-coding-agent"`、
`import { Editor } from "@earendil-works/pi-tui"`、`import { Type } from "typebox"`。
而 `typebox` 在**本仓库 `node_modules` 里根本不存在**（`require.resolve('typebox')` 抛）——
它是 pi 用 jiti 的 `virtualModules` 注入给扩展的。

所以「把那个包 import 进本项目」这条路本身走不通。实测（`scripts/` 下的探针，已删）：

```
typebox                     => NOT RESOLVABLE
@earendil-works/pi-tui      => .../pi-tui/dist/index.js
@earendil-works/pi-coding-agent => NOT RESOLVABLE
@juicesharp/rpiv-config     => NOT RESOLVABLE
```

走 `loadExtensions()` 时，扩展拿到的 `@earendil-works/pi-tui` 与本项目 import 的是
**同一个模块实例**（`TuiAltScreen === TuiAltScreen` 为 true）—— 所以 `instanceof`
与 `isViewportTUI` 都成立。这一点验过，因为如果两边是两份，`showOverlay` 挂上去的
浮层不会被我们的渲染循环认出来，而症状是「对话框显示了但不动」。

### 为什么用 `DefaultPackageManager` 而不是自己读 `settings.json`

它做的事多得多且都是必须的：用户级与项目级两份 settings 合并、同一个包两处出现时
项目优先（`autoload:false` 时是 delta 而非替换）、项目信任判断、npm 包的安装目录解析。

自己读 `settings.json` 再拼路径，最后必然是「pi 装到哪儿我们不知道」——症状是
`pi list` 明明有，这边说没装。取不到时用 `onMissing: skip`：**不自动 `npm install`**，
本项目不是包管理器，替 pi 装东西会让两边状态分家。

## 我们必须自己给的三样

| 扩展要什么 | 本项目给什么 | 在哪 |
| --- | --- | --- |
| `ctx.ui.custom()` | pi-tui 的 `showOverlay()` | `src/extension-ui.ts` |
| 工具执行 | 自己的 `getTool()` 注册表 | `src/tools.ts` 的 `registerExtraTools` |
| `setActiveTools()` | 一条 reducer action 的位置（**刻意空**） | `src/extension-tools.ts` |

### `ctx.ui.custom()`：焦点是 pi-tui 管的

`showOverlay` 抢焦点、`hide()` 还焦点（它自己记了 `preFocus`）。所以 `custom()` **必须**
在扩展给的 `done()` 里 `handle.hide()` —— 不 hide 的话浮层永远挂在 overlay 栈上、
输入再也回不到编辑器，界面看着「答完了却还能打字」。

没实现的是：`select` / `confirm` / `input`（RPC 宿主那套弹窗协议）、
`setWidget` / `setFooter` / `setHeader`（要接 pi 的应用层布局，见
[surfaces](surfaces.md)「为什么不用 pi 自己的 InteractiveMode」）。

## 三个接缝

`pi-web-access` 比第一个重得多（110 个源文件、209 个依赖、编译成 1MB bundle），
要了第一批**没要过**的东西。

| 它要什么 | 早先的错法 | 症状 |
| --- | --- | --- |
| `getAllTools()` | `[]` | 「模型永远调不了 web_search」，看不出哪里不对 |
| `modelRegistry` | `undefined` | 摘要/答案一触发就 TypeError |
| `ctx.model` | `undefined` | 「当前模型不合格」，而真因是宿主没给 |

### ① `ctx.modelRegistry`（摘要/答案要自己调模型）

`pi-web-access` 的**答案与摘要**要自己调模型（抓完页面要一个模型来读它、搜索结果要一个
模型来总结）。它拿凭证**只认** `ctx.modelRegistry`：

```js
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
if (!auth.ok || !auth.apiKey) throw new Error(`No API key available for ${model.provider}/${model.id}`);
```

那个 ctx 早先是 `undefined`（pi 的 runner 构造器第 4、5 个参数），于是这些功能一被触发就是
`Cannot read properties of undefined (reading 'getApiKeyAndHeaders')`。

**用官方的 `ModelRegistry`，不自己实现。** pi 自己的说明写着它是「给扩展用的同步兼容
门面」，内部就是一层薄薄的方法转发。而我们**已经有**那个 `ModelRuntime`
（`provider.ts` 的主路径，自带 44 个内置 provider 与 1500+ 模型目录，见
[provider](provider.md)）。所以 `extension-models.ts` 全文就是：

```ts
new ModelRegistry(runtime.runtime)
```

凭证优先级、OAuth、`baseUrl` 拼接、headers —— 全是官方那份逻辑。自己写一遍就是一份会漂移的
副本，而漂移的代价是「pi 那边能拿到 key，这边拿不到」。

实测（主路径 + 真配置）：

```
getAll().length                  = 1545
find(workbuddy, cn:space-bunny)  = workbuddy/cn:space-bunny
getApiKeyAndHeaders(当前模型)      = { ok: true, hasKey: true }
```

**`ctx.model` 也给真的**（之前 `undefined`）：扩展用它判**能不能用当前模型自带的 web 搜索**
（OpenAI 的 hosted search 只对 `openai` / `openai-codex` 那些开放），还拿它算 opencode 的
session header。给 `undefined` 的话那些功能一律「当前模型不合格」—— 而用户看不出是自己
模型的问题。

`ctx.scopedModels` 保持 `[]`：扩展的 `isModelInScope` 是 `scopedModels.length === 0 || 匹配`，
也就是 `[]` 的语义是**不限制**，与本项目不接 pi 的 `--models` scoping 一致。
**不是**「一个模型都没有」。

**降级路径上不造它**：`ModelRuntime.create()` 失败时 `provider.ts` 会退回手写装配
（`runtime.runtime` 是 `undefined`）。那时返回 `undefined` 而不是「一个说没有 key 的
registry」—— 后者会让扩展回一句「No API key available for …」，而真因是**降级了**。
前者让它在真用的时候炸在一个说人话的地方。

### ② `pi.getAllTools()`（`web_enable` 的前提）

它有个 `web_enable`（「动态启用 web 工具」的 loader）内部这么写：

```js
const registered = new Set(pi.getAllTools().map((t) => t.name));
const unavailable = names.filter((n) => !registered.has(n));
if (unavailable.length > 0) return { isError: true, content: [{ text: `Cannot enable unavailable tools: ${unavailable.join(", ")}.` }] };
pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
```

`getAllTools()` 早先被填成 `[]`（写的时候只想到「那二十几个成员里我实现了三个，
其余不给」），于是它以为一个 web 工具都没有，回一句
`Cannot enable unavailable tools: web_search, source_check, ...`。

**而那些工具明明就在注册表里。** 症状是「模型永远调不了 web_search」而**看不出**
哪里不对 —— `web_enable` 只是一句「unavailable」，模型会转而去用别的办法或者放弃。

`allToolsInfo()` 现在报真实的 `getTools()`。官方那份 `ToolInfo` 还有
`exposure` / `namespace` / `annotations` / `sourceInfo`：

- `exposure` 给 `direct` —— 那是唯一有意义的（本项目不接 codemode 那套动态暴露）。
- `namespace` / `annotations` 不接：它们是 MCP 与 codemode 的输入。
- `sourceInfo` 给**一个合法形状**（`{ source: 'local' }`）而不是 `undefined` ——
  扩展会在 `getAllTools().find(...)` 之后去读它，给 undefined 会炸在一个假字段上，
  而那个堆栈与真因隔了三层。

### `getActiveTools()` 得读**装上了 prompt 的那张表**

`web_enable` 启用完会回头 `getActiveTools()` 核对一遍（「still inactive」就是这一步）。
我们读的是 `state.prompt.tools` —— 也就是**真正发给模型的那份**（`effects.ts` 的
`toolSchemas()` 原样读它）。早先在探针里读到空数组，于是误报「still inactive」。

这不是巧合而是设计：扩展问「现在有哪些工具」，答案必须是「模型看得见哪些」。

### ③ `ctx.sessionManager`：仍然不接

pi 的会话层是它的**应用层**，本项目刻意不接（见
[surfaces](surfaces.md)「为什么不用 pi 自己的 InteractiveMode」）。

扩展若去读那个 ctx 的成员（`pi-web-access` 用它读会话条目以重建上下文、算
opencode 的 session header），会在那里炸出「cannot read property of undefined」—— 那比
给一个**会静默说谎**的空实现好得多：后者会让扩展以为「会话里什么都没有」而改走另一条
路，症状离真因很远。

## 不接的：命令与快捷键

`pi-web-access` 注册了 4 个命令（`/websearch` `/curator` `/google-account` `/search`）
与 2 个快捷键（`ctrl+shift+s` / `ctrl+shift+w`）。本项目**不接**它们，**而且明说**：

- 命令表是 `tui/app.ts` 里的 `SLASH_COMMANDS`（唯一真相，补全与 `/help` 都念它）。
  接进去就要往那儿塞，而那边只有 `description` + 一个 `runCommand` 里的 switch。
- 命令 handler 在 pi 那边拿的是 `ExtensionCommandContext`（`waitForIdle` /
  `newSession` / `fork` / `navigateTree`…），本项目**一个都没实现**。接了就在 handler
  里炸。
- 更糟的是**假装能用**：补全里冒出 `/websearch`、敲下去什么都不发生 —— 那是
  「静默退化」里最难查的一种。

所以工具接、命令不接。测试里钉住「装它不会往 `SLASH_COMMANDS` 里塞东西」
（`test/extension-host.test.ts` 的「命令与快捷键不接」）。

## `pi-web-access` 的 key 依赖

它的真正硬依赖是 API key（exa / tavily / brave / jina…，十几家）。所以**测试不打网络** ——
只验宿主面（工具装上、参数校验走通、`getAllTools` 真的返回注册表）。

真跑一次（手动，有 key 时）：

```
$ pnpm start
> 搜一下 redux-loop 的最新版本

**Provider:** exa
# redux-loop  Sequence your effects naturally and purely by returning them from
  your reducers. - Version: 6.2.0 - License: MIT - ...
```

**没实现的方法一律 reject，不静默 no-op。** 一个 `select()` 静默 resolve `undefined`
的话，扩展会把「用户没选」当成真的答复发回模型 —— `undefined` 在 pi 的契约里明确表示
「用户取消了」，给假值等于撒谎。

非 overlay 形式的 `custom()` 直接抛错并说明原因：它要顶掉底部输入区，而本项目的输入区
由自己的布局管（`applyLayout`），换掉它要整套布局协议。

## 三个坑

### 一、工具集**不中途变**（于是那条协调器是 no-op）

扩展的 prompt 注入在 pi 那边是每轮现拼，本项目是**装载时**定下（`prompt.init`）。
工具集在会话中途换会让已发出的 `messages` 与 prompt 对不上，而 prompt-cache 的前缀整个
作废。

所以 `applyActiveTools()` 是**空实现** —— 不是忘了做。由此推出一条**已知无效**的路径：
`ask_user_question` 自带的 `before_agent_start` 协调器（非交互时把工具摘掉）在本项目
恒为 no-op，因为本项目只有交互式一种模式、`hasUI` 恒真。

真要改工具集：`/new` 换会话，或改 `settings.json` 后重启。测试里钉住了
（`test/extension-host.test.ts` 的「协调器在本项目是 no-op」）。

### 二、无 UI 时**不绑** `ctx.ui`，而不是绑一个空的

不给 `uiOptions` 时干脆**不调** `setUIContext`，于是官方 `hasUI` 读出 false，扩展自己的
`if (!ctx.hasUI) return rejectWithoutUi()` 先命中，返回一个结构化的 `no_ui`。

绑一个「什么都不做」的 UI **更糟**：那个空 UI 的 `tui` 是 `undefined`，扩展一调
`ctx.ui.custom()` 就会在自己的 `props-adapter.ts` 里炸：

```
TypeError: Cannot read properties of undefined (reading 'requestRender')
    at QuestionnairePropsAdapter.apply (.../view/props-adapter.ts:98:14)
```

那个堆栈里**一帧本项目的代码都没有**，症状与真因隔了三层。**承认没有界面比假装有界面
好得多。**

### 三、`createHostUi` 必须**惰性**读 tui 引用

内核装扩展时界面**还没起来**（`runTui` 里才建 tui）。早先写成
`createHostUi(uiOptions())` —— 当场求值，那一刻 `uiRef.current` 是空的，于是扩展第一次
访问 `ctx.ui` 就炸（同上那个栈）。

改成 `createHostUi(() => uiOptions())`：内核拿到一个当场能用的 UI 壳（`hasUI` 为 true，
与 pi 一致），而内部那些真的要 TUI 的方法在**真的被调**时才读引用 —— 那时界面早好了。

`notify` 例外：它**不用** `live()`，因为扩展的提示在界面起来之前也该能出（而不是把一条
提示变成一个异常）。

## `before_agent_start`：发，但只发一半

发这个事件的两个理由：

1. 工具集 —— 不发它 `ask_user_question` 的协调器**永远不会被调用**；
2. 不违反契约 —— 扩展可能靠这个事件做别的事，不发等于骗它「没这回事」，症状会出现在
   它内部的某个远端调用上，极难归因。

**不采信它的 prompt 改动**（官方那个 `emitBeforeAgentStart` 会用 `systemPromptOptions`
**重建**整份 system prompt，而本项目只存了成品文本、没有那份可重拼的 options）。
所以自己按「这件事只需要 `ctx`」调 handler：第一个扩展的协调器只读 `ctx.hasUI`，
事件本身一个字段都不碰。

两条守卫：

- **环在跑的时候不发** —— 那个事件没有对应的一轮语义。扩展可能据此注入消息，
  在工具调用的那一轮里发它等于告诉它「用户又说话了」，消息就凭空多出来。
- **handler 抛错不炸环** —— 收成诊断（与官方 `runner.onError` 同一个口径）。

## 装载失败不抛，但**看得见**

扩展加载失败（版本不兼容、缺依赖、语法错）不该让应用起不来 —— 用户还是想聊天。
收进 `errors` 交界面，与 skill 的 `skillDiagnostics` 同一口径：静默退化最该让人看见。

开场那一节（`[扩展]` / `[扩展警告]`，与 `[Skills]` 同形）就是它：

```
[扩展]
ask_user_question
```

诊断**刻意显眼**（黄字）：那不是「没装某个可选功能」，而是「你以为装上了」。

还有一条诊断值得单说：**扩展工具没有 `promptSnippet` 就等于模型看不见它**
（官方语义：`buildSystemPrompt` 会过滤掉没有 snippet 的工具）。那与「工具在注册表里」
矛盾 —— 用户会以为能用，模型那边根本没这个工具。所以那时报出来。

| 扩展 | 工具 | UI | 模型/凭证 | 命令/快捷键 | 会话 |
| --- | --- | --- | --- | --- | --- |
| `rpiv-ask-user-question` | ✅ | ✅ `ui.custom()` overlay | — | — | — |
| `pi-web-access` | ✅ | ✅ `setWidget` / `theme` | ✅ `modelRegistry` / `ctx.model` | ✅ 4 命令 / 2 键位 | ✅ 三个只读成员 |

## 斜杠命令与快捷键：接了

早先「命令不接」的理由是：pi 的命令 handler 拿 `ExtensionCommandContext`，而那里面
`waitForIdle` / `newSession` / `fork` / `navigateTree` / `switchSession` / `reload`
本项目一个都没实现。

那个理由**过了一半**：那六个**确实**不接，但 handler 真正要的东西少得多。
`pi-web-access` 那四个命令（`/websearch` `/curator` `/google-account` `/search`）
只用到两样，而且都有真的实现：

| 成员 | 落在哪 |
| --- | --- |
| `ctx.ui.notify` | 界面那行 `notice`（`extension-ui.ts`） |
| `pi.sendMessage` | 落成一条**用户消息**（于是环会跑起来） |

那六个仍然 reject 掉（pi 的会话层，见 [surfaces](surfaces.md)），而不是给假 no-op ——
后者会让扩展以为「fork 被用户取消了」而继续往下走。

### 为什么不并进 `SLASH_COMMANDS`

那份表是**常量**（补全与 `/help` 都念它，是唯一真相），而扩展的命令要等
`loadExtensions()` 装载完才知道 —— 可能发生在编辑器建好**之后**。所以走
`commandTable()` 里一个单独的展开（`extensionCommands.list()`），与 skill 命令
同一种情况：现取。

### 快捷键：内置键优先

`onInput` 里**先**跑内置的那几个开关（轨迹页 / 展开工具 / 中断…），**没消费**才问扩展。

顺序反了的后果很具体：扩展能把切页键吃掉，于是轨迹面板「按了没反应」，而那比
「扩展的键偶尔不生效」难查得多。（这条顺序测试里钉了，**而且验过它能抓**。）

扩展的 handler 是 async（`/search` 会弹 `select`），而输入监听器是**同步**回调 ——
在监听器里 await 就是等一个要人来点的窗口。所以只把 handler 排出去，**不消费**那个键。

### `setWidget` 与 `ctx.ui.theme`

快捷键那条又逼出两样，都是「接了但会静默坏」：

- **`ctx.ui.theme`** —— 官方 `ExtensionUIContext` 真的有这个成员，扩展会直接读
  （`pi-web-access` 的活动面板开头就 `ctx.ui.theme.fg('accent', …)`）。少了它那个
  面板一开就 `Cannot read properties of undefined (reading 'fg')`。
  给 `setupTheme()` 返回的那个 globalThis Proxy，所以颜色与本项目界面**完全一致**。
- **`setWidget`** —— 活动面板的落点。本项目的底部 VStack 里 editor 上面**本来就是**
  一格，所以只差「布局要跟着重设」（VStack 的 children 是建时定下的）。

  **`setWidget` 有两种形状，两个都接**：官方的 `string[]`（扩展自己上好色的行）与
  组件工厂。早期只接工厂、把数组当错误抛了 —— 而 `pi-web-access` 恰恰用数组。

### 一处真回归：`theme` 不能要求界面已起来

`ctx.ui.theme` 是 getter，而扩展在**界面起来之前**就可能碰它（内核装扩展时
`setUIContext` 已经把 UI 绑上了）。而 `tui.ts` 的 `requireUi()` 曾经对空 `uiRef`
一律抛 —— 于是扩展一碰 theme 就抛，**整个界面起不来**。

症状极难认：首帧空白、顶行与底栏全没、底栏断言三条一起挂，而真因只在 stderr 一行
「扩展要求界面」。看起来像布局坏了。

现在 theme 真的给（`initTheme` 在内核装配之前就调了），只有要**活着**的 tui 的那几个
方法才在没就绪时报错。测试里钉了这条，**而且验过它能抓**（把 `theme` 改回走 `live()`
就立刻红）。

## `ctx.sessionManager`：接了

它只读三处：`getSessionId()`（算 opencode 的请求头）、`getBranch()`（恢复上次的搜索
结果）、`buildSessionContext(branch)`（重建对话，判「这轮模型用过哪些 web 工具」）。

### 数据源是**本项目**的会话

pi 那边是 `SessionManager` **类**，条目来自它自己的 `sessions/*.jsonl`。本项目的会话是
**另一份**（`state.messages` + 自己的落盘器）。拿 pi 的来读，读到的是**上一次进程**
留下的文件 —— 而当前这一轮的消息一个都没有。

症状是「`/search` 列不出刚才搜的东西」，而且**只在同一个会话里出错**（重启就「好了」，
因为那时文件里的内容恰好等于内存里的）。极难归因。

所以只实现那三个只读成员，数据源是 `state.messages`。

### `getBranch()` 必须包一层 `{type:'message', message}`

扩展是这么调的：`buildSessionContext(ctx.sessionManager.getBranch()).messages`。
少包那层的话官方的 `buildSessionContext` 会把消息当成条目、读不到 `.message` ——
症状是「模型这轮用过哪些 web 工具」判不出来，于是**每次都要求 `web_enable` 重新加载一遍**。

## 仍然不接的

- **那六个会话操作**（`waitForIdle` / `newSession` / `fork` / `navigateTree` /
  `switchSession` / `reload`）—— pi 的会话层。
- **`ctx.ui.select` / `confirm` / `input`** —— RPC 宿主那套弹窗协议。本项目的选择有
  自己的（`openSessionPicker`）。`/search` 选历史结果那条要 `select`，所以它会报
  「不支持」而不是假装列了。
- **`setFooter` / `setHeader`** —— 要接 pi 的应用层布局。
- **`pi.appendEntry`** —— 存「不发给模型」的会话条目（pi 会话层）。给 no-op 而不是报错，
  于是扩展自己的 `if (results.length === 0)` 会走：`/search` 回一句
  「No stored search results」。**代价：`/search` 看不到历史搜索结果。**
- **`pi.sendMessage` 的 `customType` / `display` / `details`** —— 我们只取 `content` 里
  那些 text 块拼成一条用户消息。后果：扩展 `/curator` 那种「在转录里留一个可点开的
  卡片」会退化成**普通对话**。外观上的降级，结论照样回到对话里。

## 折叠（`Ctrl+]`）：验过了，包括一个上游的怪事

折叠是**唯一**一条要**原始终端输入**才能走通的路，所以它单独一个测试文件
（`test/extension-collapse.test.ts`），形状与其他扩展测试不同：那边只发 promise，
这边要能**模拟按键**。

### 两条路，缺一不可

扩展的 `registerCollapseKeyListener()` 同时做两件事：

1. **raw listener**（`ctx.ui.onTerminalInput`）—— **唯一**能让折叠后**复原**的路：
   pi-tui 不把输入发给一个 `setHidden(true)` 的 overlay 的 `handleInput`。
2. **`handle.setHidden(true)`** —— 收成一行（`buildCollapsedRender`）而不是满屏浮层，
   于是背后的对话看得见。

只做 1 不做 2：对话框还在挡。只做 2 不做 1：一旦收起**再也回不来**。
测的是「收得起 → 提示里点名那个键 → 展得回」这个**来回**。

### 按键用 `\x1d`（GS）

`Ctrl+]` 就是 0x1d。验过 pi-tui 的 `matchesKey`：0x1d、CSI 27;5;93~、CSI 93;5u 都匹配；
**裸 `]` 与 CSI 93（无修饰位）不匹配** —— 用错一个键就会静默地什么都不发生。

### 一个上游的怪事：收起后按 Esc 什么也不发生

扩展文档写「While collapsed, every keystroke other than cancel is ignored」——
读起来是「Esc 能用」。**实测不是**（pi-tui 1.0.3）：

1. `handle.setHidden(true)` 会**把焦点移走**（`setFocus(topVisible ?? preFocus)`）；
2. 下一帧 `handleTerminalInput` 发现「焦点在一个**不可见**的 overlay 上」，**再改派一次**；
3. 于是按键永远到不了 `QuestionnaireSession.handleInput`，而 `routeCollapsed()`
   （collapsed 时只认 cancel）写在**那条收不到按键的链上**。

出路是**再按一次 `Ctrl+]` 展开**，然后 Esc 就能放弃。

**这不是我们宿主的问题** —— pi 自己跑同一个扩展也是这个行为（同一个 pi-tui）。
记在这里是因为「收起后按 Esc 没反应」是真实的用户困惑，而真因在 pi-tui 与扩展的交界处：
只看现象会以为是自己的接线错了。`routeCollapsed` 只在「折叠但**仍可见**」的降级形态下
可达（宿主没给 raw input → `canReopenWhileHidden === false` → 扩展退回可见的一行提示）。

### 写这个测试时踩的三个坑（都在注释里）

1. **必须 `tui.start()`**，否则 `doRender()` 第一行就 return —— 于是 `hasOverlay()` 是
   true、promise 也不 reject，而画面全空。**看起来一切正常。**
2. **重绘是异步的**（`requestRender` 走 nextTick + 16ms 节流），所以按键之后要显式
   `renderNow(true)` 强推一帧，否则断言在第一帧之前就跑。
3. **不能覆盖 `addInputListener`** —— pi-tui 的 `handleTerminalInput` 直接读它**内部的
   Set**，不是调那个公开方法。覆盖它等于把 listener 存到别处，于是扩展的 raw
   listener 永远不被调。按键要喂 `handleTerminalInput`（它自己会做焦点改派），
   不要自己遍历 listener。

## 八个文件

| 文件 | 干什么 |
| --- | --- |
| `src/extension-host.ts` | 装扩展：解包路径、`loadExtensions`、runner 绑定、工具适配 |
| `src/extension-ui.ts` | `ctx.ui`：`custom()` overlay、`setWidget`、`theme`、`notify`、raw input |
| `src/extension-tools.ts` | pi `ToolDefinition` → 本项目 `AgentTool`；工具集读/写 |
| `src/extension-models.ts` | `ctx.modelRegistry`：官方的 `ModelRegistry` 门面 |
| `src/extension-sessions.ts` | `ctx.sessionManager`：三个只读成员，数据源是 `state.messages` |
| `src/extension-commands.ts` | 斜杠命令与快捷键（内置键优先） |
| `src/extension-prompt.ts` | `before_agent_start` 的接线与两条守卫 |
| `test/extension-*.test.ts` | 真扩展 + 探针 + 模拟按键（三个文件） |

## 测试为什么用真扩展

假扩展只能验「我们自己写的胶水」，而这批代码的全部风险都在**接缝上**：

- 扩展的 `typebox` / `pi-tui` / `pi-coding-agent` 是虚拟模块，本仓库 `node_modules`
  里没有 `typebox` —— 自己 import 那个包必然失败，只有走 `loadExtensions()` 才会过。
- 扩展的 execute 有**五个**参数，第五个 `ctx` 是它的命脉（`hasUI` / `ui.custom`）。
  假扩展很少用 `ctx.ui.custom()`，于是「overlay 到底能不能画出来」根本没被验到。
- 扩展的 `details` 是 `unknown`，pi-ai 1.x 要它能 JSON 序列化 —— 假扩展多半返回 `{}`，
  碰不到那条路。
- **扩展可能分发的形态不同**：`rpiv-ask-user-question` 是 TS 源码（入口 `index.ts`，
  走 jiti 转译），`pi-web-access` 是编译 bundle（入口 `dist/index.js`）。`hasPackage()`
  两种都认 —— 写死一种的话，第二个扩展的测试会一直 skip 而没人发现。

所以用真的。装不上就 skip 并说清为什么（离线机器上这个测试没法跑，硬失败只会让人
以为代码坏了）。

这个测试**故意用真配置家目录**（`test/isolated-home.ts` 平时把 `PI_CODING_AGENT_DIR`
指到临时目录，那里没有 `settings.json` 的 `packages`）—— 那正是本项目与 pi **共用**
配置的体现（见 [sessions](sessions.md)）。

两条测「真的会坏」而不是「形状对」的：

- 「无 UI 时自己降级」断言 `details` 逐字是 `{answers:[],cancelled:true,error:'no_ui'}` ——
  那是坑二，绑一个空 UI 就会得到 TypeError。
- 「给真 UI 时 custom() 把浮层挂上去」**轮询** `tui.hasOverlay()`，不是固定等 3 秒 ——
  固定等待在单跑时过、全量并发跑时挂（实测过）。

`pi-web-access` 那几条里最关键的是 `getAllTools` 那条：它走 `web_enable` 的**真实**
路径（`getAllTools()` → `setActiveTools()` → 回头 `getActiveTools()` 核对），
断言结果里**不出现** `unavailable` 与 `still inactive`。那正是那个真实回归。

`ctx.model` / `ctx.modelRegistry` 那条用**内联扩展工厂 + 一个探针工具**问「你那个
registry 能不能拿到凭证」——因为真扩展把摘要模型解析包在一个 UI 面板里（点「生成摘要」
才走），而那条路要有真 key + 真页面。探针拿到的 ctx 与真扩展**逐字同形**（都由
`ExtensionRunner.createToolContext` 造），测的是同一段宿主代码。断言里有 `hasKey`
——「真的拿到一个 key」而不只是「拿到一个对象」。

## 相关

- 工具与那层适配 → [tools](tools.md)
- 界面与 overlay → [surfaces](surfaces.md)
- 装载（prompt / tools / skills） → [init](init.md)
- 配置家目录与共用配置 → [sessions](sessions.md)
