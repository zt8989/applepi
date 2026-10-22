# 扩展

本项目能装 **pi 扩展**（`settings.json` 的 `packages`，外加 pi 的那两个**本地目录**
`.pi/extensions/` 与 `~/.pi/agent/extensions/` —— Orca 的托管扩展就装在后一个里），
装上来的工具与 prompt 片段在**装载时**并进内核，agent 生命周期事件则实时发给它们。

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

### 多个扩展**串行**装载（与 pi 同一形态）

`loadExtensionHost` 是一次 `loadExtensions(paths, …)`，它内部按声明顺序逐个 import
（一个装完再下一个）：

```ts
const loaded = await loadExtensions(
  resolvedEntries.map((entry) => entry.path),
  cwd,
  eventBus,
  runtime,
);
```

**顺序是语义，不是巧合**：工具表是「同名先注册者优先」，谁生效只能由 `settings.json`
里的顺序决定；而扩展在 import 期就有副作用（`registerTool` / `registerCommand` / 读
`getAllTools`）。并行装载时这些副作用的先后不再等于声明顺序（重名工具谁先注册、
读注册表时看不看得见别人，都变成时序问题），与 pi 的行为不一致。

**曾经并行过**（每个扩展单独调一次再 `Promise.all`：同一批扩展实测并行
0.5~0.6s / 串行 0.6~1.1s）。改回串行的代价很小：`deferExtensions` 已把整段装载推离
首帧（见 `init.md` 的启动时间线），省下的那几百毫秒只在后台窗口里。

顺带说明 pi 为什么看起来「串行也很快」：pi 串行只要 314ms（`PI_TIMING=1`，8 个扩展），
是因为它自己是预打包的 `dist/bundle/cli.js`、jiti 走 bundle 的 embedded modules；同一批
扩展用我们的 loader（未打包，见 `init.md` 的「打包」一节）要 0.6~1.1s —— 形态不同，
不是风格不同。

测试钉住两条（`test/extension-host.test.ts` 的「串行装载，顺序是 settings.json 的顺序」）：
让**声明在前**的扩展最慢，断言**装载完成顺序**就是声明顺序（并行时会 `b, c, a`），
以及重名工具归先声明者。

### 为什么用 `DefaultPackageManager` 而不是自己读 `settings.json`

它做的事多得多且都是必须的：用户级与项目级两份 settings 合并、同一个包两处出现时
项目优先（`autoload:false` 时是 delta 而非替换）、项目信任判断、npm 包的安装目录解析。

自己读 `settings.json` 再拼路径，最后必然是「pi 装到哪儿我们不知道」——症状是
`pi list` 明明有，这边说没装。取不到时用 `onMissing: skip`：**不自动 `npm install`**，
本项目不是包管理器，替 pi 装东西会让两边状态分家。

### 也扫**本地扩展目录**（与 pi 同一顺序、同一规则）

`settings.json` 的 `packages` 不是 pi 扩展的唯一来源 —— pi 还会扫两个**本地目录**，
“放到那儿就生效”：

| 顺序 | 目录 | 谁在用 |
| --- | --- | --- |
| 1 | `<cwd>/.pi/extensions/` | 项目本地扩展 |
| 2 | `<agentDir>/extensions/`（即 `~/.pi/agent/extensions/`） | **Orca 装给 pi 的托管扩展** |
| 3 | `settings.json` 的 `packages` | npm / git / 路径 |

顺序**是语义**：工具表是「同名先注册者优先」，所以「谁顶掉谁」只能由这份顺序决定。
不扫这两个目录，Orca 那三个托管扩展（状态钩子 / 标题 spinner / prefill）一个都装不上 ——
症状是「Orca 里那个面板永远停在 loading」。

发现规则照抄 pi 的 `discoverExtensionsInDir`：只下探**一层** —— `extensions/*.ts` /
`*.js`，或 `extensions/<子目录>/`（按子目录的 `package.json` 的 `pi.extensions`，
再退到 `index.ts` / `index.js`）。本地扩展没有包元数据（`metadata: undefined`），
官方 loader 已经给它们写了 `sourceInfo`（`source: 'local'`）。

## 我们必须自己给的三样

| 扩展要什么 | 本项目给什么 | 在哪 |
| --- | --- | --- |
| `ctx.ui.custom()` | overlay → `showOverlay()`；inline → 换掉 composer 那一格 | `packages/core/src/extension-ui.ts` |
| 工具执行 | 自己的 `getTool()` 注册表 | `packages/core/src/tools.ts` 的 `registerExtraTools` |
| `setActiveTools()` | 一条 reducer action 的位置（**刻意空**） | `packages/core/src/extension-tools.ts` |

### `ctx.ui.custom()`：两种形态，两种落点

pi 的 `custom()` 有**两种**（参数里给不给 `overlay: true`），本项目两种都实现：

| | `{ overlay: true }` | 不给 / `{ overlay: false }` |
| --- | --- | --- |
| pi 的落点 | `ui.showOverlay()` | 换掉 `editorContainer` 里的 composer |
| 本项目的落点 | 同一个 | 同一个（`mountEditorSlot`） |
| 焦点 | `showOverlay` 抢、`hide()` 还（它自己记了 `preFocus`） | 宿主换格时给，还回来时交回 composer |

overlay 那条：`custom()` **必须**在扩展给的 `done()` 里 `handle.hide()` —— 不 hide 的话
浮层永远挂在 overlay 栈上、输入再也回不到编辑器，界面看着「答完了却还能打字」。

inline 那条：宿主把**输入区那一格**（composer）换成扩展的组件，并负责三件事 ——
换格重排、给焦点、进出时存/还 composer 里那行字（pi 在自己的
`showExtensionCustom()` 里也是这么干的）。inline **不给 `onHandle`**（与 pi 一致）：
没有浮层栈可弹，也就没有可复原的 `setHidden`，扩展据此把折叠退化成一行可见提示 ——
见下面「折叠」一节。

**宿主没有这一格时（`mountEditorSlot` 缺省）非 overlay 的 `custom()` 直接抛错**，
而不是静默 no-op：能开这一格的只有真界面（`tui/app.ts`）与测试探针；
`tui.ts` 的 `requireUi()` 在界面起来之前给的就是个没有槽位的占位宿主。

`select` / `confirm` / `input`（pi 给 VS Code pendant / Zed 那种宿主的「RPC 弹窗协议」）
**也实现了**，是 core 的 `raceDialog`：**两端各出一份、谁先回答谁算数** —— 终端那一份
由 `tuiDialogs` 挂进同一个输入区槽位，浏览器那一份由 `web/bridge.ts` 的 `DialogHost`
发过去。别的扩展（`pi-web-access` 的面板之类）与 `confirm` 走的就是这条。

### `ask_user_question`：内置扩展 + patch，终端归它、浏览器归我们

它**不再**走上面那条逐题回退。这个包是本仓库的 pinned 依赖（`@juicesharp/rpiv-ask-user-question`）
加一份 `patches/@juicesharp__rpiv-ask-user-question@2.13.5.patch`，由
`extension-host.ts` 当**内置扩展**按路径装载（`settings.json` 里那一份会被换成我们这份 ——
同名工具是"先注册者优先"，两份都在的话生效的可能是没打补丁的那份）。

补丁做三件事（可复现来源：`packages/core/scripts/repatch-ask-user-question.ts`，跑一遍就重建那份 patch）：

1. `execute()` 里多一个 `ctx.ui.externalQuestionnaire?.({ params, answer, note, done })`
   握手段 —— 把归一化后的题目交给宿主（它只回 label / selected / notes 这些**表面**
   东西，翻成 `QuestionnaireResult` 的活儿留在包内）。它放在**会话懒加载之前**：
   `loadQuestionnaireSession()` 要 import 终端那份渲染图（pi-tui/markdown，冷导入约 1s），
   浏览器那份弹窗不该等它。
2. `state/questionnaire-session.ts` 加一个 `setHostNote(tab, text)`：宿主（浏览器那份）
   写的备注同步进扩展自己的 `notesByTab` —— 于是终端面板上看得见同一条，而且万一是
   终端那边提交的，备注照样跟着答案回给模型。
3. `state/i18n-bridge.ts` 去掉顶层 await —— 上游那句 TLA 在 jiti 下会让**导入它的模块**
   拿到 `undefined` 导出，症状是"这个工具坏了，请重启"（负载高时必现）。

> 备注只同步**一个方向**：浏览器 → 扩展。反向没有通道（终端那份备注在扩展自己组件的
> 内部状态里，宿主读不到）—— 这是"终端归扩展渲染"的代价，写在
> `webui.md` 的问卷那一节里。

于是两边**同时开着、谁先答都算数**：

```
扩展 execute()
  ├─ 把题目交给宿主（externalQuestionnaire） → 我们：开浏览器那份弹窗
  ├─ 挂它自己的组件（ctx.ui.custom）          → 终端那份（多题 tab / 预览 / 备注 / 折叠）
  ├─ 浏览器先答 → handoff.answer(raw)  → 扩展收掉自己的组件、用这份答案继续
  │  终端先答   → 扩展 finally 里 handoff.done() → 我们收掉浏览器那份
  └─ buildQuestionnaireResponse(result, typed) → 模型看到的信封
```

宿主侧那份状态在 `questionnaire.ts`（`QuestionnaireSession` + `QuestionnaireHost`），
浏览器界面在 `webui/questionnaire.ts`（帧走 `ui-questionnaire` /
`ui-questionnaire-intent`）。**留空**的题不出现在答案里（信封会列成 `unanswered:`），
每题备注与整份备注都带着 —— 与扩展自己那份 TUI 的能力对齐。

`ctx.mode` 本项目**恒为 `'tui'`**：终端确实是这一侧的交互方，浏览器是同一份状态的
另一块屏（早先那套"浏览器连着就切 `'rpc'`"的做法已删）。

没实现的是：`setFooter` / `setHeader`（要接 pi 的应用层布局，见
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

`allToolsInfo()` 现在报真实的注册表（`tools.ts` 的 `registeredToolInfos()`），包括
`exposure` / `namespace` / `annotations` / `sourceInfo`：

- `exposure`：**真的**。接了 MCP 之后它就不是「恒为 `direct`」了 —— MCP 扩展自己在
  `ensureDiscoveryActive()` 里读它判断「有没有 codemode 工具需要被激活」。恒给 `direct`
  会让它以为一个 codemode 工具都没有，于是 codemode 不会激活、MCP 工具全部不可达。
  五种取值的含义见 [mcp-codemode](mcp-codemode.md)。
- `namespace` / `annotations`：真的（MCP 服务器与工具注解）。codemode 按 namespace 分组，
  权限扩展读 annotations 决定要不要确认。
- `sourceInfo`：给**一个合法形状**（`{ source: 'local' }`）而不是 `undefined` ——
  扩展会在 `getAllTools().find(...)` 之后去读它，给 undefined 会炸在一个假字段上，
  而那个堆栈与真因隔了三层。

### `getActiveTools()` 得读**装上了 prompt 的那张表**

`web_enable` 启用完会回头 `getActiveTools()` 核对一遍（「still inactive」就是这一步）。
我们读的是 `state.prompt.tools` —— 也就是**真正发给模型的那份**（`effects.ts` 的
`toolSchemas()` 原样读它）。早先在探针里读到空数组，于是误报「still inactive」。

这不是巧合而是设计：扩展问「现在有哪些工具」，答案必须是「模型看得见哪些」。

`prompt.init` 之前它是空的，所以这个 getter 在那种时候读**注册表的激活集**
（`activeToolNames()`）—— MCP 扩展在 `session_start` 里就要问它（那时还没有 prompt）。
判据是 `state.prompt.tools.length === 0`，见 `extension-tools.ts`。

### ③ `ctx.sessionManager`：接了（只读）

pi 的会话**层**（`addEntry` / `fork` / `navigateTree`…）本项目刻意不接（见
[surfaces](surfaces.md)「为什么不用 pi 自己的 InteractiveMode」），但扩展**读会话**的
那几个成员接了 —— 数据源是本项目的 `state.messages`，见下面的「`ctx.sessionManager`：接了」。

这一节早先写的是「仍然不接」，于是 `pi-web-access` 一读就在 `undefined` 上炸。

## 不接的：命令与快捷键

`pi-web-access` 注册了 4 个命令（`/websearch` `/curator` `/google-account` `/search`）
与 2 个快捷键（`ctrl+shift+s` / `ctrl+shift+w`）。本项目**不接**它们，**而且明说**：

- 命令表是 `tui/app.ts` 里的 `SLASH_COMMANDS`（唯一真相，补全念它）。
  接进去就要往那儿塞，而那边只有 `description` + 一个 `runCommand` 里的 switch。
- 命令 handler 在 pi 那边拿的是 `ExtensionCommandContext`（`waitForIdle` /
  `newSession` / `fork` / `navigateTree`…），本项目**一个都没实现**。接了就在 handler
  里炸。
- 更糟的是**假装能用**：补全里冒出 `/websearch`、敲下去什么都不发生 —— 那是
  「静默退化」里最难查的一种。

所以工具接、命令不接。测试里钉住「装它不会往 `SLASH_COMMANDS` 里塞东西」
（`packages/core/test/extension-host.test.ts` 的「命令与快捷键不接」）。

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
「用户取消了」，给假值等于撒谎。（`select`/`confirm`/`input` 现在实现了；这条针对的是
`setFooter`/`setHeader` 那批仍然不接的，以及「两端都没有可用对话框」那一档 ——
那时 `select()` 仍然 reject。）

非 overlay 形式的 `custom()` 现在**也实现了**（换掉 composer 那一格，见上）。
宿主没有那一格时（`mountEditorSlot` 缺省）才抛错并说明原因。

> 这一段此前写的是「直接抛错」—— 那是 `ask_user_question` 2.12 时代的事实
> （它那时只发 overlay）。2.13 起它**默认**发 inline，于是那个显式报错从「明说不行」
> 变成了「这个扩展在本项目里必挂」。

## 三个坑

### 一、工具集**中途可变**，但「变了要声明」

早先这里写的是「工具集装载时定死」：`setActiveTools()` 只在装载窗口内生效，窗口外
一律拒绝并记一条诊断。理由是对的（中途换工具会让已发出的 `messages` 与 prompt 对不上、
prompt-cache 前缀作废），结论是错的 —— 那两条现在都由**声明**解决了：

- `setActiveTools()`（`extension-tools.ts` 的 `applyActiveTools`）真的更新
  `state.prompt.tools`；
- `reducer.ts` 的 `agent.run` 在**请求前**把「能执行的」与「已经声明给模型的」
  diff 成一条 `toolsAdded` / `toolsRemoved` 的 system 消息（pi-agent-core 的
  `declareToolChanges` 同一步）；
- **head 永远是装载时那批**（`state.prompt.headTools`）—— 已有消息一个字节不动。

收益是具体的：`pi-web-access` 的 `web_enable`、`pi-subagents` 的 `subagents_enable`
都是 loader 工具，整条功能就是「运行中把工具加进来」；窗口在时它们只能回一句
「still inactive」。

`ask_user_question` 自带的 `before_agent_start` 协调器在本项目仍然是 no-op，但理由
只剩一条：本项目只有交互式一种模式、`hasUI` 恒真，所以它要做的事本来就不需要做
（不再是「改了也不生效」）。

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

## `before_agent_start`：发，段改动真的采信

发这个事件的两个理由：

1. 工具集 —— 不发它 `ask_user_question` 的协调器**永远不会被调用**；
2. 不违反契约 —— 扩展可能靠这个事件做别的事（改 prompt 段、记一次「轮开始」…），
   不发等于骗它「没这回事」，症状会出现在它内部的某个远端调用上，极难归因。

**整段替换不采信，按段 patch 采信**。官方那个 `emitBeforeAgentStart` 会用
`systemPromptOptions` **重建**整份 system prompt 并整段塞进请求；本项目的 prompt 是
装载时定下的，整段换会让已发出的 `messages` 与 prompt 对不上。但**分段**是存着的
（`state.prompt.sections`），于是：handler 写回的段与「当前生效」那份一 diff，
**只有变了的段**进一条新的 system 消息（`prompt.segment.added`，`null` = 删段）。

为什么非要「按段 + 追加」而不是「重发整段」：**前缀缓存**。请求里靠前的那部分
（head 与已有消息）一个字节都不能动，否则整段 token 的缓存作废。head 的形状见
`packages/core/src/prompt-head.ts`：

- head 是 `messages[0]` 的一条 system 消息（装着全量 `sections` 与 `toolsAdded`），
  **不是** `Context.systemPrompt` / `Context.tools` —— 那两个字段会被 pi-ai
  **每轮**重建成 head，改一个字就整条重造；
- 支持 mid-conv system 的模型：head 原样 + 后面的段 patch 一起发；
- 不支持的模型：pi-ai 的 `resolveTranscript` → `collapseSystemMessages` 把它们
  **回放合并**成一条 head（语义相同，代价是这一轮前缀必断 —— 模型能力的硬约束）。

**`ctx` 用官方那个**（`runner.createContext()`），不手搓最小版。早先这里是
`{ hasUI, mode, cwd }` 三字段，理由是「那条协调器只读 `ctx.hasUI`」—— 直到
`pi-subagents` 的 handler 去读 `ctx.sessionManager` 算会话身份：手搓的 ctx 里那个是
`undefined`，于是**每轮**一条 `Cannot read properties of undefined (reading
'getSessionFile')`，而那个堆栈里一帧本项目的代码都没有。官方 ctx 的每个成员本项目都
已经接好了（见上面的 `getActiveTools` / `getAllTools` / `sessionManager` 那些节），
所以它既不更假、也不更容易崩 —— 它只是**不装**。

**事件字段按「谁会读」给**：`cwd`、`sections`（MCP 往里写 `mcp_servers`）、
`selectedTools`（`pi-subagents` 主 handler 第一句就是
`...selectedTools.includes('subagent')`）。少一个 = 每轮一条 `Cannot read properties of
undefined`；多给（`skills` / `toolSnippets` / `forceSystemPrompt`…）= 骗扩展它能重拼
prompt。`selectedTools` 是**真值**（当前声明给模型的工具名，与它自己调
`pi.getActiveTools()` 同一份），可写只是为了别让 `??=` / `push` 那种写法炸在冻结的数组上
（我们只拿它给 handler 读；真正生效靠它同时调 `pi.setActiveTools()`）。

两条守卫：

- **环在跑的时候不发** —— 那个事件没有对应的一轮语义。扩展可能据此注入消息，
  在工具调用的那一轮里发它等于告诉它「用户又说话了」，消息就凭空多出来。
- **启动期只给内置扩展发** —— `collectPromptSections()` 要拿 MCP 的 `mcp_servers` 段
  （并等 `direct` 服务器连上），所以只跑 `builtin:` 那几个 handler。用户装的扩展在启动时
  一律**不**收到它：它们看到 `before_agent_start` 就认为「用户要发消息了」，Orca 的
  `orca-agent-status` 会因此开一个永不闭合的 turn（宿主那边一直显示 Working/loading），
  而 pi 启动时也不发这个事件（实测：交互式 pi 启动只发 `session_start`）。它们的段
  在首轮真事件时作为补丁追加。
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

还有一条以前的诊断值得提：**扩展工具没有 `promptSnippet`** 曾被视为「模型看不见它」
而报错 —— 那句对项目自己的四个工具成立，对扩展是**错的**。工具有没有 snippet 只
决定它进不进 system prompt 的「工具怎么用」那一节；它一样在注册表里、一样进 API 请求
的 `tools` 数组，模型看得到它的 `description`。pi 自己就不为那种情况报任何东西，
而 `pi-subagents` 0.77 的 `bg_wait` 正好是故意不宣传的那种（用法写在 `subagent` 的
snippet 里）—— 错报一条就变成永远修不掉的 `[Extension issues]`。所以现在只静默地
「不进 prompt 工具节」，不报错。

| 扩展 | 工具 | UI | 模型/凭证 | 命令/快捷键 | 会话 |
| --- | --- | --- | --- | --- | --- |
| `rpiv-ask-user-question` | ✅ | ✅ `ui.custom()`（inline + overlay） | — | — | — |
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
| `ctx.ui.notify` | 界面那张命令反馈卡（`extension-ui.ts` → `notify()`） |
| `pi.sendMessage` | 落成一条**用户消息**（于是环会跑起来）；环在跑时按 `deliverAs` 排队 |

那六个仍然 reject 掉（pi 的会话层，见 [surfaces](surfaces.md)），而不是给假 no-op ——
后者会让扩展以为「fork 被用户取消了」而继续往下走。

### 为什么不并进 `SLASH_COMMANDS`

那份表是**常量**（补全念它，是唯一真相），而扩展的命令要等
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

### 底栏状态段：`ctx.ui.setStatus(key, text)`

`pi-background-tasks` 每改一次任务状态就调它（`updateUi()` 里**无条件**），
`pi-subagents` 的 `/agents` 面板也用它。少了这个成员不是「少一行提示」这么简单 ——
`pi-background-tasks` 在 `catch` 里打一行
`[background-tasks] UI update failed: ctx.ui.setStatus is not a function`，
顺手把 `currentCtx` 清成 `undefined`：**之后所有后台任务事件都不再更新界面**
（任务在跑，底栏永远不再说）。

落点与 pi 不同，这是刻意的：

| | pi | 本项目 |
| --- | --- | --- |
| 位置 | 底栏**多出来的一行**（`lines.push(statusLine)`） | 底栏**第一行的右半边**（左边是 cwd + 分支） |
| 排序 | 按 key `localeCompare` | 同一个 |
| 单行化 | `sanitizeStatusText()`（换行/制表符→空格、压空格、trim） | 同一个（`@ela/core` 的 `setStatus` 里做） |

为什么不能像 pi 那样另起一行：本项目底栏行数是**固定**的（`FOOTER_ROWS`，
`composer-overlay.ts` 同时拿它算面板行预算），多一行会把对话区挤掉一格。

两个细节都不显眼但会静默坏：

- **dim 只能包左段**。状态段是扩展自己上的色（`pi-background-tasks` 是
  `lightBlue(label)`，收尾 `\x1b[0m`）；整体包一层 dim 的话那个 reset 会把 dim 提前关掉，
  行尾突然变亮（与 `dimLine` 同一个坑）。
- **界面起来之前设的那条不能丢**。扩展在装载期就会 `setStatus`，而那时 `uiRef` 还是空的 ——
  `main.ts` 的占位宿主把它存进 `pendingStatuses`，`publishUi` 那一刻补喂一遍。

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

扩展只读这几个成员：`getSessionId()`（算 opencode 的请求头）、`getSessionFile()`
（`pi-subagents` 拿它算「本会话的 subagent 产物放哪」）、`getBranch()` / `getEntries()`
（列会话条目）、`buildSessionContext()`（重建发给模型的上下文）。`pi-subagents` 的
`session_start` handler 会把它们读一遍，而且**不判 `typeof`** —— 少一个的报错就是
`ctx.sessionManager.getEntries is not a function` / `...buildSessionContext is not a
function`，症状是整个扩展不干活（不是降级）。

### 数据源是**本项目**的会话

pi 那边是 `SessionManager` **类**，条目来自它自己的 `sessions/*.jsonl`。本项目的会话是
**另一份**（`state.messages` + 自己的落盘器）。拿 pi 的来读，读到的是**上一次进程**
留下的文件 —— 而当前这一轮的消息一个都没有。

症状是「`/search` 列不出刚才搜的东西」，而且**只在同一个会话里出错**（重启就「好了」，
因为那时文件里的内容恰好等于内存里的）。极难归因。

所以只实现那几个只读成员，数据源是 `state.messages`（`getSessionFile` 例外 —— 它读
本项目的落盘器，那才是文件本身的真相）。

### `getSessionFile()`：给路径，不给就诚实地说 `undefined`

`pi-subagents` 用它算「本会话的 subagent 产物放哪」（`session_start` 与**每轮**
`before_agent_start` 都读）。它是个**取值函数**（指到落盘器当时的文件）：`/new` 之后
文件也换，写死常量的话扩展算出来的产物目录会永远是上一个会话的。

不写会话文件（或落盘器还没建）时返回 `undefined` —— 不编一个假路径出来。
`pi-subagents` 对 `undefined` 有降级路径（回退到 `getSessionId()` 当身份），不报错。

### `getBranch()` / `getEntries()` 给的是**条目**（`{type:'message', message}`）

扩展是这么调的：`buildSessionContext(ctx.sessionManager.getBranch()).messages`。
少包那层的话官方的 `buildSessionContext` 会把消息当成条目、读不到 `.message` ——
症状是「模型这轮用过哪些 web 工具」判不出来，于是**每次都要求 `web_enable` 重新加载一遍**。
条目带 `id` / `parentId`（串成会话树）与 ISO `timestamp`，形状与落盘的
`SessionEntry` 一致。

### `buildSessionContext()` 要带 head，但空会话里不带

`pi-subagents` 靠 transcript 里的 head（第一条 system 消息的 `toolsAdded`）判断
「装载时声明了哪些工具」，据此决定 `subagent` / `bg_wait` 要不要重新激活。所以
`buildSessionContext().messages` 的第一条必须是 head，构造与落盘那条共用
`prompt-head.ts` 的 `buildSessionHead`（两边各拼一遍迟早漂移）。

**例外是空会话**：pi 的 head 与第一条消息一起落盘，而 `session_start` 比两者都早 ——
那一刻 transcript 是空的。扩展靠 `messages.length === 0` 判「新会话」走 eager 装载
（`subagent` 工具在空会话里默认激活就靠这条）。空会话里塞一条 head 会把「新会话」
变成「有历史」，工具于是不激活。

## agent 生命周期事件：接上（Orca 靠它们）

pi 的**状态类扩展**（最具体的例子就是 Orca 装在 `~/.pi/agent/extensions/orca-agent-status.ts`
的那份）靠一组 `pi.on(...)` 事件把「在干活 / 等回答 / 干完了」报回宿主。本项目
没有 pi 的 `AgentSession`（环是 redux-loop），所以这些事件得由**内核自己发**：

| 事件 | 在哪发 | 对应什么 |
| --- | --- | --- |
| `session_start` | `loadExtensionHost().startSession()`；`/new` / `/resume` 各再发一次（`reason: 'new'` / `'resume'` + `previousSessionFile`） | 装载时一次（`reason` 按「是不是已有会话」给 `startup` / `resume`；MCP 也靠它），切会话时再一次 |
| `before_agent_start` | 界面发消息之前（已有） | 用户刚说完、即将开跑 |
| `agent_start` | kernel 的 store 订阅器 | 相位 idle → 非 idle |
| `agent_end` | 同一个订阅器 | 相位回到 idle |
| `agent_settled` | 同一个订阅器 | 同上那一刻（真的静了） |
| `message_end` | effect 的 `callLlm` 里（成功定稿后） | 一条助手消息进 state |
| `tool_execution_start` / `tool_execution_end` | effect 的 `runToolCall` 里 | 工具开始 / 结束执行 |
| `tool_call` | `beforeToolCall` 那个门（已有） | 与上两者不同：它**有返回值** |
| `ui_prompt_start` / `ui_prompt_end` | 官方 `ExtensionRunner` 自己包了 `ctx.ui` | 扩展开一个阻塞弹窗 |
| `model_select` | `kernel.setModel()` | `/model` 真的换了模型 |

几个刻意的取舍：

- **每条都先落成 action（`extension.lifecycle`），再发出去**：轨迹树是 action 的产物 ——
  只有走了 store 的事才会被 reducer 记进树上、被落盘、被回放。生命周期事件也得是 action，
  「扩展/宿主收到了什么」才有一段留下证据的历史（Orca 的状态面板全靠它）。
- **已经有专属节点的事件不重复记**：只有相位级三条（`agent_start` / `agent_end` /
  `agent_settled`）落 kind 为 `extension.event` 的注释节点（不推进 tip，也不进
  `traceStats` 计数）；`message_end` 已在 `llm.result`、`tool_execution_*` 已在
  `tool.call` / `tool.result`、`model_select` 已在 `model.changed` 上，它们的信息更全。
  所以 `tool_execution_*` **不能**代替 `tool.call` / `tool.result` —— 前者只有
  id / 名字 / isError，后者带参数、结果、Message（见 [trace](trace.md)）。
  发出与记录只有**一个出口**（kernel 的 `recordLifecycle()`），分成两处写必然漂。
- **相位级事件用 store 订阅器，不用 reducer**：reducer 是纯函数；而且「环刚停下来」
  在 redux-loop 里没有对应 action（与 `createAutoCompact` 同一个理由，见 `store.ts`）。
  订阅器盯 `phase`，任何停止路径都不漏。
- **`agent_start` 与 `agent_end` 之外还发 `agent_settled`**：pi 的语义里 `agent_end`
  是「这一轮结束」（可能还会继续），`agent_settled` 是「真的静了」。本项目相位回到
  idle 就是两者同时成立的那一点 —— 两个都发，让扩展按它自己的 `agentSettledSupported`
  决定认哪个（Orca 的状态扩展只认后者）。
- **`message_end` 只在助手消息**「真的要进 state」时发（`callLlm` 成功返回的那条）。
  abort / provider 报错那些最终消息不会进 state（也不会进会话），给它们发等于
  让扩展看到一条不存在的消息。
- **工具事件在未知工具 / 被阻止的调用上不发**：它们根本没执行（pi 同理，
  `tool_execution_start` 在 `runToolCall` 里）。
- **发出去就不管**：`emitLifecycle` 不等 handler，但**同步开始**执行 —— 调用顺序就是
  扩展看到的顺序（状态类 handler 都是同步的）。handler 报错只记诊断，不带崩整轮对话。
- **装载完成时补发一次 `agent_settled`**（只发事件，不进轨迹）：环此刻确实 idle，而 Orca 的
  pane 状态靠 hook 推（`agent_end` → done）。pi 那边是 Orca 自己认进程（`--command pi` 是
  它的已知 agent），ela 不在那份名单里 —— 不补这一条的话，启动后一个状态事件都没有
  （`session_start` 会被 Orca 丢掉：还没有 providerSession），宿主就一直显示 loading。

### 一处顺序：**会话记录器要在扩展之前建**

状态扩展在 `session_start` 那一刻读一次 `ctx.sessionManager.getSessionFile()`，之后不再刷新。
而这个路径是它告诉宿主「对话记录在哪」的唯一机会 —— 拿不到就只能一直显示 loading。

所以 `createKernel` 把 `openRecorder()` 提到扩展装载**之前**。报的是**计划路径**
（`SessionWriter.path`）而非「文件已在盘上」：本项目空会话不建文件（见
[sessions](sessions.md)），而状态扩展自己会在**每一次 post** 上 `existsSync` 重试
（`getPersistedSessionMetadata`）—— 第一条消息落盘之后，那之后的每个事件就都带上了
`session_id` + `session_file`。与 pi 自己的注释「Pi publishes its planned path before
creating the transcript」同一回事。

### 为它们补的 `ctx.ui` 四个成员

- **`ctx.ui.setTitle(title)`** → pi-tui 的 `Terminal.setTitle`（OSC 0/2）。Orca 的标题
  spinner 靠它把 `π ✳ <名字> - <目录>` 写进标题；不实现的话 spinner 自己降级（它先
  `typeof setTitle === 'function'` 判一刀），不报错。
- **`ctx.ui.setEditorText(text)`** → 换掉 composer 里那行字（Orca 的 prefill 扩展用）。
  宿主没有输入区时（探针 / 一次性模式）**弹**，不假装把字填进去了。
- **`ctx.ui.setStatus(key, text)`** → 底栏第一行右半边的状态段（`pi-background-tasks` /
  `pi-subagents` 都用；见上「底栏状态段」那一节）。宿主没有底栏时**丢掉** —— 与
  `setWidget` 同一口径：丢一条状态不该把整轮对话带崩。
- **`ctx.ui.getToolsExpanded()` / `setToolsExpanded(v)`** → 就是 `app.tools.expand`
  （Ctrl+O）那个 `expanded`。`pi-subagents` 跑 subagent 前会 `setToolsExpanded(false)`
  （**无条件**，`hasUI` 就行），缺了它那条路径抛 `is not a function` —— 又一个
  「少一个成员就整条功能挂」的例子。两处指向同一个变量是故意的：让 Ctrl+O 与扩展
  以为的展开状态不一致，用户看到的就永远是次优的一边。

## 仍然不接的

- **那六个会话操作**（`waitForIdle` / `newSession` / `fork` / `navigateTree` /
  `switchSession` / `reload`）—— pi 的会话层。
- ~~**`ctx.ui.select` / `confirm` / `input`**~~ —— **已接**（见上「两端各出一份」）。
  `pi-web-access` 的 `/search` 选历史结果那条因此真能用；终端与浏览器同时弹，先答的算。
- **`setFooter` / `setHeader`** —— 要接 pi 的应用层布局。
- **`pi.appendEntry`** —— 存「不发给模型」的会话条目（pi 会话层）。给 no-op 而不是报错，
  于是扩展自己的 `if (results.length === 0)` 会走：`/search` 回一句
  「No stored search results」。**代价：`/search` 看不到历史搜索结果。**
- **`pi.sendMessage` 的 `customType` / `display` / `details`** —— 我们只取 `content`
  拼成一条用户消息（字符串与 content 块数组都收）。后果：扩展 `/curator` 那种「在
  转录里留一个可点开的卡片」会退化成**普通对话**。外观上的降级，结论照样回到对话里。

  第二个参数的 `deliverAs` 是真的执行的：空闲时开新回合，环在跑时 `steer` 进 steer 队、
  `followUp`（以及 `nextTurn`）进 followUp 队 —— 见 `extension-host.ts` 的
  `extensionMessageAction`。这两条都不能省：**只收块数组**会让字符串 `content` 归一成
  空串（`pi-background-tasks` 的 `<background-task-notification>` 正是字符串，症状是
  「任务 completed、`notified` 是 true，界面上什么都不发生」）；**环在跑时发
  `user.message`** 会被 reducer 当无效输入丢掉。`triggerTurn` 在本项目只影响「排队还是
  开新回合」那半边 —— 空闲时一律开回合（本项目没有「只登记、不进模型」的 custom 条目，
  见上一条 `appendEntry`）。

  归一到空文本时 **抛**（不静默成功）：pi 的 `sendMessage` 返回 `void`，调用方唯一
  的失败信号就是异常 —— `pi-background-tasks` 的 `notifyCompletion` 先当成功、**只在
  catch 里**复位 `task.notified`。吞掉异常就等于在盘上记一条「通知已送达」而没人收到。
  同理，`onSendMessage` 没配（无对话入口）也抛。
- **扩展 handler 自己报的错** —— 不再静默：`runner.onError(...)` 接到了
  `extensions.errors`（以前 `runner.emit()` 的 per-handler catch 把错递给一个空
  listener 集合，等于什么都看不到）。代价：写坏的扩展现在会在启动横幅里多一行诊断
  —— 那正是他要的。

## 折叠（`Ctrl+]`）：两种形态，两种机制

折叠单独一个测试文件（`packages/core/test/extension-collapse.test.ts`），因为它要能**模拟按键** ——
其他扩展测试只发 promise。

### 形态由扩展选的 presentation 决定（我们两档都得撑住）

`rpiv-ask-user-question` 2.13 起**默认 inline**：`presentation.ts` 的
`resolvePresentation()` 优先占「输入区槽位」（Pi 的 editor slot），只有槽位已被另一份
问卷占住时才用 overlay。两边的折叠机制完全不同：

| | inline（默认） | overlay（槽位被占时） |
| --- | --- | --- |
| 落点 | 换掉 composer 那一格 | 浮层 |
| 折叠 | 收成**一行可见提示**（仍握着焦点） | `handle.setHidden(true)` 收成一行 |
| 复原靠 | 组件自己的 `handleInput` | `ctx.ui.onTerminalInput()` 的 raw listener |
| 收起后按 Esc | **放弃**（`routeCollapsed` 只认 cancel） | 到不了组件 |

「raw listener 才是唯一复原路」那句只对 **overlay** 成立：pi-tui 不把输入发给一个
`setHidden(true)` 的 overlay 的 `handleInput`。

### 一个上游的怪事：overlay 收起后按 Esc 什么也不发生

扩展文档写「While collapsed, every keystroke other than cancel is ignored」——
读起来是「Esc 能用」。**实测不是**（pi-tui 1.0.3，且只在那条 overlay 路上）：

1. `handle.setHidden(true)` 会**把焦点移走**（`setFocus(topVisible ?? preFocus)`）；
2. 下一帧 `handleTerminalInput` 发现「焦点在一个**不可见**的 overlay 上」，**再改派一次**；
3. 于是按键永远到不了 `QuestionnaireSession.handleInput`，而 `routeCollapsed()`
   （collapsed 时只认 cancel）写在**那条收不到按键的链上**。

出路是**再按一次 `Ctrl+]` 展开**，然后 Esc 就能放弃。

**这不是我们宿主的问题** —— pi 自己跑同一个扩展也是这个行为（同一个 pi-tui）。
而且它在默认的 inline 形态下**不存在**：收起只是换个画法，组件与焦点都还在，
所以「收起后 Esc = 放弃」是可达的（测试里钉住了）。

### 按键用 `\x1d`（GS）

`Ctrl+]` 就是 0x1d。验过 pi-tui 的 `matchesKey`：0x1d、CSI 27;5;93~、CSI 93;5u 都匹配；
**裸 `]` 与 CSI 93（无修饰位）不匹配** —— 用错一个键就会静默地什么都不发生。

### 写这个测试时踩的四个坑（都在注释里）

1. **必须 `tui.start()`**，否则 `doRender()` 第一行就 return —— 于是组件挂上了、
   promise 也不 reject，而画面全空。**看起来一切正常。**
2. **重绘是异步的**（`requestRender` 走 nextTick + 16ms 节流），所以按键之后要显式
   `renderNow(true)` 强推一帧，否则断言在第一帧之前就跑。
3. **不能覆盖 `addInputListener`** —— pi-tui 的 `handleTerminalInput` 直接读它**内部的
   Set**，不是调那个公开方法。覆盖它等于把 listener 存到别处，于是扩展的 raw
   listener 永远不被调。按键要喂 `handleTerminalInput`（它自己会做焦点改派），
   不要自己遍历 listener。
4. **探针宿主的 `mountEditorSlot` 必须真的接到 `setLayoutRoot` 上** —— 只记一个引用
   的话 inline 组件一帧都不会被画，而那种失败看起来像「扩展没渲染」，真因在宿主探针里。

### inline 的宿主侧：把那一格真的换掉

`packages/tui/src/app.ts` 的 `mountEditorSlot` 与 pi 的
`editorContainer.clear(); addChild(component)` 是同一件事：换格、重排布局、给焦点，
还回来时把 composer 与它进槽位前那行字一起还回。

**为什么不复用本项目自己的 overlay 面板**（`/model`、`/resume` 那几个用 overlay
复刻 composer 矩形）：inline 要的不只是「一块矩形」。扩展自己按 `tui.terminal.rows`
算行预算、自己决定折叠、还要把对话区留在上面 —— 那只能由布局**真的把那一格换掉**
才能得到。

## 八个文件

| 文件 | 干什么 |
| --- | --- |
| `packages/core/src/extension-host.ts` | 装扩展：解包路径、`loadExtensions`、runner 绑定、工具适配 |
| `packages/core/src/extension-ui.ts` | `ctx.ui`：`custom()`（overlay / inline）、`setWidget`、`setStatus`、`getToolsExpanded` / `setToolsExpanded`、`setTitle` / `setEditorText`、`theme`、`notify`、raw input |
| `packages/core/src/extension-tools.ts` | pi `ToolDefinition` → 本项目 `AgentTool`；工具集读/写 |
| `packages/core/src/extension-models.ts` | `ctx.modelRegistry`：官方的 `ModelRegistry` 门面 |
| `packages/core/src/extension-sessions.ts` | `ctx.sessionManager`：四个只读成员，数据源是 `state.messages`（`getSessionFile` 读落盘器） |
| `packages/core/src/extension-commands.ts` | 斜杠命令与快捷键（内置键优先） |
| `packages/core/src/extension-prompt.ts` | `before_agent_start` 的接线、**段补丁**与两条守卫 |
| `packages/core/src/prompt-head.ts` | 请求 head（prompt + 初始工具声明）与「当前生效 sections」的回放 |
| `test/extension-*.test.ts` | 真扩展 + 探针 + 模拟按键（四个文件；`extension-lifecycle.test.ts` 盖本地发现与生命周期事件） |

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

这个测试**故意用真配置家目录**（`test-support/isolated-home.ts` 平时把 `PI_CODING_AGENT_DIR`
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
