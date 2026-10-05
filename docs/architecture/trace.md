# 轨迹树

## 为什么是树

Agent 的执行历史不是一条流水。`src/trace.ts` 把它做成**一棵树**，概念直接照搬 git：

| git | 这里 |
| --- | --- |
| commit 有 parent | 每个节点有 `parentId` |
| commit 有分支（`--graph` 里的 `│` `/` `\`） | **重试就是分支** |
| HEAD 指向当前所在的线 | `tipId` = 最后一条推进 tip 的节点 |
| `git reflog` 只追加不改写 | `.trace/<id>.jsonl` 追加写 JSONL |

## 节点模型

```ts
interface TraceNode {
  id: string;                    // "n7"，reducer 内单调自增
  parentId: string | null;       // 根为 null
  kind: 'user' | 'llm.attempt' | 'llm.result'
      | 'tool.attempt' | 'tool.result' | 'error' | 'stop';
  status: 'pending' | 'ok' | 'error' | 'aborted';
  label: string;                 // 短标签，渲染用
  detail?: string;               // 详细文本（回答全文、错误信息、工具参数）
  meta?: Record<string, string>; // provider / model / tool / kind
  createdAt: number;
  endedAt: number | null;        // 与 createdAt 相减得耗时
}
```

`attempt` 是**容器**（一次尝试），`result` / `error` 是它的**结局**。

## 关键规则：只有四类节点推进 tip

```ts
const TIP_ADVANCING_KINDS = new Set(['user', 'llm.result', 'tool.result', 'stop']);

function advancesTip(node) {
  return (node.status === 'ok' || node.status === 'aborted') && TIP_ADVANCING_KINDS.has(node.kind);
}
```

`llm.attempt` / `tool.attempt` 是分叉点，`error` 是失败记录 —— **它们都不推进 tip**。

这条不变量就是「重试的父 id 指向超时前的节点」的全部实现：第一次失败时 attempt 自己闭合了
（status 变 error）但不推进 tip，它的 error 子节点也不推进，于是 tip 原地不动，下一次尝试开
新节点时 parent 拿到的仍是那个从没动过的节点。

## 于是重试长这样

```
✓ n1 user: 今天几号？
├── ✗ n2 llm.attempt: 第 1 次尝试 407ms
│  └── ✗ n3 error: LLM 调用超时（400ms） (kind=timeout)
├── ✗ n4 llm.attempt: 第 2 次尝试（重试） 414ms
│  └── ✗ n5 error: LLM 调用超时（400ms） (kind=timeout)
└── ✓ n6 llm.attempt: 第 3 次尝试（重试） 1.2s
   └── ✓ n7 llm.result: 10 月 5 日
HEAD → n7
```

`n4` 的父 id 是 `n1`（**超时前**的节点），不是 `n3`（失败节点）。失败与重试是**兄弟**。
如果错误节点推进了 tip，重试就会被挂到「错误的子节点才是正史」下面，那就不是 git 了。

## 纯函数

`trace.ts` 里没有 IO、没有 `Date.now()`、没有随机数。节点 id 由 reducer 单调自增（`nextSeq`），
不含时间戳。所以同一串 Action 必然产出同一棵树 —— 能在测试里逐字断言，也能从 JSONL 回放重建。

`appendNode` / `patchNode` 都是返回新树，不改原对象。

## 渲染

`renderTree()` 输出一段 ASCII 树（`--graph` 风格），最后一行是 `HEAD → <tipId>`。
两个界面都调它：

- TUI：`renderColoredTree()`（`src/tui/app.ts`）按节点状态上色，失败的加粗
- Web：`trace-panel.ts` 逐行解析出节点 id，回树里查状态上色

有测试断言「去掉 ANSI 序列后两者逐字相同」，保证两个界面不会各画各的。

## 落盘与回放

`createTracePersistence()`（`src/trace-store.ts`）是个 **store 订阅器**，不是 effect 表里的一行。

为什么不用 Cmd：它几乎每次 dispatch 都要跑（token 增量也会触发），走 Cmd 会把环搅乱；
而且「错误也要持久化」这个要求恰恰需要它**不能**因为出错路径而不执行 —— 一个订阅器对成功与
失败一视同仁，这正是要的语义。

两种 op，追加写 JSONL：

| op | 什么时候 | 内容 |
| --- | --- | --- |
| `add` | 节点首次出现 | 完整字段 |
| `close` | 节点从 `pending` 变成闭合 | 只带 `id` / `status` / `endedAt` |

两个游标各管一段：`persistedSeq`（已 add 到的最大 seq）与 `needClose`（已 add 过、后来闭合的节点）。

选 JSONL 而不是整树覆盖写：崩溃只丢最后没 flush 的一行；追加写不会重写整个文件；
一行一个节点，`wc -l` 就知道这次会话发生过多少次尝试。

**写盘失败不会打断环**：游标不推进，下次状态变化再试一遍，只报一次警告。

回放（`replayTrace`）逐行重放，**坏行直接跳过** —— 崩溃截断的半行丢掉即可。
回放用的 tip 规则与在线推进是同一个 `advancesTip`，否则重放出来的 HEAD 会和当时不一致。

## 统计

`traceStats(tree)` 返回 `{turns, toolCalls, errors, retries, durationMs}`。

一个坑：`errors` **只数 `kind === 'error'` 的节点**，不能按 `status` 数。失败的 attempt 节点
本身也会被标成 error（它闭合了，只是没推进 tip），连同它的 error 子节点一起数就把一次失败
数成两次。

`retries` 的判据是「同一父节点下有多个 attempt 节点」。

## 相关

- 这些节点什么时候被创建 → [loop](loop.md)
- 在哪儿看 → [surfaces](surfaces.md)
