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

全部全局状态在 `~/.pi/agent/` —— **与 pi 同址**（可搬家：`REDUX_AGENT_DIR` 优先于
pi 的 `PI_CODING_AGENT_DIR`，都没设就用 `~/.pi/agent`）：

```text
~/.pi/agent/
  models.json                     provider / 模型目录
  auth.json                       凭证
  settings.json                   默认 provider / model / thinkingLevel
  sessions/--<cwd 编码>--/<id>.jsonl
  traces/<id>.jsonl               轨迹树 + 装载段（pi 没这个目录）
```

**为什么同址**：provider 目录改一次两边都得知道，key 改一次两边都得用。分两个目录的代价
是每次改配置要同步两次，收益仅仅是一个命名上的所有权标记。所以 `models.json` /
`auth.json` / `settings.json` / `sessions/` 两边共用，`traces/` 是我们多出来的（pi 没有，
单独放的理由见 [trace](trace.md)）。

会话按 cwd 分目录（`encodeCwd`：`--` 包起来，`/` `\` `:` 换成 `-`）—— 与 pi 同一套编码。

## 与 pi 的会话互通

同址之后会话历史是**双向可见**的，pi 的 `/resume` 能看到我们的，我们的 `/sessions` 也能
看到 pi 的。两个已知差异，都不影响读：

| | 我们 | pi |
| --- | --- | --- |
| 文件名 | `<id>.jsonl` | `<时间戳>_<id>.jsonl` |
| header `version` | `1` | `3` |

两边都不靠文件名识别会话，而是读 header 里的 `id`（pi 的 `SessionManager.list()` 与
`findById()` 都是这样），所以文件名不一样也照样列得出来。version 那边 pi 会自动把 v1 升到
v3（`migrateV1ToV2` 补 `id`/`parentId` 树、`migrateV2ToV3` 把 `hookMessage` 改成 `custom`）
并重写文件；那些字段我们写的时候本来就有，所以升级不丢东西。

## 会话文件的形状

首行 header，其后每行一条 entry：

```json
{"type":"session","version":1,"id":"…","timestamp":"…","cwd":"…"}
{"type":"message","id":"e1","parentId":null,"timestamp":"…","message":{…}}
{"type":"message","id":"e2","parentId":"e1","timestamp":"…","message":{…}}
```

`id` / `parentId` 串成链（pi 用这条链做 session tree）。另有两种 entry 现在也写：
`model_change`、`thinking_level_change`。

字段名与 pi 的 `SessionHeader` / `SessionEntryBase` 一致，所以同址之后两边能互相读到对方的
会话（差异见上面的「与 pi 的会话互通」）。

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

恢复用**一条** `conversation.restored`，而不是直接改 `store`：

- **状态只能由 action 改**（本项目的不变式），所以哪怕是「读回来的历史」也得走 action。
- **只加消息，不动相位、不动轨迹树**：这些消息是「上次发生的」，开新节点或推进 tip
  会把历史伪装成这一轮。
- **只 dispatch 一次**，不是逐条灌。界面每个 dispatch 都会重渲染整段对话，而重渲染成本与
  messages 长度成正比 —— 逐条灌 N 条就是 O(N²)。390 条消息实测 62 秒（用户看到的是
  「卡了一分钟」），合成一条只渲染一次，O(N)。

`session.restored`（单条）仍然保留：它是不换会话 id 时的最小单位（`kernel.restore(messages)` 用它）。

### `resumeFrom`：别把恢复的消息再写一遍

恢复之后继续聊，记录器会接着写同一个文件。如果不告诉它「已经有几条了」，它会把刚灌进去的
历史消息**当成新消息再写一遍**。所以 `createSessionRecorder` 收 `resumeFrom`，游标从那里
接着算；entry id 也从那个数往后编，避免与文件里已有的撞。

### 恢复**必须**走内核

`kernel.restoreSession(file)` 是唯一正确的入口。界面自己 dispatch 做不到两件事：

| | 谁知道 | 漏了会怎样 |
| --- | --- | --- |
| 换 `sessionId`（于是换文件） | 内核（持有 sink / 记录器） | 之后的消息续写进**当前**会话文件 |
| `resumeFrom` 对齐记录器游标 | 内核（持有记录器） | 整段历史被当成新消息，全量抄进当前文件 |

「全量抄进当前文件」不是假设：真发生过一次 —— 390 行的会话被原样复制成另一个 390 行的
文件（内容逐行相同，只有时间戳是新的）。`test/restore-perf.test.ts` 钉住了这个不变量。

界面上若没有内核接管（测试、或将来另一个前端），它会**明说**「后续消息会写进当前会话文件」，
而不是静默复制一份。

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

### 列表不许「为了显示标题而读整个文件」

会话文件里一条 toolResult 能有几百 KB，而标题只是「用户说的第一句话」，它在文件**前几行**。
所以列表侧只做三件事（都在 `openSessionPicker()` 弹出前的同步路径上）：

| | 怎么读 | 为什么 |
| --- | --- | --- |
| header（cwd / id / 时间） | 只读开头 64KB（`config-home.readHead`） | header 是首行，永远在这截里 |
| 条数 | 分块流式数换行（`countLines`） | 精确；不把全文读进内存，也不建几十万元素的 `split` 数组 |
| 标题 | 只读开头 512KB，且**命中第一条 user 消息就停**（`readJsonlHead({stopAfter})`） | 读多少只与「第一个问题有多长」有关，与聊了多久无关 |

早先这里是「每个会话都 `readSession` 整份再 parse 一遍」：124 个会话、18MB 的目录，
光列列表就要 524ms（其中 `listSessions` 286ms + 标题 238ms）。现在整条弹窗路径 128ms。

精确的条数不是可有可无的：中间试过按字节估算（读都不用读），但一个 800 字节的 2 条消息会话
会被算成 1 条 —— 而那个数字用户看得见。

### 跨目录的会话

会话按 cwd 分目录，所以列表里可能有别的项目的会话。内核用 `current` 字段标出「这条是当前
cwd 的」。

**别的目录的历史恢复进来会让工具的文件边界与对话内容对不上**（对话里说改的文件在当前目录
根本不存在）。所以界面上标出来，但没有硬拦 —— 用户可能就是想看看当时聊了什么。

## 相关

- 轨迹那一半 → [trace](trace.md)
- 装载段（prompt / model）→ [init](init.md)
- 内核装配 → [kernel](kernel.md)
