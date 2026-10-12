# 会话与恢复

## 两份记录，不是一份

内核同时写两份东西，位置不同、用途不同：

| | `sessions/<cwd>/<时间戳>_<id>.jsonl` | `traces/<时间戳>_<id>.jsonl` |
| --- | --- | --- |
| 记什么 | 消息流（user / assistant / toolResult） | 一次尝试一节点（含失败、超时、重试） |
| 回答什么问题 | 「上次聊到哪了」 | 「为什么这次慢 / 错了」 |
| 恢复成什么 | `messages`（可以接着聊） | 轨迹树（只能看） |
| 谁写 | `session-recorder.ts` | `trace-store.ts` |

**为什么不是一份**：轨迹有节点但没有完整消息正文（错误节点的 detail 是错误信息），
会话有消息但没有 attempt 的时间线。想从一份推导出另一份，都要丢东西。

两者都是 store 订阅器（不是 effect 表里的 Cmd）—— 挂在 dispatch 链上，成功失败都记。

## 家目录

全部全局状态在 `~/.pi/agent/` —— **与 pi 同址**（可搬家：只认 pi 官方的
`PI_CODING_AGENT_DIR`，不设就是 `~/.pi/agent`）：

```text
~/.pi/agent/
  models.json                     provider / 模型目录
  auth.json                       凭证
  settings.json                   默认 provider / model / thinkingLevel
  sessions/--<cwd 编码>--/<时间戳>_<id>.jsonl
  traces/<时间戳>_<id>.jsonl      轨迹树 + 装载段（pi 没这个目录）
```

**为什么同址**：provider 目录改一次两边都得知道，key 改一次两边都得用。分两个目录的代价
是每次改配置要同步两次，收益仅仅是一个命名上的所有权标记。所以 `models.json` /
`auth.json` / `settings.json` / `sessions/` 两边共用，`traces/` 是我们多出来的（pi 没有，
单独放的理由见 [trace](trace.md)）。

会话按 cwd 分目录（`encodeCwd`：`--` 包起来，`/` `\` `:` 换成 `-`）—— 与 pi 同一套编码。

## 与 pi 的会话互通

同址之后会话历史是**双向可见**的，pi 的 `/resume` 能看到我们的，我们的 `/sessions` 也能
看到 pi 的。会话文件那边已经**与 pi 同形**：

| | 我们 | pi |
| --- | --- | --- |
| 文件名 | `<时间戳>_<id>.jsonl` | `<时间戳>_<id>.jsonl` |
| id | UUIDv7 | UUIDv7 |
| header `version` | `1` | `3` |

文件名里的时间戳是 ISO 串把 `:` `.` 都换成 `-`（`2026-10-12T05-44-28-468Z`），与 pi 同一
规则；id 是 UUIDv7。于是把我们的 id 粘给 `pi --session <id>` 能直接恢复 —— 但我们退出时
打的是**本项目自己的** `ela --session <id>`（见下面的「退出时的恢复提示」）。

仍然会读**旧名**（`<id>.jsonl`，改名之前建的会话）—— 按 id 找文件时扫目录比对
`_<id>.jsonl` 后缀，找不到再试精确的 `<id>.jsonl`（见 `config-home.ts` 的 `findFileById`）。
version 那边 pi 会自动把 v1 升到 v3（`migrateV1ToV2` 补 `id`/`parentId` 树、`migrateV2ToV3`
把 `hookMessage` 改成 `custom`）并重写文件；那些字段我们写的时候本来就有，所以升级不丢东西。

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

轨迹那边是同一个决定：**发过第一句话才算一段会话**。内核一装配虽然已经把 prompt / model
装满 state，但不开轨迹节点、不建 `traces/<时间戳>_<id>.jsonl`；两者都推迟到第一条
`user.message`。详见 [init](init.md)「进入会话不建节点」。

### 崩溃截断

读的时候 `JSON.parse` 失败的行直接跳过 —— 崩溃只会丢掉最后没写完的那半行，之前的历史完好。

## 退出时的恢复提示

交互模式退出（空闲时 `Ctrl-C`）会打一行：

```text
To resume this session: ela --session 01a12ea4-09d6-73ca-8dc5-8df8597cdb12
```

形状与 pi 自己退出时打的一样（同一构图、前缀暗色），只是命令是本项目的入口 `ela`。
因为两边会话文件完全互通（目录名、文件名、header、id 全一致），把同一个 id 粘给
`pi --session <id>` 也能打开 —— 但默认提示的是回到 `ela`。

两个条件才打（都在 `config-home.ts` 的 `resumeCommand()` 里）：

- **stdout 是 TTY**：管道/重定向没人看那一行，与 pi 同一判断；
- **真的落过盘**（那个会话文件存在）：一句话没说时文件还没建（见「空会话不落盘」），
  这时 `ela --session <id>` 会找不到，打出来是误导。

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

`/sessions` → **pi 官方的 `SessionSelectorComponent`**（覆盖层，搜索框 + 输入即筛 + 上下键 +
回车选定），背后走 `config-home.listSessions()` + `session-file.readSessionMessages()`，
**零 token**。适配层在 `src/tui/session-picker.ts`，理由写在那个文件的头注释里。

面板的完整交互（与 pi 逐行一致）：

| 键 | 作用 |
| --- | --- |
| `Tab` | `Current Folder` / `All` 两个作用域 |
| `Ctrl+S` | 排序循环：`Threaded` → `Recent` → `Fuzzy` |
| `Ctrl+N` | `Name: All` / `Named`（只看起过名字的） |
| `Ctrl+P` | 额外显示文件路径 |
| `Ctrl+D` | 删选中那条（要确认；**当前会话拒绝删**） |
| `Ctrl+R` | 重命名（进一个子面板输入名字） |
| `re:<pat>` | 正则搜索；`"phrase"` 精确短语 |

### 适配层的四个要点

1. **`modified` 必须是「最后一次说话」**，不是文件 mtime（`readJsonlTail`）。mtime 会被
   追加一条 `model_change`、或用户改名而改变 —— 而「我半小时前说过话」不该被一次改名改掉。
   官方用它排「N 分钟前」并作为默认排序依据。
2. **keybindings 要装到 pi-tui 全局**（`installProjectKeybindings()`，见
   [surfaces](surfaces.md) 的「键位表只有一处」）。`app.session.*` 是 pi 应用层定义的，
   不装的话 `Ctrl+S`/`Ctrl+R` **静默失效** —— 连那行按键提示都会一起消失（它用同一个
   keybindings 渲染）。
   > 面板里的 `Ctrl+R`（重命名）与面板外的 `Ctrl+R`（切轨迹页）是**同一个键的两个上下文**：
   > 面板打开时全局那几个开关整个让路（`onInput` 开头的 `hasOverlay()` 早返回），
   > 所以不会同时生效。这与 pi 自己的做法一致（它的 `Ctrl+R` 也只在会话面板里有含义）。
3. **弹窗开着时 `onInput` 要让路**（`if (tui.hasOverlay()) return undefined`）。pi-tui 的
   `inputListeners` 在聚焦组件**之前**跑，而 `app.ts` 的 `onInput` 无条件处理 `ctrl+c` ——
   空闲时它 `process.exit(0)`。于是「打开 /sessions 按 Ctrl+C 取消」会杀掉整个 pi。
4. **搜索面只给头部**（`allMessagesText` 传空串）。官方的实现是整个会话文件读出来拼的，
   我们不这么做 —— 见下面的性能一节。要找回聊过的那句话，用 `rg` 搜 `~/.pi/agent/sessions`。

### 列表不许「为了显示标题而读整个文件」

会话文件里一条 toolResult 能有几百 KB，而标题只是「用户说的第一句话」，它在文件**前几行**。
所以列表侧只做四件事（都在 `openSessionPicker()` 弹出前的同步路径上）：

| | 怎么读 | 为什么 |
| --- | --- | --- |
| header（cwd / id / 时间） | 只读开头 64KB（`config-home.readHead`） | header 是首行，永远在这截里 |
| 条数 | 分块流式数换行（`countLines`） | 精确；不把全文读进内存，也不建几十万元素的 `split` 数组 |
| 标题 | 只读开头 512KB，且**命中第一条 user 消息就停**（`readJsonlHead({stopAfter})`） | 读多少只与「第一个问题有多长」有关，与聊了多久无关 |
| 名字（`session_info`） | 扫开头 512KB，**不提前停** | 改名可以反复发生，要的是**最后**一条（见下） |
| 最后说话时间 | 只读**末尾** 256KB（`readJsonlTail`） | 消息 timestamp 在每行里，但最后那次几乎总在末尾 |

早先这里是「每个会话都 `readSession` 整份再 parse 一遍」：124 个会话、18MB 的目录，
光列列表就要 524ms（其中 `listSessions` 286ms + 标题 238ms）。现在整条弹窗路径 128ms。

精确的条数不是可有可无的：中间试过按字节估算（读都不用读），但一个 800 字节的 2 条消息会话
会被算成 1 条 —— 而那个数字用户看得见。

### `session_info`（名字）：最后一条说了算，且空串 = 清名

pi 的语义是「**倒着找最后一条** `session_info`，空串 = 显式清掉上一个」。两个坑：

- **不能 `stopAfter` 命中就停**（那是 `sessionTitleFromHead` 的做法，对标题对、对名字错）。
  给同一个会话改两次名就有两条，于是「命中就停」读到的是**第一次**的名字，而用户在 pi
  那边看到的是第二次那个。症状是「刚改完名，`Ctrl+N` 只看得到旧名字」，且只在该会话被
  改过名时出现 —— 极难归因。
- **不能用 `name === undefined` 当「还没找到」的哨兵**：空串那条会让它重新变回 undefined，
  于是循环继续往回找，把上一个名字捞出来（症状是「清名之后又冒出旧名字」）。所以另用
  一个 `nameSeen` 标记区分「没找到」与「找到了，但是空的」。

代价：改名**可以**追加在文件末尾（给一个三个月前的会话改名），所以 512KB 的窗口不是
「读全部」。对**当前**正在聊的会话改名（面板的主要用途）那条 entry 就在前几 KB 里，
一定命中。这是取舍，不是疏漏。

### 改名是 append，且不动 `parentId` 链

`session_info` 是 **append** 进会话文件的。重写文件就要重排那条链（pi 用它做 session tree），
而「起个名字」不该动它。名字里的换行压成空格 —— 一条 entry 是一行 JSON，换行会把它劈成
两半，第二半 `JSON.parse` 失败被跳过，于是这个名字**看起来没生效**。

### 删会话要连带删 `traces/`

官方只删会话文件（先 `trash` 再 `unlink`）。而一个会话在盘上落**两处** ——
`sessions/<cwd 编码>/<时间戳>_<id>.jsonl` 与 `traces/<时间戳>_<id>.jsonl`。所以适配层在官方删完之后调
`deleteSessionTrace(session)` 补删轨迹那份（`clean-sessions.test.ts` 钉的就是这条不变量）。

按会话 **id** 删（`findTraceFile(id)`，扫目录比对 `_<id>.jsonl`），不是按名字 —— 所以摘缓存时
要摘对，否则用户在同一次弹窗里删两次同一个会话时会对已删的文件再删一次轨迹。

### 跨目录的会话

会话按 cwd 分目录，所以列表里可能有别的项目的会话。内核用 `current` 字段标出「这条是当前
cwd 的」。

**别的目录的历史恢复进来会让工具的文件边界与对话内容对不上**（对话里说改的文件在当前目录
根本不存在）。所以界面上标出来，但没有硬拦 —— 用户可能就是想看看当时聊了什么。

## 相关

- 轨迹那一半 → [trace](trace.md)
- 装载段（prompt / model）→ [init](init.md)
- 内核装配 → [kernel](kernel.md)
