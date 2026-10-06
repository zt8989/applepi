# 渲染层

内核只有一份（见 [kernel](kernel.md)）。这一篇讲界面怎么读状态、怎么发消息，
以及踩过的坑 —— 那些坑的**原因**留在代码注释里，这里只记「有什么、为什么这么绕」。

## TUI（pi-tui）

`src/tui.ts`（入口）+ `src/tui/app.ts`（界面）。

直接订阅 `kernel.store`，没有中间层。

| 部件 | 是什么 |
| --- | --- |
| 顶栏 | 轨迹统计（节点数 / 轮数 / 重试 / 错误）—— **刻意精简** |
| 对话区 | 用户消息、助手回答、工具块、正在流式生成的那一段 |
| 轨迹面板 | `Ctrl+T` 切换，展开是 `renderColoredTree()` |
| 编辑器 | pi-tui 的 `Editor`（多行、slash 命令补全、文件路径补全） |
| Loader | 生成中动画 |
| 底栏 | 左边 cwd (+git 分支)，右边 `(provider) model` |

按键：`Ctrl+T` 切换轨迹面板，`Ctrl+O` 展开/收起工具输出，`Ctrl+C` 在环跑时中断这一轮、
空闲时退出。

### 布局是照抄 pi 的

整体形状照着 pi 的终端界面排（对比过它的截图）：顶栏只放与对话相关的统计，模型与
工作目录挪到底栏，工具调用渲染成**带底色的整块**而不是一行。

三处具体做法：

- **两栏底栏**用 pi-tui 的 `visibleWidth` 对齐，不用 `stripAnsi().length` —— 后者把
  汉字当一列，右栏一多中文就盖到左栏上。
- **工具块的底色**用 `backgroundAnsi()` + `rgbColor()`，让 pi-tui 按终端能力降级
  （真彩 → 256 色 → 16 色）。写死 ANSI 色号在不支持的终端上会出难看的色块。
- **长输出折叠**成 `... (N earlier lines, ctrl+o to expand)`，与 pi 同形。早先是硬截
  200 字加 `…`，用户既不知道后面被截了、也不知道能不能展开。

### 为什么不用 pi 自己的 InteractiveMode

它从主入口导出、能 import，但构造签名是 `constructor(runtimeHost: AgentSessionRuntime)`，
而 `AgentSessionRuntime` 是**类**，要真实的 `AgentSession` + `AgentSessionServices`。
实测它会摸 75 个 `settingsManager` 成员与 67 个 `session` 成员（settings 就有 128 个
方法），逐个补齐是重新实现 pi 的应用层。

而 `pi-open-tui` 那个增强插件依赖 `pi.getCommands()` / `ExtensionContext` / pi 的
transcript 容器 —— 也就是那套骨架，在当前架构下跑不起来。要跑它就得放弃自己的环
（连带轨迹树）。所以这里只借**样式层**（pi-tui 组件库 + 布局形状），不接它的架构。

### pi-tui 1.x 的两个变化

- **`TUI` 从类变成了接口。** 实例化要选渲染器：`new TuiMainScreen(terminal)`。
  选它是因为它让终端自己管回滚 —— 对话越积越长，向上翻能看到历史。
  另一个是 `TuiAltScreen`（占满视口、滚动自己管）。
- **`TuiInputListener` 是具名类型**，回调参数不再从上下文推断，要显式标出来。

### 一次性模式

`-p "问题"` 不走界面：pi-tui 的差分渲染在非交互终端里只会留下一堆转义序列。
所以直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。

`renderTranscript(state, from, width, expanded)` 的 `width` 传 0 表示不限宽（不截断、
不铺底色）—— 一次性模式没有终端尺寸，截断会把工具输出吃掉。

## 相关

- 内核装配 → [kernel](kernel.md)
- 恢复历史（零 token）→ [sessions](sessions.md)
