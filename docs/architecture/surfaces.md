# 渲染层

内核只有一份（见 [kernel](kernel.md)）。这一篇讲界面怎么读状态、怎么发消息，
以及踩过的坑 —— 那些坑的**原因**留在代码注释里，这里只记「有什么、为什么这么绕」。

## TUI（pi-tui）

`src/tui.ts`（入口）+ `src/tui/app.ts`（界面）。

直接订阅 `kernel.store`，没有中间层。

| 部件 | 是什么 |
| --- | --- |
| 顶栏 | 模型 / 轮数 / 花费 / 轨迹统计 |
| 对话区 | 用户消息、助手回答、工具结果、正在流式生成的那一段 |
| 轨迹面板 | `Ctrl+T` 切换，展开是 `renderColoredTree()` |
| 编辑器 | pi-tui 的 `Editor`（多行、slash 命令补全、文件路径补全） |
| Loader | 生成中动画 |

按键：`Ctrl+T` 切换轨迹面板，`Ctrl+C` 在环跑时中断这一轮、空闲时退出。

### pi-tui 1.x 的两个变化

- **`TUI` 从类变成了接口。** 实例化要选渲染器：`new TuiMainScreen(terminal)`。
  选它是因为它让终端自己管回滚 —— 对话越积越长，向上翻能看到历史。
  另一个是 `TuiAltScreen`（占满视口、滚动自己管）。
- **`TuiInputListener` 是具名类型**，回调参数不再从上下文推断，要显式标出来。

### 一次性模式

`-p "问题"` 不走界面：pi-tui 的差分渲染在非交互终端里只会留下一堆转义序列。
所以直接跑环，然后把**纯文本**的对话与轨迹树打到 stdout。

## 相关

- 内核装配 → [kernel](kernel.md)
- 恢复历史（零 token）→ [sessions](sessions.md)
