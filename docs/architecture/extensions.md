# 扩展

本项目能装 **pi 扩展**（`settings.json` 的 `packages`），装上来的工具与 prompt 片段
在**装载时**并进内核。

接了两个：

| 包 | 给模型什么 |
| --- | --- |
| `@juicesharp/rpiv-ask-user-question` | 结构化多选对话框（多问题 tab、notes、`preview` 侧栏、折叠） |
| `pi-web-access` | web 搜索 / 抓取 / PDF 提取 / GitHub / 视频理解（5 个工具） |

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

## 第二个扩展要到的另两样

`pi-web-access` 比第一个重得多（110 个源文件、209 个依赖、编译成 1MB bundle），而且
要了第一样**没要过**的东西。

### `pi.getAllTools()`：得给真的

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

| 扩展 | 工具 | UI | 命令/快捷键 |
| --- | --- | --- | --- |
| `rpiv-ask-user-question` | ✅ | ✅ `ui.custom()` overlay | — |
| `pi-web-access` | ✅ | — | ❌ 明说不接 |

## 五个文件

| 文件 | 干什么 |
| --- | --- |
| `src/extension-host.ts` | 装扩展：解包路径、`loadExtensions`、runner 绑定、工具适配 |
| `src/extension-ui.ts` | `ctx.ui`：`custom()` 的 overlay 宿主、`notify`、raw input |
| `src/extension-tools.ts` | pi `ToolDefinition` → 本项目 `AgentTool`；工具集读/写 |
| `src/extension-prompt.ts` | `before_agent_start` 的接线与两条守卫 |
| `test/extension-host.test.ts` | 用**真扩展**测（见下） |

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
断言结果里**不出现** `unavailable` 与 `still inactive`。那正是两个真实回归。

## 相关

- 工具与那层适配 → [tools](tools.md)
- 界面与 overlay → [surfaces](surfaces.md)
- 装载（prompt / tools / skills） → [init](init.md)
- 配置家目录与共用配置 → [sessions](sessions.md)
