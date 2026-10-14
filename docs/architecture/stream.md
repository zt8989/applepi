# 会话流（从轨迹派生）

## 一句话

界面看到的**时间线**（对话消息 + 错误 / 配置切换 / 压缩这些提示）**从轨迹树派生**，
一份逻辑两个界面共用。`state.messages` 只是「发给模型的那份历史」，不再是界面的真相；
pi 的会话文件（`sessions/`）只用于与 pi 互通。

## 为什么要派生

以前「这场对话发生过什么」有两个来源，都不适合当真相：

| 来源 | 问题 |
| --- | --- |
| `state.messages` | 会被**上下文压缩**整段替换、被**恢复历史**整批重灌，中途的 system 声明也混在里面 |
| 界面自己记的临时提示 | TUI 的 `statusCards`、WebUI 的顶部提示条 —— 不持久、两个界面各记一份 |

后果是具体的：

- **错误会消失**。TUI 那行错误来自 `state.error`，而 `user.message` / `step.start` 都会把它
  清成 `null` —— 用户重新发一句话，刚才那次超时就从屏幕上没了（轨迹里的 `error` 节点
  其实一直留着，只是没人渲染它）。
- **配置切换在 WebUI 里没有反馈**。TUI 靠 `notify()` 插一张卡，而 WebUI 根本没接这条线。
- **同一个事实两个界面说法不同**。

轨迹树才是「一次尝试一节点、只追加不改写」的那份历史，而且**落盘 / 回放 / 恢复都是它**。
所以时间线从它派生。

## 派生规则（`packages/core/src/stream.ts`）

`deriveStream(tree, fallbackMessages?)` 按 `tree.order`（= 发生顺序）走一遍，
每个节点最多产出一条条目：

| 节点 | 条目 |
| --- | --- |
| `user` / `llm.result` / `tool.result` / `prompt.segment` | `message`（节点自己带的 pi 消息） |
| 工具失败的 `error`（带 message） | `message`（那条 `isError` 的 toolResult） |
| LLM 失败的 `error` / `stop` | `notice`（红 / 黄 / 灰） |
| `model.init`（且换了模型 / 档位） | `notice`（配置切换） |
| `compact` | `notice`（压缩） |
| 容器（`turn.*` / `step.*`）与 `tool.call` | 不产出（工具调用在助手消息里，结果由 toolResult 出） |
| `prompt.base` / `prompt.tools` / `prompt.skills` | 不产出（是上下文装载，不是对话） |

`notice` 带 `tone`（`error` / `warn` / `info` / `config`）、`title`、`detail`，两个界面各自上色。
`tone` 由 `meta.cause` 推：**用户自己按的停止是灰的**（不是故障），撞轮数上限是黄的，其余是红的。

## 消息挂在轨迹节点上

派生的消息**来自节点自己带的 pi 消息**（`TraceNode.message`），不是回头去读 `state.messages`。
不这样做的后果：界面的顺序与内容会与轨迹分家，而「以轨迹为基准」就只是句口号。

节点带的是**整份 pi 消息**，所以下面这些一个都不丢：

- 用户消息的**图片 / 附件**（content 块）；
- 助手消息的**思考块**与 toolCall 块；
- toolResult 的 `details`（edit 的彩色 diff、write 的文件内容…）。

`model.init` 节点上还多一个 `meta.changed = '1'`：只有**用户真的切换过**才留配置提示；
开场装载那一版不打（它不是「切换」，出现在对话开头只是噪声）。

## 旧轨迹的退路

`TraceNode.message` 是新加的字段。旧轨迹文件里消息单独落在 `op:'message'` 行、节点上没有它。
这时 `deriveStream` **整体退回**调用方给的 `fallbackMessages`（内核从会话文件读回来的那份），
行为与改动前一致；同时仍从节点里派生提示 —— 不然恢复一个旧会话就再也看不到当时的失败了。

判据是「**所有**会产生消息的节点都带了 message 吗」：混合状态（一半有一半没有）
也整体退回 —— 半份派生出来的时间线比不派生更误导。

## 两个界面怎么用

### TUI（`packages/tui/src/app.ts`）

- `sessionEntries(state)` 从 trace 派生（按 tree / messages 的**引用**缓存：流式 token 只改
  `streamingText`，两个引用都不变，所以那几百帧全部命中缓存，不付 O(节点数) 的钱）。
- 消息条目喂 `TranscriptChunks` 当 `blocks`；提示条目经 `traceNoticeCards()` 转成
  「钉进对话流」的卡（与命令反馈卡同一套锚点渲染）。
- **`renderTail` 删了**：错误不再靠 `state.error` 那一行，而是轨迹派生的卡 —— 所以它不再
  随重发消失。
- 换模型 / 换档位的**当场 `notify()` 也删了**：配置提示由轨迹派生统一给（否则同一个动作会
  显示两遍）。底栏仍立刻跟着变。

### WebUI（`packages/tui/src/web/bridge.ts` + `packages/webui/src/main.ts`）

- bridge 的 `snapshot()` 用 `deriveStream` 组 `messages`：真消息原样，提示转成一条
  **合成消息**（role = `STREAM_NOTICE_ROLE`，即 `'ela-notice'`）。
- 浏览器侧 `registerMessageRenderer(STREAM_NOTICE_ROLE, …)` 把这个 role 画成一张卡。
  pi-web-ui 的 `MessageList` 对每个消息先试 `renderMessage(role)` —— 命中就渲染它，
  于是提示**真的在聊天流里**，位置也对。不注册的话那个 role 会被当成未知消息跳过。
- 合成消息只活在**线协议**上：内核的 `messages` 一个字节不动，更不会发给模型。

## 一个副作用：压缩后不再「凭空少消息」

界面既然以轨迹为基准，压缩就只影响**发给模型的上下文**（`state.messages`），
不再让屏幕上的旧消息消失。压缩本身作为一条 `compact` 提示出现在对话流里 ——
「模型忘了什么」与「我还能看到什么」是两件事，现在分得开。

## 相关

- 节点模型与落盘 → [trace](trace.md)
- 界面怎么读状态 → [surfaces](surfaces.md)
- 浏览器界面 → [webui](webui.md)
