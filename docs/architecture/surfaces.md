# 渲染层

内核只有一份（见 [kernel](kernel.md)）。这一篇讲界面怎么读状态、怎么发消息，
以及踩过的坑 —— 那些坑的**原因**留在代码注释里，这里只记「有什么、为什么这么绕」。

## TUI（pi-tui）

`src/tui.ts`（入口）+ `src/tui/app.ts`（界面）。

直接订阅 `kernel.store`，没有中间层。

| 部件 | 是什么 |
| --- | --- |
| 顶栏 | 轨迹统计（节点数 / 轮数 / 重试 / 错误）—— **刻意精简** |
| 对话区 | 官方组件渲染的用户消息、助手回答、思考、工具块、正在流式生成的那一段 |
| 轨迹面板 | `Ctrl+T` 切换，展开是 `renderColoredTree()` |
| 编辑器 | pi-tui 的 `Editor`（多行、slash 命令补全、文件路径补全） |
| Loader | 生成中动画 |
| 底栏 | 左边 cwd (+git 分支)，右边 `(provider) model` |

按键：`Ctrl+T` 切换轨迹面板，`Ctrl+O` 展开/收起工具输出，`Ctrl+C` 在环跑时中断这一轮、
空闲时退出。

### 布局与对话样式都是照抄 pi 的

整体形状照着 pi 的终端界面排（对比过它的截图）：顶栏只放与对话相关的统计，模型与
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

### 为什么不自己画这四种样式

自己照着截图重画过一次，结果每个工具的折叠策略、底色边界都对不齐：

- bash 折叠**保留尾部** 5 行（头部是命令，尾部才是报错），read/write 保留**头部** 10 行
- write 的块里是**文件内容**而不是工具输出
- edit 渲染**彩色 diff**（`details.diff` 是 pi 的展示用格式：`-1 原行` / `+1 新行` / ` 2 上下文`，
  不是 unified patch）
- 每块用 `Box` 把底色补到整行（宽度差一列底色就断一截）

这些各自都不难，但**一起对**才和截图一致。用官方组件后形状逐行相同。

### 主题：必须显式选 dark/light

`src/tui/theme.ts`。pi 的 `theme` 是个 globalThis 上的 Proxy，**没 `initTheme()` 时读它任何
属性都抛**。而光 `initTheme()`（不带名字）拿到的是 `system` 主题 —— 它在终端没上报颜色时
渲染成灰度：实测 `toolSuccessBg` 解析成 `rgb(0,0,0)`，于是「工具块有底色」**静默失效**。

所以走 `settings.json` 的 `theme` 键（与 pi 同一个配置、同一个键名），用 pi 自己的
`resolveThemeSetting()` 解析，并**排除 `system`** —— 显式落到 dark/light 才有确定的底色。
没配就跟随 `getTerminalTheme()`：写死 dark 会让浅色终端的用户看到一堆看不清的深色块。

底色与文字颜色走 pi-tui 的 `foregroundAnsi`/`backgroundAnsi`（按终端能力降级真彩 → 256 → 16），
但**斜体走 chalk** —— chalk 看 `chalk.level`，非 TTY 下是 0，`theme.italic()` 会直接返回
原文。这在测试里尤其误导（真终端明明是斜的），所以 `test/isolated-home.ts` 在 chalk 加载前
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

输出前**必须 `stripTerminalSequences()`**：官方渲染器给文件路径加 OSC 8 超链接
（`renderToolPath` → `linkPath`），而管道里那些 `]8;;file:///…\…]8;;` 是肉眼可见的乱码。
OSC 133 区域标记也被一并剥掉。

## 相关

- 内核装配 → [kernel](kernel.md)
- 恢复历史（零 token）→ [sessions](sessions.md)
