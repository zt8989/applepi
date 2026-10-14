# 渲染层

内核只有一份（见 [kernel](kernel.md)）。这一篇讲界面怎么读状态、怎么发消息，
以及踩过的坑 —— 那些坑的**原因**留在代码注释里，这里只记「有什么、为什么这么绕」。

## TUI（pi-tui）

`packages/tui/src/main.ts`（入口）+ `packages/tui/src/app.ts`（界面）。

直接订阅 `kernel.store`，没有中间层。

| 部件 | 是什么 |
| --- | --- |
| 顶行 | 页签 + 轨迹统计**合一行**（见下） |
| 对话页 | `TranscriptChunks`：每条消息一个官方组件，内容没变就不重算（见下） |
| 轨迹页 | `Ctrl+R`（`app.trace.toggle`）切换，展开是 `renderColoredTree()` |
| 编辑器 | pi 的 `CustomEditor`（多行、slash 命令补全；**工作状态画在上框线里**，见下） |
| 底栏 | 左边 cwd (+git 分支)，右边 `(provider) model` + token 用量 |

按键（**键名都从键位表解析**，见下节）：`Ctrl+R` 切轨迹页，`Ctrl+O` 展开/收起工具输出，
`Ctrl+T` 展开/收起思考块（pi 的 `app.thinking.toggle`，与 pi 同 id），
`Ctrl+C` 清空编辑器（连按两次退出），**中断是 `Escape`**（pi 的 `app.interrupt`）。
完整的一份在 `/hotkeys` 里。

### 往上翻之后压一条「回到最新」的提示（与 pi 同句）

对话区与轨迹页的 `ScrollView` 都是 `follow: 'end'`：新内容往下追加、视口自动贴底。
但用户往上翻之后 `follow` 让位，**视口停在历史里** —— 新消息还在下面长出来，屏幕上却
没有任何东西说「下面还有」。

`TuiAltScreen` 的 `scrollToEndIndicator` 选项就是补这个：视口离开末尾时，在**最后一行**
居中压一条可点的提示条（点它回到底部的鼠标处理在 pi-tui 里）。文案由
`jumpToLatestHint()` 给：

```
↓ Jump to latest message · Ctrl+End
```

三个要点：

- **与 pi 逐字同句**（`createInteractiveTui()` 里那一句），不翻成中文 —— 与命令反馈卡
  同一个取舍：同一个动作在两个应用里说的得是同一句话。
- **键名走 `keyLabel('tui.altScreen.bottom')`**，不手写 `Ctrl+End`。用户在
  `~/.pi/agent/keybindings.json` 里改了这个键，提示跟着变（pi 走 `keyDisplayText()`，
  同一套）。
- **只在 primary 那个 ScrollView 上画**（pi-tui 的行为）。本项目切页时重建 ScrollView
  并让当前页当 primary（见 `applyLayout`），所以两个页各自管各自的那条提示，不需要
  在回调里判当前在哪一页。

`packages/tui/test/tui-render.test.ts` 钉的是「同句 + 键名跟着改键走」这两条 —— 缺了它的症状不是抛错，
而是「流式生成时按什么都不动」，而 `Ctrl+End` 这个键本身也就只有这条提示会讲。

### composer 与 pi 一致：横线颜色 + 状态画在上框线

composer 是 pi 的 `CustomEditor`（`embedWorkingStatus: true`），配色是 pi 的
`getEditorTheme()` —— 不是自己手写一份。两个具体后果：

**1. 横线颜色跟主题/思考级别走。** pi 的 composer 横线是
`theme.getThinkingBorderColor(level)`（默认级别 `off` → 主题 token `thinkingOff`），
`refresh()` 每帧按 `state.thinkingLevel` 设一次。早先手写成 `(s) => dim(s)` ——
那是**文本属性**（`\x1b[2m`，变淡）而不是颜色 token，在浅色终端上与 pi 不一致。

**2. 工作状态画在**上框线**里**（不另占一行）：

```
── ⠋ 思考中… ─────────────────────────────────────────────
── ⠋ ↻ 正在重试（第 2/2 次尝试） ─────────────────────────
```

三个状态（思考 / 压缩 / 重试）由纯函数 `workingStatusText(state)` **从 state 现推**，
优先级 重试 > 压缩 > 生成。早先是一个单独的 loader 行加一个 `lastLoaderMessage` 变量
手工收尾（三处各自记得停动画），漏一处的症状是「圈一直转」；现推就没有这笔账。
重试那句也因此从 `renderTail`（对话区尾巴）搬到了这里 —— 放两处就是同一件事报两遍。

状态文字的颜色跟**边框自己的颜色**走（`(text) => editor.borderColor(text)`）—— 与 pi
嵌入时的做法一致；写死 `accent` 的话，边框随思考级别变色时会像两套东西拼在一起。

### 顶行是**两职合一**的（`tabLine`）

```
对话 │ 轨迹 3轮2步  工具5  重试1  错误1 (Ctrl+R)
```

早先是**两行**：顶栏报统计、下面一行页签。两行讲的是同一件事（「我在哪页 / 这轮跑到哪了」），
纵向白占一行，而界面真正缺的是对话的高度。合成一行后，那行要么讲页签要么讲统计，不讲别的。

统计怎么精简的：

- **`x轮x步` 一个就够** —— `回合 3 · 步 8` 与 `3轮8步` 是同一件事，写法不同而已。
  真正需要区分口径的是「工具调用数」（模型自己发起的动作），那个仍单独报。
- **节点数删掉** —— 它是 `trace.order.length`，开一轮就 +5，跳得又快又不 actionable；
  要看节点数切到轨迹页（那里是完整的一棵树）。
- **花费 `$` 删掉** —— 底栏 `statsLine` 里已有一个**同口径**的会话累计 `$`，两个 `$`
  摆在两行里只会让人怀疑「这俩为什么不一样」。
- 工具/重试/错误都是 **0 就不出现**（`0轮0步` 是噪声）。

统计**始终显示**（不管在对话页还是轨迹页）：这轮跑到哪了是「读对话」时就想要的信息，
不该逼用户切页才看得到。

这一行还必须**补到终端全宽**：pi-tui 是增量重绘，只重画变化的行，而这一行的长度随统计
变化（`3轮2步` → `3轮3步`），不补齐的话旧内容的尾巴不会被擦掉，下一帧会叠着出现 ——
看起来像「重复刷屏」。补齐按**可见列宽**算（`visibleWidth`）而不是字符数，**汉字是双宽**。

### 布局与对话样式都是照抄 pi 的

整体形状照着 pi 的终端界面排（对比过它的截图）：模型与
工作目录挪到底栏，工具调用渲染成**带底色的整块**而不是一行。

**对话区直接用 pi 官方的渲染组件**（`UserMessageComponent` / `AssistantMessageComponent` /
`ToolExecutionComponent` + `create*ToolDefinition()`），而不是自己拼字符串：

| 内容 | 样式 | token |
| --- | --- | --- |
| 用户 | 整块蓝底铺满，**无前缀** | `userMessageBg` = rgb(33,59,73) |
| 助手 | 默认前景色，**无底色无前缀** | `text` |
| 思考 | 灰色**斜体** | `thinkingText` = rgb(150,160,164) + italic |
| 工具成功 | 深绿底块 | `toolSuccessBg` = rgb(37,65,49) |
| 工具失败 | 暗红底块 | `toolErrorBg` = rgb(91,40,42) |
| 路径 | 淡紫 | `accent` = rgb(167,152,215) |
| diff | 增绿/删红 | `toolDiffAdded` / `toolDiffRemoved` |

不加「你 ›」「助手 ›」这类角色前缀：pi 没有，角色靠**底色与字体形状**区分。
加了之后用户那块蓝底变成「`你 ›` + 白字」，而思考的斜体也挤不出来了。

### 对话区是增量渲染的（`TranscriptChunks`）

**每条消息一个组件**，而不是「整段对话一个 `Text`」。

这不是一开始就对的。原来的形状是每次状态变化都把整段对话重新渲染成一个字符串，
再让 `Text.render()` 折行。而流式 token 每来一个就触发一次 `store.subscribe` →
`refresh()`，于是每帧都要：重建 N 个官方组件（Markdown 解析、diff、底色）+
重新折行 14890 行 / 1.9MB 文本。实测 1208 条消息的真实会话：

| | 每帧 |
| --- | --- |
| 整段重算 | 661 ms |
| 分块 + 缓存 | **2.5 ms** |

pi-tui 的 `MIN_RENDER_INTERVAL_MS` 是 16ms —— 每帧 1.2 秒时渲染永远追不上流式速度，
界面直接卡死。症状是「越长的会话越卡」，因为成本与消息条数成正比。

分成三处缓存：

1. **每条消息一个 `Text`**，下标与**轨迹派生的消息**一一对应（见 [stream](stream.md)）。`Text` 自己缓存
   `render()` 的结果，只在 `setText()` 时失效，所以历史块在后续帧里直接命中。
2. **渲染结果再缓存一层**（`WeakMap<message, Map<`${width}:${expanded}`, lines>>`）——
   连折行都不用重做。键里带宽度与折叠状态，因为这两者都会改变渲染结果。
3. **尾部独立的几块**（状态卡 / 键位表 / 流式那段）。流式只碰中间那个。
   状态卡与键位表都**钉在当时的消息边界**上（各自的锚点 `at`），所以新消息排在它们
   下面、把它们往上顶 —— 形状与 pi 的 `chatContainer.addChild` 一致。
   状态卡有**两种来源**：命令反馈（`notify()`）与**轨迹派生的提示**（错误 / 配置切换 /
   压缩，见 [stream](stream.md)）—— 两者同一套锚点渲染。

三条不能省的细节：

- **缓存用 `WeakMap`**，键是消息对象 —— `/new` 之后旧消息才能被回收。用 `Map` 的话
  整段历史会一直被钉在内存里。
- **`render()` 的宽度以 `update()` 为准**，不是参数里的 `width`。块里的行是按
  `update()` 时的宽度渲染的（官方组件已经折行、铺好底色、补齐到全宽），拿另一个宽度
  去 `render()` 会把按 40 列排好的行再折一次 —— 行数凭空翻倍（实测 15 行变 36 行）。
- **`/new` 之后要把多余的块丢掉**，不只是跳过。否则旧消息还画在屏幕上。

这条结构是照抄 pi 官方的：`interactive-mode.js` 里 `chatContainer` 也是每条消息一个
组件，流式那一条原地 `updateContent`。

### 命令反馈卡：照抄 pi 的 `showStatus`

`notify()`（命令结果、切工具折叠…）不再是「贴顶一行、6 秒消失」，而是
**钉进对话流的卡片**，与 pi 的 `showStatus` 同形：

- 卡存在 `statusCards: { text; at }[]` 里，`at` = 显示时的**消息条数**；渲染时按它
  splice 在那条消息边界上。于是新消息排在卡**下面**，卡被往上顶、随会话一起滚。
- **形状与 pi 逐字同形**：卡**上面**一行空行 + 左边一格缩进 —— pi 建的是
  `new Spacer(1)` + `new ThemedText(..., 1, 0)`（空行在上、`paddingX = 1`）。
  早先是「左边不缩、空行加在卡下面」，于是卡贴着左边缘、且与上一行内容之间没有空隙。
- **卡里的文案照 pi 那几句**（它有对应动作的）：`Thinking blocks: hidden|visible`、
  `Tool output: expanded|collapsed`、`Operation aborted` —— 自己写一句更长的中文
  只会让同一个动作在两个应用里说得不一样。
  **换模型 / 换思考级别不在这里 `notify` 了**：那是**配置切换**，作为轨迹派生的提示
  统一给（见 [stream](stream.md)）—— 否则同一个动作会显示两遍。
- **尾部还是这张卡就覆盖**：`notify` 时若 `messages.length` 没变，`at` 相同 →
  就地改 `text`。连续改配置（换模型 → 切思考级别）不会刷屏。
- **中间插过东西就另起一张**：一旦有了新消息，`at` 不再相等 → push 一张新卡，
  旧卡留在历史里。

pi 判定的是「`chatContainer` 末尾两项还是不是自己那对 spacer+text」；这里用
「锚点是否还等于当前消息条数」等价表达同一件事。

`renderTranscript()` 保留着 —— 一次性模式（管道输出）与测试走它，仍然是逐行一致的
（`packages/tui/test/tui-incremental.test.ts` 钉住这一点）。

### 为什么不自己画这四种样式

自己照着截图重画过一次，结果每个工具的折叠策略、底色边界都对不齐：

- bash 折叠**保留尾部** 5 行（头部是命令，尾部才是报错），read/write 保留**头部** 10 行
- write 的块里是**文件内容**而不是工具输出
- edit 渲染**彩色 diff**（`details.diff` 是 pi 的展示用格式：`-1 原行` / `+1 新行` / ` 2 上下文`，
  不是 unified patch）
- 每块用 `Box` 把底色补到整行（宽度差一列底色就断一截）

这些各自都不难，但**一起对**才和截图一致。用官方组件后形状逐行相同。

### 主题：必须显式选 dark/light

`packages/tui/src/theme.ts`。pi 的 `theme` 是个 globalThis 上的 Proxy，**没 `initTheme()` 时读它任何
属性都抛**。而光 `initTheme()`（不带名字）拿到的是 `system` 主题 —— 它在终端没上报颜色时
渲染成灰度：实测 `toolSuccessBg` 解析成 `rgb(0,0,0)`，于是「工具块有底色」**静默失效**。

所以走 `settings.json` 的 `theme` 键（与 pi 同一个配置、同一个键名），用 pi 自己的
`resolveThemeSetting()` 解析，并**排除 `system`** —— 显式落到 dark/light 才有确定的底色。
没配就跟随 `getTerminalTheme()`：写死 dark 会让浅色终端的用户看到一堆看不清的深色块。

底色与文字颜色走 pi-tui 的 `foregroundAnsi`/`backgroundAnsi`（按终端能力降级真彩 → 256 → 16），
但**斜体走 chalk** —— chalk 看 `chalk.level`，非 TTY 下是 0，`theme.italic()` 会直接返回
原文。这在测试里尤其误导（真终端明明是斜的），所以 `test-support/isolated-home.ts` 在 chalk 加载前
设了 `FORCE_COLOR=3`。

### 三处具体做法

- **两栏底栏**用 pi-tui 的 `visibleWidth` 对齐，不用 `stripAnsi().length` —— 后者把
  汉字当一列，右栏一多中文就盖到左栏上。
- **工具渲染器取 `create*ToolDefinition()` 而不是 `createAllToolRenderers()`。** 后者
  返回的表里 `edit` 的 `renderShell` 是 `undefined`，而工具**定义**上是 `"self"`（编辑
  渲染器自己铺底色）。漏掉会让 `edit` 块**底色被套两层** —— 大多数终端上看不出来，
  但浅色/高对比主题下边界会错位。
- **工具标题用英文工具名**（`read` / `$ git status`），不显示中文 label。官方
  `label` 字段本身就是 `"edit"`/`"read"`，我们另起的中文 label 是二次翻译。
- **扩展工具给一个只有 `label` 的兑底定义**（`toolDefinitionFor()`），而不是 `undefined`。
  `ToolExecutionComponent` 拿 `undefined` 时走它自己那条 `formatToolExecution()`：
  工具名 + pretty-print 的 `JSON.stringify(args, null, 2)` + 整段输出 —— 而那条路
  **完全不看 `expanded`**。症状：Ctrl+O 折叠了，内置工具跟着折，`ask_user_question`
  这种扩展工具还是把参数与结果全铺开。

  pi 那边扩展工具**是有定义的**（注册时那份 `{ label, description, parameters }`，不带
  `renderCall`/`renderResult`），于是走 `createCallFallback()` / `createResultFallback()` ——
  两个都认 `expanded`：折叠时参数是标题行上的 `key=value`（超 100 字截断）、结果只留前
  10 行 + `... (N more lines, Ctrl+O to expand)`；展开时参数逐行 `key: value`、结果给全文。
  分岔点是 `hasRendererDefinition()`（定义存不存在），不是渲染器存不存在 ——
  所以给个 `{ label: name }` 就回到了与 pi 同一条路。
  （`packages/tui/test/tui-render.test.ts` 钉着这一条。）


### 为什么不用 pi 自己的 InteractiveMode

它从主入口导出、能 import，但构造签名是 `constructor(runtimeHost: AgentSessionRuntime)`，
而 `AgentSessionRuntime` 是**类**，要真实的 `AgentSession` + `AgentSessionServices`。
实测它会摸 75 个 `settingsManager` 成员与 67 个 `session` 成员（settings 就有 128 个
方法），逐个补齐是重新实现 pi 的应用层。

而 `pi-open-tui` 那个增强插件依赖 `pi.getCommands()` / `ExtensionContext` / pi 的
transcript 容器 —— 也就是那套骨架，在当前架构下跑不起来。要跑它就得放弃自己的环
（连带轨迹树）。所以这里只借**样式层**（pi-tui 组件库 + pi 官方的对话/工具渲染组件 +
布局形状），不接它的架构。

### pi-tui 1.x 的两个变化

- **`TUI` 从类变成了接口。** 实例化要选渲染器：`new TuiMainScreen(terminal)`。
  选它是因为它让终端自己管回滚 —— 对话越积越长，向上翻能看到历史。
  另一个是 `TuiAltScreen`（占满视口、滚动自己管）。
- **`TuiInputListener` 是具名类型**，回调参数不再从上下文推断，要显式标出来。

### 一次性模式

`-p "问题"` 不走界面：pi-tui 的差分渲染在非交互终端里只会留下一堆转义序列。
所以直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。

`renderTranscript(state, from, width, expanded)` 的 `width` 传 0 表示不限宽（不折行、
不截断）—— 一次性模式没有终端尺寸，猜一个宽度反而会截断内容。

这条路径**不走 `TranscriptChunks`**（没有帧循环，也就没什么可增量的），而且它
**必须**自己补上「正在流式生成的那一段」—— 那段在 `TranscriptChunks` 里是独立的一块，
`renderTail()` 刻意不含它（合成一个就会画两遍）。

输出前**必须 `stripTerminalSequences()`**：官方渲染器给文件路径加 OSC 8 超链接
（`renderToolPath` → `linkPath`），而管道里那些 `]8;;file:///…\…]8;;` 是肉眼可见的乱码。
OSC 133 区域标记也被一并剥掉。

## 两个弹窗都直接用 pi 官方的组件

`/sessions` 用 `SessionSelectorComponent`（见 [sessions](sessions.md)），`/model` 与
`/scoped-models` 用 `ModelSelectorComponent` / `ScopedModelsSelectorComponent`
（`packages/tui/src/model-picker.ts`）。三个都是同一个理由：

| 面板 | 官方组件 | 那一屏要处理的东西 |
| --- | --- | --- |
| `/sessions` | `SessionSelectorComponent` | 树形前缀、分数排序、`re:`/引号查询、异步加载 + `Loading 7/112`、删除确认态、改名子面板 |
| `/model` | `ModelSelectorComponent` | 后台刷目录 + 15s 超时 + 错误分级文案、模糊搜索 + `default` 特例、当前模型置顶排序、`Model Name:` 那行、滚动指示 |
| `/scoped-models` | `ScopedModelsSelectorComponent` | 六个键（save / enableAll / clearAll / toggleProvider / reorderUp / reorderDown）、`null` = 全开的特例、越界不动 |

手写这三块要 550+ 行，而且**必然与上游漂移**。`model-picker.ts` 与
`session-picker.ts` 是**适配层**：喂给官方的形状（`ModelInfo` / `SessionInfo`），
接回调（换模型 / 存默认 / 删会话）。

### 这三个面板**盖住 composer**，不是居中的弹窗（`packages/tui/src/composer-overlay.ts`）

pi 里这几个面板根本不是弹窗：`interactive-mode.js` 的 `showSelector()` 把 composer
那一格（`editorContainer`）的**内容整个换掉** —— `clear()` 之后 `addChild(selector)`，
关掉时再换回 `editor`。于是面板天然是 composer 的宽度，它的底边**就是** composer 的
底边。用户按 Ctrl+L 看到的是「输入框那块变成了列表」。

本项目那阵子没有可换内容的 `editorContainer`，所以用覆盖层**复刻同一个矩形**：

> **补充（扩展的 inline `custom()` 之后）**：后来真给了「输入区槽位」
> （`packages/tui/src/app.ts` 的 `mountEditorSlot`，见 [extensions](extensions.md) 的「折叠」一节），
> 这三个面板**没有**跟着搬过去 —— 不是做不到，是它们不需要：面板要的正是「盖住
> composer 那个矩形」，而 overlay 参数已经把它钉死了（下面那些几何断言就是钉它的）；
> 搬进槽位反而要自己多管一套焦点与「还回 composer」，而面板的键位与焦点现在由官方
> 组件管着。什么时候值得搬：哪天要让对话区在面板打开时**继续可见、继续滚** ——
> overlay 是全遮挡语义，槽位才不是。

```ts
{ anchor: 'bottom-center', width: '100%', margin: { bottom: COMPOSER_BOTTOM_MARGIN } }
```

- **满宽**（`'100%'`，不是 `'90%'`）—— 早期三处各写各的（居中 + 90% + 各自的
  `maxHeight`），症状是「面板飘在屏幕中间、左右还露着别的画面」，与 pi 不一致。
- **底边对齐**：`margin.bottom` = composer 距屏幕底的行数 = 它下面那几格的高度
  （当前是底栏两行）。所以 `composer-overlay.ts` 的 `FOOTER_ROWS` 与 `app.ts` 布局里
  footer 的 `basis` **必须是同一个来源** —— 各写一个数字，底栏一改面板就悬空。
- **不给 `maxHeight`**：pi-tui 对它的处理是 `overlayLines.slice(0, maxHeight)` ——
  **从尾部切**，切掉的正是 `Model Name:` 下面的后台刷新状态与那行按键提示。早先为此把
  比例调到 80% 去躲切片，但那是拿终端高度硬凑；现在让面板按内容自然展开。

面板的框线与配色**全部来自 pi 的主题**（官方 `DynamicBorder` 走
`theme.fg('accent', …)`），本项目一行颜色都不写 —— 写死的色值在浅色终端上会变成
黑底黑字（见 [theme.ts](../../../packages/tui/src/theme.ts) 文件头）。
`packages/tui/test/tui-startup.test.ts` 里那三条几何断言（底边对齐 / 顶框满宽 / composer 框线
不残留）就是钉这件事的：它们**先把差分重绘重放成屏幕网格**再断言绝对行列 ——
「词在不在」那类断言对「飘在中间的弹窗」同样会通过。

### 「那一行按键提示在」就是 keybindings 装上了

三个面板的提示行都是用 `keyDisplayText('app.models.save')` 之类渲染的，而
`app.*` 是 **pi 应用层**的键位 —— 不把含它们的键位表装到 pi-tui 全局
（`setKeybindings`）的话它们解析不出键名，于是**整行字消失**。

症状值得记住：不是「按了没反应」，而是「面板上根本没写有这个键」—— 后者更容易被
当成「这个版本没有这个功能」。`tui-startup.test.ts` 里那三条断言盯的就是这个：
提示行**在**，就等于 `Ctrl+S` / `Ctrl+A` / `Ctrl+E` 认得。

### 键位表只有一处（`packages/tui/src/keybindings.ts`）

    defs = { ...pi 的 KEYBINDINGS, ...本项目的 PROJECT_KEYBINDINGS }

- **键名解析只有一个来源**：顶行的 `(Ctrl+R)`、面板底部的提示行、`/hotkeys` 的表、
  `--help` 的那几行，全部走 `keyLabel(action)` → `keyDisplayText()`。手写键名的地方
  一律是 bug —— 用户改了 `~/.pi/agent/keybindings.json` 之后它会开始骗人，而只有改了
  键的那个人自己能发现。
- **判断按键也走键位表**（`actionMatches(data, action)`），不写 `matchesKey(data, 'ctrl+o')`。
  理由同上：`keybindings.json` 里的覆盖要真的生效。
- **能用 pi 的 id 就用 pi 的**：展开工具输出 = `app.tools.expand`（ctrl+o）、
  打开模型面板 = `app.model.select`（ctrl+l）。同一个 id 意味着同一份
  `keybindings.json` 在 pi 与本项目里同时生效。本项目独有的只有三个：
  `app.trace.toggle`（ctrl+r）、`app.queue.cycle`（ctrl+q）、`app.abort`（ctrl+c）。
- **`ctrl+t` 让给 pi**：那是 pi 的 `app.thinking.toggle`。两边共用一份键位文件，
  同一个键两个含义时，写覆盖的人没法表达「我想要哪个」—— 所以轨迹页改用 `ctrl+r`。
- **只有一处创建**。早先 `model-picker.ts` / `session-picker.ts` 各自
  `KeybindingsManager.create()`，那份**不含**本项目的动作 —— 症状是「打开过一次面板
  之后，顶行那块 `(Ctrl+R)` 变成 `()`」。

### `/hotkeys` 与 pi 同形

分节（Navigation / Editing / Other / Extensions）、Markdown 表格、上下边框、标题
`Keyboard Shortcuts` 都照抄 pi 的 `handleHotkeysCommand()`，并贴在这轮对话**之后**
（pi 也是 append 进对话区，不是弹面板）。与 pi 的唯一差别是**不列本项目没实现的动作** ——
照抄 pi 的表会得到一份「按了没反应」的说明书。

### 换模型要**真换**（与 `/sessions` 那一处最大的不同）

面板选完不能只 `showStatus()` —— 那是 pi 能这么干的原因：它有 `session.setModel()`。
本项目状态**只能由 action 改**，所以换模型是 `kernel.setModel()`：它 dispatch
`model.changed`（能力与窗口随模型变，与 `model.init` 同一套参数），并且**先查模型存在再 dispatch** ——
查不到就返回 `false`、状态原封不动。

关键的一环在 `store.ts`：effect 表的 `resolveModel` 让模型**每次请求现取**。
没有它时 effect 表捕获的是建表那一个，于是「底栏换了、轨迹树也换了、实际请求仍发给
旧模型」—— 三个可见证据都说换了。`callLlm` 与 `compactContext` **两条路都要改**，
只改前者的话压缩会静默地用旧模型（那条路平时看不见，效果要到窗口快满才显形）。
`packages/tui/test/model-switch.test.ts` 两条测试各盯一个。

### 降级路径：手写一个最小 `ModelRuntime` 门面

`ModelRuntime.create()` 失败时 `provider.ts` 退回手写装配，`runtime.runtime` 是
`undefined`。官方组件的构造签名要一个真的 `ModelRuntime`，硬传 `undefined` 会在
`getAvailableSnapshot()` 那一行就崩 —— 症状是「按 `/model` 什么都不发生」。

`model-picker.ts` 的 `fallbackModelRuntime()` 给一个**只实现组件用到的那几个方法**的
门面，模型列表来自 `models.getModels()`。它的 `refresh()` 直接抛，于是官方组件把
原因显示成面板里的一行红字、照常能列能搜能选 —— 比「假成功」诚实（假成功会让用户
以为目录已经是新的），也比「面板禁用」好（后者在降级模式下让 `/model` 完全不可用）。

## 相关

- 内核装配 → [kernel](kernel.md)
- 恢复历史（零 token）→ [sessions](sessions.md)
- 工具执行与流式输出 → [tools](tools.md)
