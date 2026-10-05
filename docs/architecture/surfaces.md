# 两个渲染层

内核只有一份（见 [kernel](kernel.md)）。这一篇讲两个界面各自怎么读状态、怎么发消息，
以及各自踩过的坑 —— 那些坑的**原因**留在代码注释里，这里只记「有什么、为什么这么绕」。

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

## Web（pi-web-ui，浏览器）

`web/src/main.ts`（装配）+ `web/src/remote-session.ts`（连接）+ `web/src/trace-panel.ts`（轨迹面板）。

浏览器**不跑环**。它只做三件事：SSE 订阅、POST 发消息、把状态画出来。

```
浏览器                     Node 内核
  │  GET /api/events (SSE)     │
  │◄───────────────────────────┤  状态一变推一帧
  │                            │
  │  POST /api/message         │
  ├───────────────────────────►│  store.dispatch(...) → 环转起来
```

### remote-session 做三件事

1. **SSE → 状态**：订阅 `/api/events`，每帧存进 `snapshot`
2. **状态 → lifecycle 事件**：对比前后两帧（消息数变了没、`streamingText` 变了没），
   合成 pi-web-ui 要的那几种事件
3. **prompt → POST**：把输入发回内核

**第 2 步是最容易做错的地方。** pi-web-ui 的 `subscribe` 回调收的是 **lifecycle 事件**
（`{type: 'message_start'}` 这种），它上来就 `switch (e.type)` —— 发一个「状态变了」的裸回调
会直接 `TypeError: Cannot read properties of undefined (reading 'type')`。

它只认 7 种：`message_start` / `turn_start` / `turn_end` / `agent_start`（重渲染）、
`message_end`（清流式容器）、`agent_end`（收尾）、`message_update`（喂流式容器）。

映射规则：

| 帧的变化 | 发什么 |
| --- | --- |
| 首帧 | `agent_start` |
| 消息数增加 | 每条新消息补一对 `message_start` + `message_end` |
| `streamingText` 变了 | `message_update` |
| `phase` 从非 idle 变 idle | `agent_end` |

### 踩过的坑

四个，都在代码里留了注释。

**`state` 每次都要新对象。** pi-web-ui 按引用判断要不要重渲染。一直返回同一个对象的话，
界面永远不更新。

**`agent-interface` 靠模块副作用注册。** `AgentInterface.js` 末尾那行
`customElements.define("agent-interface", ...)` 是副作用 —— 我们只 `import` 它做类型 cast 和
`document.createElement`，bundler 完全可能判定「这个 import 没被真正用到」而整段 tree-shake 掉。
结果：页面渲染出 `<agent-interface>` 标签，但它从没被 define 升级，既没有内容也没有输入框，
控制台还静悄悄的。`web/src/ensure-elements.ts` 显式 `new` 一个实例并摸一个属性，
把引用「用掉」，让 bundler 没理由丢掉这个模块。

**别在订阅回调里调 `chat.requestUpdate()`。** 自定义元素在 define 完成前没有这个方法，
而 `subscribe` 会在订阅那一刻**同步**回调一次 —— 拿到的是个还没升级的空标签。pi-web-ui 自己
会处理重渲染，订阅回调里只管更新顶栏。

**`setAppStorage()` 必须调，且 key 检查要骗过去。**
`sendMessage()` 第一件事是 `getAppStorage()`，不调就抛。之后它还会查 `providerKeys`，
查不到就调 `onApiKeyRequired` 弹 key 对话框 —— demo 模式压根不需要 key，却会被弹窗挡住，
消息根本发不出去。办法是给服务端报的每个 provider 塞一个占位 key：真正的鉴权在 Node 侧从
环境变量读，这个值只是用来骗过前端的「有没有 key」检查，不会离开浏览器。

### 轨迹面板

底部一条可折叠的「轨迹」栏，展开是 `renderTree()` 的输出，逐行按节点状态上色
（失败红字、成功绿、pending 黄）。和 TUI 共用 `src/trace.ts` 的同一个 `renderTree`。

## 静态文件

`npm run serve` 同时提供 `web/dist`。`GET /` 返回 `index.html`；没有就只服务 `/api`
（404 会写明该先跑什么命令）。

目录穿越防护：路径 `path.resolve` 之后必须仍在 `webRoot` 之内，否则 404。
