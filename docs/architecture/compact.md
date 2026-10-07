# 上下文压缩（compact）

长会话撑爆窗口时，把老对话换成一段结构化摘要。

## 为什么复用 pi 的算法，一行都不重写

`src/compact.ts` 只做两件事：**决定要不要压**、**把结果落到我们的状态里**。
中间最要紧的两步都直接调 pi-coding-agent 的 `core/compaction/`：

| 环节 | 用 pi 的 | 为什么不能自己写 |
| --- | --- | --- |
| 判定该不该压 | `shouldCompact` | 判据简单，重写没有收益 |
| token 估算 | `estimateTokens`（chars/4，保守高估） | 换一种估法，切点就与 pi 不一致 |
| **找切点** | `findCutPoint` | 见下 |
| **生成摘要** | `generateSummaryWithUsage` | 摘要格式是模型续接时的契约 |
| 摘要的包裹标记 | `COMPACTION_SUMMARY_PREFIX/SUFFIX` | 逐字一致才能与 pi 互相读对方的会话 |
| 溢出识别 | pi-ai 的 `isContextOverflow` | 它维护着 40+ 个 provider 的报错文案匹配 |
| 默认参数 | `DEFAULT_COMPACTION_SETTINGS` | 同上 |

**切点算法的规则不是我们定的，是 pi 定的**，它们都是踩坑定下来的：

- **绝不切在 toolResult 上**（它必须跟在它的 toolCall 后面）。切错了消息序列就是非法的，
  provider 直接报错。
- 切在一轮中间（切到某轮的 assistant 而不是它的 user）时，另做一段「turn prefix」摘要 ——
  否则模型会丢掉「这一轮是谁问的」。
- 往回累积到超过 `keepRecentTokens` 才停，且优先取**离切点最近的那个合法切点**。

自己抄一遍，两边迟早漂移；而漂移的症状是「压缩之后模型突然不知道自己在干嘛」—— 极难归因。

## 与 pi 唯一的差别：会话模型

pi 的切点算法吃 `SessionEntry[]`（带 uuid/parentId 的树，一条 entry 可能产出多条消息）。
我们的 `state.messages` 是**扁平的 `Message[]`**，没有 entry 层。

所以 `planCut()` 把每条消息包成一条「只含这一条消息」的 entry ——
pi 的算法因此退化成「在消息序列里找切点」，语义正好，而规则一字不改。

## 摘要是一条消息，不是一个新字段

```ts
messages = [
  { role: 'user', content: '…<summary>…</summary>', compactionSummary: true, tokensBefore },
  ...保留的尾巴
]
```

**为什么**：对话历史只有一条真相 —— 下一轮请求就是把 `state.messages` 交给 pi-ai。
若摘要另开一个 `state.summary`，就要再改 `effects.ts`（拼进 context）、落盘器（多一种记录）、
回放（多一种重建）—— 三处各有一条「别忘了带上摘要」的隐式约定。
做成消息则都不必改：它自己就是一条消息，会被落盘、被回放、被恢复。

`compactionSummary: true` 是**结构标记**，不用「内容长得像 `<summary>`」去猜 ——
用户完全可能手打一段一模一样的文本，而把那句当成压缩点会让回放丢掉真历史。

## 三条触发路径

| | 谁判定 | 什么时候 |
| --- | --- | --- |
| `manual` | 用户按 `/compact` | 不看阈值 |
| `threshold` | `shouldCompact(contextTokens, window, reserve)` | 一个回合**结束**时 |
| `overflow` | `isContextOverflow(lastMessage, window)` | provider 报了上下文溢出（含「静默溢出」） |

`overflow` 必须在：某些网关**收下**超长请求并正常返回，只在 `usage.input > window` 里露馅
（z.ai、部分自建网关）。不压的话下一次发同样的请求还会失败。

## 自动压为什么是 store 订阅器

压缩**必须**在环彻底停下来时发起 —— 它要整份换掉 `messages`，而 LLM 还在流 / 工具还在跑时换，
那条流回来就找不到自己的 `toolCallId`，消息序列直接变成非法的。

而「环停下来的那一刻」在 redux-loop 里**没有对应的 action**：`llm.done`（无工具时）之后环
不是由某条 action 闭合的，只是没有更多 Cmd 了。造一个「回合结束」action 会要求所有收尾路径
都记得 dispatch 它 —— 漏一次的后果是压缩永远不触发。

订阅器盯 `phase` 从非 idle 变成 idle（记住上一次的状态来判断「刚刚停」），不漏路径。
判据只有一处：`decideCompaction()`。

**踩过的坑**：这个订阅器一开始只装在 `createPersistentStore` 里，于是直接用
`createAgentStore` 的调用方**永远收不到自动压缩**。症状是「长会话一直撞窗口」而没有任何地方
提到过压缩。现在装在 `createAgentStoreWith()` 里 —— 它与落盘无关，压缩是功能、落盘是持久化。

## 三个守卫

| 在哪儿 | 挡什么 | 不挡会怎样 |
| --- | --- | --- |
| `compact.request` | `phase !== 'idle'` | 正在跑的一轮被毁 |
| `compact.request` | 已经 `compacting` | 两次摘要基于同一份历史，后写的覆盖先写的，白花钱还丢信息 |
| `compact.done` / `failed` | `compacting` | 卡在压缩中，之后所有输入都被拒 |

## 小窗口要夹紧参数

`shouldCompact` 的判据是 `tokens > window - reserve`。pi 的默认 `reserve` 是 16384，
而它面向的模型窗口都在 64k 以上，所以那个值总是合理 —— **但我们不保证**（网关目录里
有小窗口模型）。窗口 1000 时阈值变成 `-15384`，**任何一次调用都判定为「该压了」**，
于是每一轮都压一次，白花钱还把对话越压越碎。

`effectiveCompactionSettings()` 按窗口夹紧：`reserve ≤ 20%`、`keepRecent ≤ 50%`。
第二条同样重要：保留的部分必须装得下，否则压完还是超，然后又是「压了还是超」的死循环。

窗口为 0（不知道）时不夹，沿用配置原值。

## 失败绝不改状态

摘要失败（网络、provider 报错、**被 token 上限截断**）时抛错，由 `failActionCreator` 变成
一条 `compact.failed`：树上留 error 节点，`messages` **一个字都不动**，`stopCause` 说清是
压缩失败。

半截摘要绝对不能进 `messages` —— 模型会拿着残缺的「进度」继续干，比不压糟糕得多。
pi 的 `getSummarizationFailure()` 专门拦 `stopReason === 'length'`：那种停止意味着摘要**不完整**。

「没有可压的内容」（切点找不到 / 整段都还在保留窗口里）**不是错误**，但也不能静默：
回一条 `compact.done` 带 `summarizedCount: 0`，界面据此显示「没什么可压的」。
静默才最坏 —— 用户以为压了，实际历史一个字没动。

## 轨迹与落盘

树上一个 `compact` 节点，pending → ok。它**推进 tip**（压缩之后的那条线是从摘要开始的，
不是从被压掉的那段历史延续的）—— 这与 git 里 squash 一段历史之后接上新提交是同一个形状。

摘要消息本身是一条普通 `message` 记录，所以：落盘 → 回放 → 恢复历史全都免费拿到它。
压缩过的会话恢复回来仍然是压缩过的状态，模型不会「想起」被丢掉的那部分（那才是对的：
摘要就是全部上下文了）。

## 配置

`~/.pi/agent/settings.json` 的 `compaction` 段（pi 的官方键名，两边同一份配置）：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`enabled: false` 关掉的是**自动**压；手动 `/compact` 仍然能用。

## 相关

- 对话历史怎么落盘 / 回放 → [sessions](sessions.md)
- 轨迹树与 tip 规则 → [trace](trace.md)
- 上下文占用怎么算 → [surfaces](surfaces.md)