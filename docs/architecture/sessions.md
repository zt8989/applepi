# 会话与恢复

## 两份记录，不是一份

内核同时写两份东西，位置不同、用途不同：

| | `sessions/<cwd>/<id>.jsonl` | `traces/<id>.jsonl` |
| --- | --- | --- |
| 记什么 | 消息流（user / assistant / toolResult） | 一次尝试一节点（含失败、超时、重试） |
| 回答什么问题 | 「上次聊到哪了」 | 「为什么这次慢 / 错了」 |
| 恢复成什么 | `messages`（可以接着聊） | 轨迹树（只能看） |
| 谁写 | `session-recorder.ts` | `trace-store.ts` |

**为什么不是一份**：轨迹有节点但没有完整消息正文（错误节点的 detail 是错误信息），
会话有消息但没有 attempt 的时间线。想从一份推导出另一份，都要丢东西。

两者都是 store 订阅器（不是 effect 表里的 Cmd）—— 挂在 dispatch 链上，成功失败都记。

## 家目录

全部全局状态在 `~/.redux-agent/`（`REDUX_AGENT_DIR` 可搬家）：

```text
~/.redux-agent/
  models.json                     provider / 模型目录
  auth.json                       凭证
  settings.json                   默认 provider / model / thinkingLevel
  sessions/--<cwd 编码>--/<id>.jsonl
  traces/<id>.jsonl               轨迹树 + 装载段
```

**布局照抄 pi，位置是自己的。** 目录名不带 `pi` 前缀 —— 里面没有 pi 的代码，唯一交集是
这套结构（`models.json` / `auth.json` / `settings.json` / `sessions/`）照着
pi-coding-agent 的 `getAgentDir()` 抄的。那件事写在[这个文件的头部注释]和 README 里，
不写在目录名里。

会话按 cwd 分目录（`encodeCwd`：`--` 包起来，`/` `\` `:` 换成 `-`）—— 与 pi 同一套编码。

## 会话文件的形状

首行 header，其后每行一条 entry：

```json
{"type":"session","version":1,"id":"…","timestamp":"…","cwd":"…"}
{"type":"message","id":"e1","parentId":null,"timestamp":"…","message":{…}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"…","message":{…}}
```

`id` / `parentId` 串成链（pi 用这条链做 session tree）。另有两种 entry 现在也写：
`model_change`、`thinking_level_change`。

字段名与 pi 的 `SessionHeader` / `SessionEntryBase` 一致，**但不要求 pi 能读我们的会话**
—— 抄格式是为了「目录长得一样」和「不自己发明 header 定义」，不是为了互通。

### 空会话不落盘

`SessionWriter.start()` 只**记住** header，第一条消息到了才写文件。否则每次启动内核都会
在 `sessions/` 留一个「一行 header、零条消息」的空壳，列表里全是噪声。

### 崩溃截断

读的时候 `JSON.parse` 失败的行直接跳过 —— 崩溃只会丢掉最后没写完的那半行，之前的历史完好。

## 恢复：零 token

```ts
kernel.restoreSession(file);   // 读文件 + 清空当前 + 灌回消息
kernel.restore(messages);      // 只灌（消息已读出来时）
```

恢复**不重跑模型**：纯粹是把 JSONL 里读到的内容搬进状态树。所以：

- 没有 token 消耗
- 没有网络请求
- 恢复出来的 assistant 消息就是当时的原文

### 走 action，不直接改 state

恢复用 `conversation.reset` + 逐条 `session.restored`，而不是直接改 `store`：

`session.restored` 的迁移**只加消息，不动相位、不动轨迹树**。这些消息是「上次发生的」，
开新节点或推进 tip 会把历史伪装成这一轮。轨迹是那一轮的东西，这里只负责把对话补齐。

### `resumeFrom`：别把恢复的消息再写一遍

恢复之后继续聊，记录器会接着写同一个文件。如果不告诉它「已经有几条了」，它会把刚灌进去的
历史消息**当成新消息再写一遍**。所以 `createSessionRecorder` 收 `resumeFrom`，游标从那里
接着算；entry id 也从那个数往后编，避免与文件里已有的撞。

## 开新会话

`kernel.newSession()`：**换 sessionId**（于是换文件）+ 清空对话，保留装载的 prompt / model。

为什么不只 `dispatch({type:'conversation.reset'})`：那个默认**沿用原 id**，于是之后的
消息会追加进**同一个文件** —— 界面上看着像新会话，实际上把上一段历史续写了。
这是之前的 bug，现在 `conversation.reset` 可以带 `sessionId`，界面一律走 `newSession()`。

顺序要紧：先摘掉旧记录器（它绑在旧 id 上）→ 换资源 → dispatch → 建新记录器 → 写装载段
→ 关旧 sink。反过来的话，`conversation.reset` 一发生，旧记录器还会把「清空」当成一次状态
变化去写旧文件。

同理 `restoreSession()` 也换 id —— 之后的消息要追加进**那个**会话的文件。

## 界面的入口

`/sessions` → `SelectList` 弹窗（覆盖层，输入即筛、上下键、回车选定），背后走
`config-home.listSessions()` + `session-file.readSessionMessages()`，**零 token**。

### 跨目录的会话

会话按 cwd 分目录，所以列表里可能有别的项目的会话。内核用 `current` 字段标出「这条是当前
cwd 的」。

**别的目录的历史恢复进来会让工具的文件边界与对话内容对不上**（对话里说改的文件在当前目录
根本不存在）。所以界面上标出来，但没有硬拦 —— 用户可能就是想看看当时聊了什么。

## 相关

- 轨迹那一半 → [trace](trace.md)
- 装载段（prompt / model）→ [init](init.md)
- 内核装配 → [kernel](kernel.md)
