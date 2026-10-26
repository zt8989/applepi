# 轨迹树

## 为什么是树

Agent 的执行历史不是一条流水。`packages/core/src/trace.ts` 把它做成**一棵树**，概念直接照搬 git：

| git | 这里 |
| --- | --- |
| commit 有 parent | 每个节点有 `parentId` |
| commit 有分支（`--graph` 里的 `│` `/` `\`） | 重试曾是分支，现在改为**同一个容器里的多次尝试**（见下） |
| HEAD 指向当前所在的线 | `tipId` = 最后一条推进 tip 的节点 |
| `git reflog` 只追加不改写 | `~/.pi/agent/traces/--<cwd 编码>--/<时间戳>_<id>.jsonl` 追加写 JSONL |

## 盘上位置

轨迹与 sessions/ 同一套目录编码：`traces/--<cwd 编码>--/<时间戳>_<id>.jsonl`（编码规则见
config-home 的 `encodeCwd`，与 sessions/ 一致）。理由：会话与轨迹同生同死，按 cwd
归类后两边目录一一对应 —— 删会话时轨迹就在旁边；跨项目 `/resume` 轨迹也跟着走。

找不到 cwd 的旧轨迹（多半是只有装载段、没接过话的空会话）在 `traces/--unknown--/`。

**旧布局迁移**：轨迹曾经放在平的 `traces/<时间戳>_<id>.jsonl`。启动时
`migrateFlatTraces()`（config-home）做一次性归位 —— 按 trace 自己的
`prompt.init.sections.cwd` 或同 id sessions 文件头的 `cwd` 把文件 rename 进
`traces/--<cwd>--/`；两者都拿不到的进 `--unknown--`。跑完写
`~/.pi/agent/trace_migrate` 标记文件，之后启动直接跳过（代码里也不再有平目录回退扫）。

## 节点模型

```ts
interface TraceNode {
  id: string;                    // 40 位 SHA-1 内容 hash（git 那样），显示取前 7 位
  parentId: string | null;       // 根为 null（全树只有一棵根：system prompt）
  kind: 'user' | 'turn.start' | 'turn.end'      // 回合容器
      | 'step.start' | 'step.end'               // 步容器（= 一次 LLM 调用 + 它的工具批次）
      | 'llm.result'
      | 'tool.call' | 'tool.result' | 'error' | 'stop'
      // 上下文族（不推进 tip，见下）
      | 'prompt.base' | 'prompt.tools' | 'prompt.segment' | 'model.init' | 'model.changed'
      // 生命周期注释（内核告诉了扩展/宿主什么，也不推进 tip）
      | 'extension.event';
  status: 'pending' | 'ok' | 'error' | 'aborted';
  label: string;                 // 短标签，渲染用
  detail?: string;               // 详细文本（回答全文、错误信息、工具参数）
  meta?: Record<string, string>; // provider / model / tool / kind
  message?: Message;             // 这条节点对应的 pi 消息（user / assistant / toolResult）
  createdAt: number;
  endedAt: number | null;        // 与 createdAt 相减得耗时
}
```

`turn.*` / `step.*` 是**容器**（区间），`llm.result` / `tool.result` / `error` 是里面的**事件**。

### id 是内容 hash（git 同款）

节点 id 是 **SHA-1(父 id + 创建序数 + 创建时刻的全部内容)**，40 位十六进制，与 commit 的
寻址方式同构：同内容必同 id，改一个字段就换 id。渲染行只打前 7 位短 hash
（`shortId()`），全长留在文件与数据层。序数（第几个节点）参与 hash —— 同一毫秒里两个
内容完全一样的节点（一批参数相同的并行工具调用）靠它分开。hash 里含 `createdAt`，
所以两次运行同一串 action 的 id **不**相同 —— 与 git 的 commit hash 含时间戳同一语义。
节点后来被 patch（闭合、流式改标签）**不改 id**：hash 只取 `appendNode` 那一刻的内容。

### 树是单根的：全树从 system prompt 长出来

根节点（`parentId === null` 的那一个）就是 **system prompt**（`prompt.base`，`meta.role`
= `'system'`）—— 仓库从首个 commit 长出来，对话从 system 长出来。user / turn /
`model.init` / `model.changed` 全部从它长出：新节点的挂载点是 `attachPoint(tree)` =
「tip，没有 tip 则根」，不再有第二棵根。旧文件（v1）可能有两棵根（上下文族与对话族
两条线），迁移时除第一棵外全部重挂到 system 根下（见下面「落盘与回放」）。

### 消息挂在节点上

会产生一条对话消息的节点（`user` / `llm.result` / `tool.result` / 工具失败的 `error` /
`prompt.segment`）自己带着整份 pi 消息。因为界面的**时间线是从轨迹派生的**，而不是
回头去读 `state.messages` —— 详见 [stream](stream.md)。只有两条路：

- 旧轨迹文件里没有这个字段（那时消息单独落在 `op:'message'` 行），派生时整体退回
  从会话文件读回来的那份；
- 新会话里它就是真相，所以图片 / 思考块 / toolResult 的 `details`（edit 的 diff）都不丢。

## 两层容器：turn 与 step

- **turn** = 一次用户输入引发的整个回合（user → 若干 step → 收工）。
- **step** = 一次 LLM 调用**加上它触发的工具批次**。它取代了原先的 `llm.attempt`
  —— 语义相同（都是「一次尝试」的容器，parent 取发起那一刻的 tip），只是名字不预设
  「里面一定只有 LLM」。

## 关键规则：只有五类节点推进 tip

```ts
const TIP_ADVANCING_KINDS = new Set([
  'user', 'turn.end', 'llm.result', 'tool.result', 'stop',
]);

function advancesTip(node) {
  return (node.status === 'ok' || node.status === 'aborted') && TIP_ADVANCING_KINDS.has(node.kind);
}
```

**容器（`turn.start` / `step.start` / `step.end` / `tool.call`）一律不推进 tip**，
`error` 也不推进。只有 `turn.end` 这个**回合的闭合点**推进。

这条不变量（error 不推进 tip）保证失败不会把后续尝试挂到「错误的子节点才是正史」下面：
重试的产出与失败平级，先后顺序就是树上的兄弟顺序。

## 一次正常对话长这样

```
○  3f9a2c1 user: 今天几号？
○  b21d77e turn.start: 回合 1
│  ○  8c04e9f step.start: 第 1 步
│  │  ○  51aa0d2 llm.result: 我来查 [调用 bash]
│  │  ○  9d31c7a tool.call: bash {"command":"date +%m-%d"} (tool=bash)
│  │  ○  e2f8b60 tool.result: 10 月 5 日 (tool=bash)
│  └─ 44c0e18 step.end: 第 1 步结束（1 个工具调用） (tools=1)
│  ○  7b5aa93 step.start: 第 2 步
│  │  ○  c1d2e3f llm.result: 今天是 10 月 5 日
│  └─ 0aa11bb step.end: 第 2 步结束（0 个工具调用） (tools=0)
└─ 5e4d3c2 turn.end: 回合 1 结束：模型说完了 (reason=completed, steps=2)
```

（渲染时会带上每个节点的耗时与 `meta`；这里为了让形状好读，把它们省了。
最后一行就是当前 tip（`5e4d3c2`）—— 它在字形上与别的节点一样，只在界面上**加粗**，
见下面渲染一节。）

一个回合里模型可以跑很多步（模型→工具→模型→…），**那是同一个回合的正常推进，不是重试**
—— `traceStats` 的 `retries` 数的是「同一个 step 容器里被后续尝试覆盖的失败」。

## 于是重试长这样（所有尝试包在同一个容器里）

```
○  3f9a2c1 user: 你好
○  b21d77e turn.start: 回合 1
│  ○  8c04e9f step.start: 第 1 步
│  │  ○  51aa0d2 error: LLM 调用超时（1s） (kind=timeout, cause=timeout)
│  │  ○  9d31c7a llm.result: 好了        ← tip（界面上加粗）
│  └─ 44c0e18 step.end: 第 1 步结束（0 个工具调用） (tools=0)
└─ 5e4d3c2 turn.end: 回合 1 结束：模型说完了 (reason=completed, steps=1)
```

重试**不开新容器**：`llm.failed` 把 error 节点挂进当前 step 容器后容器保持开着，
接线只补一条 `agent.run`，下一次尝试的产出继续挂进**同一个容器**。
失败与成功是容器里的**兄弟节点**，顺序即先后。超时、断连怎么重试，
树上都是一个容器装着全部尝试 —— 用户看到的步数不会被重试数撑大。
容器只在真收工时（重试用尽 / 不可重试 / 成功）才打上闭合标记。

## 纯函数

`trace.ts` 里没有 IO、没有 `Date.now()`、没有随机数。节点 id 是创建内容的 SHA-1
（见上面「id 是内容 hash」），同一棵树必然产出同一串 id —— 能在测试里逐字断言，
也能从 JSONL 回放重建（回放不重算 hash，id 就在记录里）。

`appendNode` / `patchNode` 都是返回新树，不改原对象。

## 渲染：lazygit 那样的轨道 + 轮/步缩进

`traceRows()` 把树算成一行一行（`renderTree()` 只是把它拼起来）。
每行是 `<轨道><符号> <id> <kind>: <label>`：

- **符号**：**所有**节点都是 `○`；容器的闭口点（`turn.end` / `step.end`）是 `└─`。
  早先 tip 单独画 `◎`（圈里套圈），于是同一棵树上有两种圆点字形 —— 差异又很轻微，
  读起来像画错。现在 tip 靠**加粗**区分（见下），字形上树上只剩一种圈。
- **轨道**：一行左边有几段 `│  `，就说明它在几层容器里。

### tip 在哪里体现

`traceRows()` 是**纯文本**层（没有 ANSI），所以它给出的行里看不出 tip。加粗是渲染层
给的，判据只有一处 —— `emphasizedTraceLine()`（`packages/tui/src/app.ts`）：

- 节点 `status === 'error'`，或
- 它就是 `tree.tipId`。

两处渲染都用它：`renderColoredTree()`（一次性模式 / `--print` 的树）与
`TraceChunks.lineOf()`（轨迹页）。**分成两条判据就会分家** —— 一次性模式里加粗的
是 tip、界面里不是，而那种 bug 只有同时盯着两边的人能发现。

代价是 `renderTree()`（纯文本路径）没有 tip 标记：每个节点都是 `○`。

因为 tip 不再改字形，`TraceChunks` 的轨道前缀缓存里也不再需要 `tipId`（key 只剩
「会话 id + 节点数」）；但 tip **换人**时旧、新两行的加粗都变了，所以那两行仍要
主动作废（见 `syncLayout()`）—— 不能只指望「新节点一定是新对象」。

**缩进只由 `turn.start` 与 `step.start` 给**，别的节点不给 —— 包括
`llm.result` → `tool.call` → `tool.result` 那串父子链，它们都画在步里面那一列。

### 为什么不是「每个父节点都缩进自己的孩子」

因为轨迹树的链是一条**直线**：推进 tip 的节点挂出下一个节点，而 `turn.end` 推进 tip
—— 于是每一轮的 user / turn.start 都挂在上一个回合的 `turn.end` **底下**。
按父子关系缩进，第 10 轮就在第 10 层，屏幕上长出一条永远往右走的阶梯。

按容器缩进则天然把括号收回来：`turn.end` / `step.end` 画在自己**容器那一列**，
所以缩进是「用完即还」的 —— 第 2 轮与第 1 轮对齐。「发了一句话 = 出去一层，
说完 = 回来一层」，这正是要一眼看到的东西。

### 收口靠事件，不靠树

容器**关闭的时机**是事件性的（`turn.end` / `step.end` 落下来的那一刻），
所以 `traceRows()` 按 `tree.order`（= 发生顺序）扫一遍，维护一个作用域栈：
压栈开、弹栈关。四条收口规则：

| 遇到 | 做什么 | 为什么 |
| --- | --- | --- |
| `turn.end` / `step.end` | 关掉 `parentId` 那个作用域 | 闭合点自己画在容器那一列（`└─`） |
| `turn.start` | 先关掉已经开着的回合 | 回合不嵌套；上一个回合没等到 `turn.end` 时也要收 |
| `step.start` | 先关掉已经开着的步 | 下一步开新容器时，旧那一格不该还挂着（重试不经过这里：容器不关，自然也不重开） |
| `user`（`meta.queued !== 'steer'`） | 清空整个栈 | 「用户又发了一句话」= 新回合从根层开始 |

最后一条不是防御性代码：**「回合结束了而 `turn.end` 还没落下来」是真实存在的中间态**
（`turn.end` 是环转 idle 之后另发的一条 Cmd，用户看到答案就接着说下一句时会挤在它前面）。
那时新一句话的 parent 取 tip，落点在上一个回合**里面** —— 只认树的话，第二轮会被缩进到
上一轮的括号里。而 `steer`（插话）是唯一的例外：它**属于**当前回合，所以它来了不收
—— 这也正是 `queue.delivered` 给 user 节点打 `queued` 标记的用处之一。

### 节点状态画在颜色上，不在字上

`✓` / `✗` / `⊘` / `·` 那套状态字符已经删掉：成功绿、失败红**加粗**、进行中黄、
上下文族（`prompt.*` / `model.init` / `model.changed` / `extension.event`）暗。理由：`✓ 51aa0d2 llm.result` 里那个 `✓` 占了宽度，
而它说的信息与颜色重复；轨道符号要能一眼区分的是「这是哪个节点」，不是「它成没成」。

代价是**纯文本那一份（`renderTree()`）看不出成败** —— 落盘、回放、统计都不受影响
（那是数据层的事），只有给人看的那份要靠颜色。

### 界面与命令行是同一份画法

`renderColoredTree()`（`packages/tui/src/app.ts`）与轨迹页的 `TraceChunks` 都调 `traceRows()`：
前者拿 `text` 逐行上色，后者拿 `prefix` 拼自己那一行（它是分块增量渲染的，一个节点一块，
所以只需要知道自己那一段轨道）。早先 `renderColoredTree` 是「先渲染成字符串、再用正则
逐行抠出节点 id」，那个正则的 kind 白名单**漏了 `turn.start` / `step.end` 四个 kind**
（它们于是整族不上色，静默退化）—— 现在把节点对象一起给出来，不再认文本格式。

`TraceChunks` 的轨道前缀按「会话 id + 节点数」缓存：流式 token 一帧里节点只被换了标签，
轨道一个字没变。tip **不进这个 key** —— 它不改字形（只是加粗），换人时单独作废那两行
（见上面「tip 在哪里体现」）。

## 落盘与回放

`createTracePersistence()`（`packages/core/src/trace-store.ts`）是个 **store 订阅器**，不是 effect 表里的一行。

为什么不用 Cmd：它几乎每次 dispatch 都要跑（token 增量也会触发），走 Cmd 会把环搅乱；
而且「错误也要持久化」这个要求恰恰需要它**不能**因为出错路径而不执行 —— 一个订阅器对成功与
失败一视同仁，这正是要的语义。

### 文件形状：v2（首行版本头，每行 seq 严格等于行号）

```jsonl
{"seq":1,"op":"header","v":2}
{"seq":2,"op":"prompt.init",…}
{"seq":3,"op":"add","node":{"id":"3f9a2c1b8d0e46a7…","parentId":null,…}}
{"seq":4,"op":"close","id":"3f9a2c1b8d0e46a7…","status":"ok","endedAt":1700000000000}
{"seq":5,"op":"message",…}
```

**`seq` 就是行号**（版本头是第 1 行，`seq:1`）。它是**分页游标**：后续取「某一段轨迹」
不用解析任何一行，两个行号就知道边界在哪。落盘器写盘前逐条盖章（`seq = ++nextLine`），
行号游标属于**文件**，不在 state 里 —— 换会话就是换文件，内核调 `beginSession()` 把
「下一行行号 / 要不要写版本头 / 文件里已有几个节点」一次拨到位，于是续写不会重复写版本头，
恢复会话也不会把读回来的树整棵重写一遍（那是旧游标放 state 里的两个真 bug）。

记录的 op 一览：

| op | 什么时候 | 内容 |
| --- | --- | --- |
| `header` | 永远是第 1 行 | 文件版本 `v: 2` |
| `prompt.init` / `model.init` | 装载段 | system prompt / 工具 / 模型能力 |
| `add` | 节点首次出现 | 完整字段（id 是 40 位 hash） |
| `close` | 节点从 `pending` 变成闭合 | 只带 `id` / `status` / `endedAt` |
| `message` | 每条对话消息 | 回放零 token 复现用 |

驱动器的游标：已写节点数（`order` 前缀长度）、`needClose`（已 add 过、后来闭合的节点）、
已写消息数、行号。

选 JSONL 而不是整树覆盖写：崩溃只丢最后没 flush 的一行；追加写不会重写整个文件；
一行一个节点，`wc -l` 就知道这次会话发生过多少次尝试。

**写盘失败不会打断环**：游标不推进，下次状态变化再试一遍，只报一次警告。

回放（`replayTrace`）逐行重放，**坏行直接跳过** —— 崩溃截断的半行丢掉即可。
回放用的 tip 规则与在线推进是同一个 `advancesTip`，否则重放出来的 HEAD 会和当时不一致。
v1 文件（无版本头、id 是 `n7` 这种自增号）照常回放 —— id 只是透明字符串，
渲染时 `shortId()` 原样保留短 id。

### 旧文件迁移：v1 → v2（一次性）

旧格式算 **v1**（无版本头、无 seq、自增 id、多棵根），新格式算 **v2**。启动时
`migrateTracesV2()`（config-home）扫 `traces/--<cwd>--/`（含 `--unknown--/`）下的每个文件：
首行声明 `v: 2` 的跳过；否则按 `upgradeTraceToV2()`（trace-store，纯函数）升级 ——
补版本头、逐行盖新 seq、节点 id 重算成 hash（与在线 `computeNodeId` 同一条规范）、
`close` 的引用一起换、除第一棵根外全部重挂到 system 根下、`prompt.base` 补 `meta.role`
= `'system'`。逐文件原子替换（临时文件 + rename），失败不指别的文件；全部跑完写
`~/.pi/agent/trace_v2` 标记，之后启动不再扫（与平目录迁移 `migrateFlatTraces()` 同一套模式，
且必须排在它后面）。

## 统计

`traceStats(tree)` 返回 `{turns, steps, toolCalls, errors, retries, durationMs}`。

`turns` 数 `turn.start`、`steps` 数 `step.start` —— **数开口，不数闭合点**。
口径就是顶行那两个字：**你发了一句话 = 一轮；开始调模型 = 一步。**

为什么不能数 `turn.end` / `step.end`：`turn.end` 是在 phase 转 idle **之后**才 flush 的
（见 [loop.md](loop.md) 的第二个 redux-loop 陷阱），而顶行是实时的 —— 数闭合点的话，
模型还在跑的那一轮在界面上就**不算**，「发了一句话」要等它彻底说完才出现。
数开口则相反：正在跑的那一轮立刻计入。
代价是「按 Ctrl-C 硬掐掉的回合」也会被算进去 —— 但那本来也是你发出去了的一句话。

一个坑：`errors` **只数 `kind === 'error'` 的节点**，不能按 `status` 数。失败的容器节点
本身也会被标成 error（它闭合了，只是没推进 tip），连同它的 error 子节点一起数就把一次失败
数成两次。

`retries` 的判据是「同一父节点下有多个 step 容器，且那组里有失败的」。
## 上下文族：提示词与模型也进树

「系统提示词的生成」也在树上，看得到模型当时看到了什么。

| kind | 谁产生 | label | meta |
| --- | --- | --- | --- |
| `prompt.base` | 第一条 `user.message`，或树开过之后的 `prompt.init`（热重载） | system prompt 首行摘要 | — |
| `prompt.tools` | 同上 | 工具名逗号分隔 | `count` |
| `prompt.skills` | 同上 | skill 名逗号分隔 | `count` |
| `model.init` | 第一条 `user.message`（装载） | `provider/model` | `thinking` / `midConvoSystem` / `midConvoTools` / `developerRole` |
| `model.changed` | 换模型 / 换档位后**下一次发话前**（见下） | `provider/model` | 同上 |
| `prompt.segment` | `prompt.segment.added` | 片段首行摘要 | `role` / `source` |
| `extension.event` | 相位级生命周期事件（`extension.lifecycle` action 里**没有专属节点**的那三条） | 事件名（`agent_start` / `agent_end` / `agent_settled`） | `messages`（仅 `agent_end`） |

完整内容在 `detail` 里（prompt 全文、每个工具的 description、片段原文），`label` 只是摘要。

### `extension.event`：相位级生命周期也留痕

内核发给扩展（进而发给 Orca 那类宿主）的 pi 生命周期事件都先 dispatch 成
`extension.lifecycle` action，但**只有没有专属节点的那三条**才在树上落一条
`extension.event` 注释节点：

| 生命周期事件 | 落点 |
| --- | --- |
| `agent_start` / `agent_end` / `agent_settled` | `extension.event` 注释节点（没别处记） |
| `message_end` | `llm.result`（带完整 Message） |
| `tool_execution_start` / `tool_execution_end` | `tool.call` / `tool.result`（带参数、结果、Message） |
| `model_select` | `model.changed` |

意义：「扩展/宿主收到了什么」是一段**该留下证据的历史** —— Orca 的状态面板全靠它，
出了问题也就靠它查。相位级节点只有 label + 一个 `messages` 计数（`agent_end`），
不带 payload 全文。

**不推进 tip**：它是注释，不是「发生过的一件事」的推进点。连续出现时挂在同一条 tip 下，
不会把树抽成一条以事件为轴的链。`traceStats` 也不计它。

> 所以 `tool_execution_*` **不能**反过来代替 `tool.call` / `tool.result`：它只有
> `toolCallId` / `toolName` / `isError`，没有结果内容、没有 Message、不推进 tip，
> 而且未知工具 / 被阻止的调用根本不会发它。它是**通知**，那两条才是**记录**。

### 它们推迟到用户发出第一句话

`prompt.init` / `model.init` **只改 state，不建节点**。上面那四个节点由 reducer 在**第一条
`user.message`** 里补上（`reducer.ts` 的 `beginTrace()`），排在该 user 节点**前面**。

为什么：内核一装配就 dispatch 那两条装载，于是「打开界面还没说话」也已经有了四个节点
（切到轨迹页一打开就是一屏提示词与工具名）。进来看一眼就退出是常态，那些节点是纯噪声。
与 `SessionWriter` 那个「空会话不落盘」是同一个决定，两边现在口径一致 ——
**发过第一句话才算一段会话**。

补出来的节点从 `state.prompt` / `state.model` 读，所以反映的是发第一句话那一刻**生效**的
那一版（期间热重载过也算），与模型真正看到的一致。理由与细节见 [init](init.md)。

### 这一族**不推进 tip**

它们是「上下文」，不是「发生过的事」：

    const TIP_ADVANCING_KINDS = new Set(['user', 'llm.result', 'tool.result', 'stop']);
    // prompt.* 与 model.init 都不在里面

```
○  3f9a2c1 prompt.base: 你是…   ← 根，role=system
│  ○  b21d77e prompt.tools: bash, read
│  ○  8c04e9f model.init: anthropic/claude…
○  51aa0d2 user: 今天几号？      ← 从根长出来
│  ○  … turn.start / step.start / llm.result
└─ …
```

### 它们**不推进 tip**

它们是「上下文」，不是「发生过的事」：

    const TIP_ADVANCING_KINDS = new Set(['user', 'llm.result', 'tool.result', 'stop']);
    // prompt.* 与 model.init 都不在里面

于是装载节点是根下的**平级兄弟**：`prompt.tools` / `prompt.skills` 挂在 `prompt.base`
（根）下面，`model.init` 也挂在根下（它的挂载点是 `attachPoint`，树刚开时 tip 还是
null，于是落在根上），`user` 同样从根长出 —— 全树一根，没有第二条线。

同一次 `prompt.init` 产出的两个节点之间**是**有父子关系的（`prompt.tools` 挂在
`prompt.base` 下）。那里要显式用 base 的 `id` 当 parent，不能用它的 `tipId` ——
`prompt.base` 不推进 tip，取 `tipId` 会拿到装载前的值，两兄弟就散了。

### 重复装载是追加

树已经开过之后再来一条 `prompt.init`（热重载）走 `appendNode` 而非 `patchNode`：
**追加**一对新节点，旧的不改写。生效的是最新那个（`state.prompt` 里是最新值）。

开局前反复 `prompt.init` 则不建任何节点 —— 那时树还没开，等第一句话再从 state 补一次就够了。

### 换模型 / 换思考级别：等到下次发话前补**一个**

`model.changed`（`/model`、`Ctrl+P`、`Ctrl+L`）与 `thinking.changed`（`Shift+Tab`、`/thinking`、
设置面板里改某一档）**都不当场建节点**，只把 `state.modelTraceDirty` 置起来。
真正补进树的是 `flushModelChange()`（`reducer.ts`），落在下一次要发消息的那一刻：
`user.message` / `queue.delivered` 补 user 节点之前、`turn.start` 开容器之前。

为什么要这样：切换是**界面动作**，而树上该回答的是「这一轮实际用的上下文是什么」。
来回切三次模型、又改两次档位，若每次都留节点，两句人话之间就会夹着五个 `model.changed`
——而其中只有最后一个真的生效过。现在：

- 中间切多少次都只留**一个**节点，内容是那一刻生效的那一版；
- 它落在 user 节点（以及 `turn.start`）**之前** —— 读起来就是「这一轮带着这个模型 / 档位」，
  与 `beginTrace()` 补装载节点同一个口径；
- 没换过就不补（`modelTraceDirty` 是唯一判据）。

注意档位是写在 `model.changed` 节点 `meta` 里的（不另开一种 kind）：只改了思考级别时，
补出来的那条节点 model 名字不变、`thinking` 变了 —— 那正是「这一轮上下文变了」的全部事实。
`model.init` 与 `model.changed` **载荷相同**（`ModelSpec`），只差语义：一个是「装载」、
一个是「切换」—— 所以会话流只把 `model.changed` 当配置提示（见 [stream](stream.md)）。

**`prompt.init` 的热重载不走这条路**（它当场追加）：热重载是「文件变了、我们重新读了一遍」，
不是用户在切东西；而且那一刻树上就能看出新 prompt 何时生效，对排查更有用。

### reset 会清掉它们

`conversation.reset` 与 `conversation.restored` 都清空树（连同 prompt.* / model.init / model.changed），
但保留 `state.prompt` / `state.model` —— 那两块是会话级状态。见 [init](init.md)。

`conversation.restored` 额外把「正在跑」的现场（`phase` / `streamingText` /
`thinkingText` / `openLlmNodeId`）带着走，不重置成 `idle`：万一恢复动作发生在环还在跑的时候，
把相位清成 idle 会让那条还在等 token 的流回来时被当成过期丢弃，而新的输入又能发出去 ——
两处都跑，消息流会交叉。

### 统计不计入

`traceStats` 的 `turns` 数 `turn.start`、`toolCalls` 数 `tool.result`，
所以 `prompt.tools` 不会让「调用过工具」计数虚高。

## 相关

- 这些节点什么时候被创建 → [loop](loop.md)
- 上下文压缩（它也开节点）→ [compact](compact.md)
- 在哪儿看 → [surfaces](surfaces.md)
