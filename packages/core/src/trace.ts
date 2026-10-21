/**
 * 轨迹树（trace tree）—— 像 git log 一样的一次尝试一节点的结构。
 *
 * 想法照搬 git：执行历史不是一条线而是一棵树（节点有 parentId，重试就是分支，`tipId` 是
 * 「最后一条成功闭合的节点」）。
 *
 * 最关键的一点：**attempt 节点的 parent 取的是「发起时」的 tip，而不是它自己产生的失败结果。**
 * 所以「第 1 次超时 → 记一个 error 节点（不推进 tip）→ 重试」的两次尝试是**兄弟**，树上长成
 * 分叉。若错误节点推进了 tip，第二次尝试就会挂在错误节点底下 —— 那等于说「错误的子节点才是
 * 正确的历史」，不是 git 的语义。
 *
 * 本文件是纯函数：没有 IO、没有 `Date.now()`、没有随机数。同一个 action 序列必然产出同一棵树，
 * 所以树能在 reducer 里算、能在测试里断言、也能从 JSONL 回放重建。
 */
import { uuidv7 } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';

/** 节点类型。 */
/**
 * 节点类型。
 *
 * 分两族：
 *   - **对话族**（user / llm.* / tool.* / error / stop）—— 会推进 tip，是「发生过的事」。
 *   - **上下文族**（prompt.*）—— **不推进 tip**，是「发给模型的上下文长什么样」。
 */
export type TraceNodeKind =
  /** 一条用户消息。 */
  | 'user'
  /**
   * 一个回合的开始（容器）。
   *
   * **不推进 tip** —— 它是容器，闭合点是它的 `turn.end`（或它下面推进 tip 的那个子节点）。
   */
  | 'turn.start'
  /**
   * 一个回合的结束（容器闭合）。
   *
   * 与 `llm.result` / `tool.result` 一样**推进 tip**：它是这一回合的最后一件事，
   * 后面发生的（下一个 turn、用户消息）都从它下面长出来。
   */
  | 'turn.end'
  /**
   * 一步的开始 = 一次 LLM 调用加上它触发的工具批次（容器）。
   *
   * 取代了原先的 `llm.attempt`：语义相同（它就是「一次尝试」的容器，parent 取发起那一刻的 tip），
   * 但名字不预设了「里面一定只有 LLM」—— 一个 step 里还有工具。
   *
   * **不推进 tip**：失败时不推进（否则重试会挂到错误节点下），
   * 成功时也不推进 —— 推进的是它里面的 `llm.result` / `tool.result`。
   */
  | 'step.start'
  /** 一步的结束（容器闭合，不推进 tip —— tip 由里面的 result / error 推进）。 */
  | 'step.end'
  /** 一次 LLM 调用的成功结果。 */
  | 'llm.result'
  /** 一个工具调用。 */
  | 'tool.call'
  /** 一个工具调用的结果。 */
  | 'tool.result'
  /** 某个尝试的失败（超时 / 网络 / 模型报错 / 工具抛错）。 */
  | 'error'
  /** 轮数上限等「主动收工」。 */
  | 'stop'
  /**
   * 一次上下文压缩。
   *
   * 单独一种 kind（而不是复用 prompt.* 或 stop）：压缩是「把老对话换掉」这个事实，
   * 它既不是上下文（prompt.*）、也不是失败或主动收工（stop）。
   * 而且它**恰好是压缩之后 tip 的父节点** —— 压缩之后发生的每一件事都从它下面长出来，
   * 这正是 git 里「squash 掉一段历史，然后接上新提交」的形状。
   */
  | 'compact'
  /** 装载进来的基础 system prompt（prompt.init）。 */
  | 'prompt.base'
  /** 随 prompt 一起装进来的工具定义（prompt.init 的 tools）。 */
  | 'prompt.tools'
  /** 中途追加的一段 prompt（prompt.segment.added）。 */
  | 'prompt.segment'
  /** 装载的 skill 清单（prompt.init 的 skills）。 */
  | 'prompt.skills'
  /** 装载的模型与它的能力（model.init）。 */
  | 'model.init'
  /** 换成了哪个模型 / 哪个档位（model.changed / thinking.changed）。 */
  | 'model.changed'
  /**
   * 一个 **pi agent 生命周期事件**。它既不是对话（不推进 tip），也不是上下文/压缩/失败 ——
   * 它是「内核把什么告诉了扩展/宿主」的**注释**。单独一种 kind 是必要的：`traceStats` 按 kind
   * 数回合/步/工具/错误，这种一个都不该计进去。
   *
   * 不推进 tip：`tool.call` / `tool.result` / `llm.result` 才是「发生过的事」的推进点；让它
   * 推进的话，后面真正的事件会挂到注释底下，树就串成一条以事件为轴的链。
   */
  | 'extension.event'

/**
 * 节点状态。
 *
 * 「闭合」（closed）是这里最重要的概念：**只有 closed 节点会推进 tip**。
 * attempt 节点刚建时是 pending（它不推进 tip，因为它自己就是「发起中」）；
 * 它要么升级成对应的 result 节点（成功），要么挂一个 error 节点（失败）——
 * 两种情况都不推进 tip。真正推进 tip 的是 result / user / stop 这些 closed 节点。
 */
export type TraceNodeStatus = 'pending' | 'ok' | 'error' | 'aborted';

export interface TraceNode {
  /** reducer 内单调自增的整数，转成字符串就是稳定 id（如 "n7"）。 */
  readonly id: string;
  /** 父节点 id；根为 null。 */
  readonly parentId: string | null;
  readonly kind: TraceNodeKind;
  readonly status: TraceNodeStatus;
  /** 短标签，渲染时显示。 */
  readonly label: string;
  /** 详细文本（LLM 回答全文、错误信息、工具参数…）。 */
  readonly detail?: string | undefined;
  /** 工具名 / provider / model 之类的附加信息。 */
  readonly meta?: Readonly<Record<string, string>> | undefined;
  /**
   * 这条节点对应的 **pi 消息**（user / assistant / toolResult / 中途追加的 system 段）。
   *
   * 消息挂在节点上：时间线**从轨迹树派生**，要派生无损，节点就得自己带着那份消息 —— 否则还得
   * 回头读 `state.messages`，而那是**发给模型**的那份（会被压缩替换、恢复重灌），两边迟早对不上。
   * 于是 `state.messages` 只服务 LLM 请求，界面一个字节都不读它。
   *
   * 只有「会产生一条消息」的节点才有它。**可选**：旧轨迹文件里消息单独落在 `op:'message'` 行，
   * 派生时退回 `fallbackMessages`。
   */
  readonly message?: Message | undefined;
  readonly createdAt: number;
  /** 闭合时刻（未闭合为 null）；与 createdAt 相减得到耗时。 */
  readonly endedAt: number | null;
}

export interface TraceTree {
  /** 扁平节点表，按 id 索引。 */
  readonly nodes: Readonly<Record<string, TraceNode>>;
  /** 插入顺序（= 时间顺序），用于稳定渲染。 */
  readonly order: readonly string[];
  /** 最后一条 closed 节点的 id；null 表示还没有。 */
  readonly tipId: string | null;
  /** 自增计数器，节点 id 的来源。 */
  readonly nextSeq: number;
  /** 会话 id（持久化文件名用它）。 */
  readonly sessionId: string;
}

/**
 * 生成会话 id：**UUIDv7**，与 pi 完全同一形状（直接用 pi-ai 导出的 `uuidv7()`）。
 *
 * 不用 `s<base36 时间戳>`：那种 id 在同一毫秒内两次开新会话会撞，于是两次会话续写同一个文件；
 * 而且与 pi 的 id 形状不同，把我们的 id 粘给 pi 的 `--session` 就不成立。UUIDv7 是时间有序的，
 * 既不会撞又能按创建顺序排。id 里不再有可读时间，时间在**文件名**里。
 */
export function newSessionId(): string {
  return uuidv7();
}

export function createTraceTree(sessionId: string): TraceTree {
  return { nodes: {}, order: [], tipId: null, nextSeq: 1, sessionId };
}

function nextNodeId(tree: TraceTree): { id: string; seq: number } {
  const seq = tree.nextSeq;
  return { id: `n${seq}`, seq };
}

/**
 * 只有这几类节点推进 tip。**容器（turn.* / step.start）永远不推进** ——
 * 它们是分叉的容器，闭合点是里面的 result / error / turn.end 子节点。
 *
 * 这条规则正是「重试的父 id 指向超时前的节点」的根本原因：失败的 step 容器自己不闭合，
 * 挂在它下面的 error 节点也不闭合（error 不在这个集合里），
 * 于是 tip 原地不动，下一次尝试的 parent 仍然取到超时前那个节点。
 */
const TIP_ADVANCING_KINDS: ReadonlySet<TraceNodeKind> = new Set<TraceNodeKind>([
  'user',
  'turn.end',
  'llm.result',
  'tool.result',
  'stop',
  'compact',
]);

function advancesTip(node: TraceNode): boolean {
  return (node.status === 'ok' || node.status === 'aborted') && TIP_ADVANCING_KINDS.has(node.kind);
}

/** 建一棵新树：树根 id 为 null 的第一个节点。 */
export function appendNode(
  tree: TraceTree,
  parentId: string | null,
  kind: TraceNodeKind,
  options: {
    status: TraceNodeStatus;
    label: string;
    detail?: string | undefined;
    meta?: Readonly<Record<string, string>> | undefined;
    /** 这条节点对应的 pi 消息（见 `TraceNode.message`）。 */
    message?: Message | undefined;
    createdAt: number;
    endedAt?: number | null | undefined;
  },
): { tree: TraceTree; node: TraceNode } {
  const { id, seq } = nextNodeId(tree);
  const node: TraceNode = {
    id,
    // 显式接受 null（根），不继承父节点 —— parentId 就是调用方在**发起那一刻**的 tip。
    parentId: parentId === null ? null : parentId,
    kind,
    status: options.status,
    label: options.label,
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
    ...(options.meta !== undefined ? { meta: options.meta } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
    createdAt: options.createdAt,
    endedAt: options.endedAt === undefined ? null : options.endedAt,
  };
  const nodes: Record<string, TraceNode> = { ...tree.nodes, [id]: node };
  return {
    tree: {
      ...tree,
      nodes,
      order: [...tree.order, id],
      nextSeq: seq + 1,
      tipId: advancesTip(node) ? id : tree.tipId,
    },
    node,
  };
}

/**
 * 就地更新一个节点（闭合 attempt、补 detail 等）。没有这个节点就原样返回。
 *
 * 闭合一个 attempt（pending → ok）**不会**推进 tip：它只是把 attempt 这个容器标成已完成，
 * 推进 tip 的是它的 llm.result / tool.result 子节点。
 */
export function patchNode(
  tree: TraceTree,
  id: string,
  patch: {
    status?: TraceNodeStatus;
    label?: string;
    detail?: string | undefined;
    meta?: Readonly<Record<string, string>> | undefined;
    endedAt?: number | null | undefined;
  },
): TraceTree {
  const existing = tree.nodes[id];
  if (!existing) return tree;
  const node: TraceNode = {
    ...existing,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
    ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
    ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
  };
  return {
    ...tree,
    nodes: { ...tree.nodes, [id]: node },
    tipId: advancesTip(node) ? id : tree.tipId,
  };
}


export function getNode(tree: TraceTree, id: string): TraceNode | undefined {
  return tree.nodes[id];
}

/**
 * 某个节点的孩子（按插入顺序）。
 *
 * 扫一遍 `tree.order`，是 O(N)。**所以不要在循环里反复叫它** ——
 * `traceStats()` 里那段「对每个 `step.start` 问一次它的兄弟」曾经就是这样，
 * 两者相乘 O(N²)，实测 800 节点时单次 42ms（节点翻倍约 5 倍），
 * 表现就是「长会话里每个流式 token 都卡一下」。那里现在按 `parentId` 分桶一次算完。
 */
export function childrenOf(tree: TraceTree, id: string | null): TraceNode[] {
  return tree.order
    .map((childId) => tree.nodes[childId])
    .filter((node): node is TraceNode => node !== undefined && node.parentId === id);
}

/** 从根到某节点的祖先链（含自己），用于展示「当前在哪条线上」。 */
export function pathTo(tree: TraceTree, id: string): TraceNode[] {
  const chain: TraceNode[] = [];
  let cursor: string | null = id;
  while (cursor !== null) {
    const node: TraceNode | undefined = tree.nodes[cursor];
    if (!node) break;
    chain.unshift(node);
    cursor = node.parentId;
  }
  return chain;
}

/** 从根到 tip 的那条线（git log HEAD 看到的那条线）。 */
export function headPath(tree: TraceTree): TraceNode[] {
  return tree.tipId === null ? [] : pathTo(tree, tree.tipId);
}

export interface TraceStats {
  turns: number;
  steps: number;
  toolCalls: number;
  errors: number;
  retries: number;
  /** 累计耗时（所有已闭合节点）。 */
  durationMs: number;
}

export function traceStats(tree: TraceTree): TraceStats {
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let errors = 0;
  let durationMs = 0;
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node) continue;
    // 回合数 = `turn.start` 的个数 —— 「**你发了一句话**就是一个回合」。
    //
    // 为什么数开口而不是闭合点（原先数 `turn.end`）：`turn.end` 是 phase 转 idle
    // **之后**才 flush 的（见 docs/architecture/loop.md 的第二个 redux-loop 陷阱），
    // 而顶行是实时显示的 —— 数开口的话，模型还在跑那一轮就已经算上了。
    // 反过来的代价是「按 Ctrl-C 硬掐掉的回合」也会被算进去：那本来也是你发出去了的一句话。
    if (node.kind === 'turn.start') turns += 1;
    // 步数 = `step.start` 的个数 —— 同理，与「轮」同口径：「**开始调模型**就是一步」。
    //
    // 重试会另开一个 step，所以「步」> 「轮」里的 ReAct 循环长度（含重试）；两个数一起看才说得清。
    if (node.kind === 'step.start') steps += 1;
    if (node.kind === 'tool.result') toolCalls += 1;
    // 只数 kind==='error' 的**错误节点**。不能按 status 数：失败的容器节点本身也会被
    // 标成 error（它闭合了，但没推进 tip），连同它的 error 子节点一起数就把一次失败数成两次。
    if (node.kind === 'error') errors += 1;
    if (node.endedAt !== null) durationMs += node.endedAt - node.createdAt;
  }
// 「重试」= 同一个父节点下有**多个 step 容器**。只数 step.start，**不能把 tool.call 算进来**：
// 模型一轮里并行发两个工具时它们是同一个 llm.result 下的兄弟，按「多兄弟即重试」会虚增重试。
//
// 一遍扫描就够：「同父下已见过几个 step.start」与「那组里有没有失败」各按 parentId 分桶计数，
// 于是不需要 `childrenOf()`（每次重扫 `tree.order`），也不需要事后 `filter` + `indexOf`
// （同父下很多 step 时是 O(k²)，而那正是重试链的形状）。判据口径与渲染层 `isForkGroup` 一致。
  let retries = 0;
  if (steps > 0) {
    /** parentId → 迄今见过的 step.start 个数。 */
    const seenSteps = new Map<string, number>();
    /** parentId → 那组里有没有失败过的 step。 */
    const groupFailed = new Set<string>();
    for (const id of tree.order) {
      const node = tree.nodes[id];
      if (!node || node.parentId === null) continue;
      if (node.kind !== 'step.start') continue;
      const parentId = node.parentId;
      const seenBefore = seenSteps.get(parentId) ?? 0;
      // index > 0：它是同父下的第 2 个及以后的尝试。
      //
      // **而且那组里必须有失败的** —— 一个回合里模型本来就会跑好几个 step
      // （模型→工具→模型→工具…），那是**同一个回合的正常推进**，不是重试。
      // 早期版本写成「同父下有多个 step.start 就是重试」，于是每个正常回合都虚增一次
      // —— 而顶栏恰恰显示这个数，用户会看到「重试 3」却一次超时都没发生。
      if (seenBefore > 0 && groupFailed.has(parentId)) retries += 1;
      seenSteps.set(parentId, seenBefore + 1);
      // 失败标记要在**本轮之后**才可能影响后面的兄弟 —— 同一个 step 自己失败了
      // 不该把自己算成重试（它没有更早的兄弟）。而它失败要让**下一个** step 记上，
      // 所以直接写在同一个循环里，顺序天然对。
      if (node.status === 'error') groupFailed.add(parentId);
    }
  }

  return { turns, steps, toolCalls, errors, retries, durationMs };
}

// ─── 渲染：lazygit 风格的轨道树 ───

/**
 * 一行轨迹的渲染结果。
 *
 * `prefix` 单独给出来，是因为界面（`TraceChunks`）要**按节点上色**：它只要知道
 * 「这一行自己的轨道长什么样」，不必知道别人怎么画。而 `renderTree()` 要的是
 * 整段字符串。两者共用同一个 `traceRows()`，所以命令行里看到的与界面里看到的
 * 永远是同一份画法（不会各画各的）。
 */
export interface TraceRow {
  readonly node: TraceNode;
  /** 行首的轨道 + 节点符号（纯文本，不含颜色）。 */
  readonly prefix: string;
  /** 整行文本 = prefix + id + kind + label + 耗时 + meta，已按 maxWidth 截断。 */
  readonly text: string;
}

export interface TreeRenderOptions {
  /** 宽度上限，超出截断。默认 100，0 表示不截。 */
  readonly maxWidth?: number;
}

/**
 * 会**给子孙加一级缩进**的容器 kind —— 就是「轮」与「步」这两个。
 *
 * 为什么只有它俩（而不是「每个父节点都给自己的孩子加缩进」）见 `traceRows()` 的长注释：
 * 轨迹树的链是一条直线，按父子关系缩进会随回合数一格格往右跑。
 */
const SCOPE_OPEN_KINDS: ReadonlySet<TraceNodeKind> = new Set<TraceNodeKind>([
  'turn.start',
  'step.start',
]);

/**
 * 容器的**闭合点**（`turn.start` → `turn.end`，`step.start` → `step.end`）：画在自己**容器那一
 * 列**（缩进不 +1），符号 `└─`，于是括号是闭合的。
 */
const SCOPE_CLOSE_KINDS: ReadonlySet<TraceNodeKind> = new Set<TraceNodeKind>([
  'turn.end',
  'step.end',
]);

/** 一级轨道的宽度（3）。下面几个符号必须同宽，否则竖线会错位。 */
const RAIL = '│  ';
/**
 * 节点圆点 —— **所有节点都用它**（包括当前 tip）。
 *
 * tip 也用同一个圆点，靠**加粗**区分（`renderColoredTree()` / `TraceChunks.lineOf()` 给的）——
 * 两种字形读起来像画错了。这里（纯文本层）不需要 tipId：加粗是属性，不属于字形。
 */
const DOT = '○  ';
/**
 * 容器的闭合点（`turn.end` / `step.end`）。
 *
 * 拐角与圆点同宽，所以闭合点**同时**是 tip 时也不需要另造一个 `└◎`：加粗落在这一行上。
 */
const CORNER = '└─ ';

function truncate(text: string, width: number): string {
  if (width <= 0) return text;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function metaSuffix(node: TraceNode): string {
  if (!node.meta) return '';
  const entries = Object.entries(node.meta);
  if (entries.length === 0) return '';
  return ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})`;
}

/**
 * 把整棵树算成一行一行（含每行的轨道前缀）。形状仿 lazygit 的 `--graph`：每个节点一个圆点，
 * 左边是它所在各层容器的竖线。
 *
 * ```
 * ○  n1 user: 查两个
 * ○  n2 turn.start: 回合 1
 * │  ○  n3 step.start: 第 1 步
 * │  │  ○  n4 llm.result: 并行 [调用 bash] [调用 bash]
 * │  └─ n7 step.end: 第 1 步结束（2 个工具调用）
 * └─ n8 turn.end: 回合 1 结束：模型说完了
 * ```
 *
 * **tip 不在这层表达**：加粗由 `renderColoredTree()` / `TraceChunks.lineOf()` 按 `tree.tipId`
 * 做。这里刻意不给 tip 造第二个字形（纯文本路径没有 tip 标记）。
 *
 * **缩进只由容器给**（`turn.start` 与 `step.start` 无条件给子孙加一级，别的节点不加）。
 * 不按父子关系缩进：轨迹树的链是一条直线，按父子缩进会让第 10 轮跑到第 10 层、长出一条永远
 * 往右的阶梯；按容器缩进时 `turn.end` / `step.end` 画在自己那一列，缩进用完即还。
 * `llm.result` → `tool.call` → `tool.result` 也不再分级：它们是步里面的内容，标签就在旁边。
 *
 * 实现：按 `tree.order`（= 发生顺序）扫一遍维护一个作用域栈 —— 容器的**关闭时机**是事件性的，
 * 只看树不够。每行 O(1)，整棵树 O(N)。四条收口规则：
 *
 * | 遇到 | 做什么 | 为什么 |
 * | --- | --- | --- |
 * | `turn.end` / `step.end` | 关掉 `parentId` 那个作用域（连里面还开着的） | 闭合点画在容器那一列 |
 * | `turn.start` | 清空（回合不嵌套） | 上一个回合没等到 `turn.end` 时也要收 |
 * | `step.start` | 先关掉已经开着的 step | 旧的那一格不该还挂着 |
 * | `user`（`meta.queued !== 'steer'`） | **清空**整个栈 | 「用户又发了一句话」= 新回合从根层开始 |
 *
 * 最后一条必要：「回合结束了而 `turn.end` 还没落下来」是真实存在的中间态（`turn.end` 是环转
 * idle 之后另发的 Cmd）。那时新一句话的 parent 取 tip、落点在上一个回合**里面**，只认树的话
 * 第二轮会被缩进进上一轮的括号。`meta.queued === 'steer'` 是唯一例外：插话**属于**当前回合。
 */
export function traceRows(tree: TraceTree, options: TreeRenderOptions = {}): TraceRow[] {
  const maxWidth = options.maxWidth ?? 100;
  const order = tree.order;
  if (order.length === 0) return [];

  const rows: TraceRow[] = [];
  /** 当前开着的作用域（容器），栈顶是最内层。 */
  const stack: { id: string; kind: TraceNodeKind }[] = [];

  /** 关掉 `id` 这个容器：它自己和它里面还开着的都弹掉。没开着就什么也不做。 */
  const closeScope = (id: string | null): void => {
    if (id === null) return;
    const at = stack.findIndex((scope) => scope.id === id);
    if (at >= 0) stack.length = at;
  };

  for (const id of order) {
    const node = tree.nodes[id];
    if (node === undefined) continue;

    // 先收口（见上面那张表），再画这一行。
    switch (node.kind) {
      // 闭合点：把自己那个容器关掉。**先弹栈再画** —— 于是 `step.end` 与 `step.start`
      // 同列（`└─`），括号才是闭合的。这一步弄反就会得到「闭合线比容器深一级」的错位。
      case 'turn.end':
      case 'step.end':
        closeScope(node.parentId);
        break;
      // 新回合：上一个回合的作用域收掉（回合不嵌套）。
      case 'turn.start':
        stack.length = 0;
        break;
      // 新的一步：上一个还没关的 step 收掉。
      case 'step.start': {
        const at = stack.findIndex((scope) => scope.kind === 'step.start');
        if (at >= 0) stack.length = at;
        break;
      }
      // 用户又发了一句话（不是插话）= 新回合，从根层重新开始缩进。
      case 'user':
        if (node.meta?.['queued'] !== 'steer') stack.length = 0;
        break;
      default:
        break;
    }

    const marker = SCOPE_CLOSE_KINDS.has(node.kind) ? CORNER : DOT;
    const prefix = RAIL.repeat(stack.length) + marker;
    const elapsed = node.endedAt === null ? '' : ` ${formatDuration(node.endedAt - node.createdAt)}`;
    const head = `${prefix}${node.id} ${node.kind}: ${node.label}${elapsed}${metaSuffix(node)}`;
    rows.push({ node, prefix, text: truncate(head, maxWidth) });

    if (SCOPE_OPEN_KINDS.has(node.kind)) stack.push({ id: node.id, kind: node.kind });
  }

  return rows;
}

/**
 * 把树渲染成多行字符串（画法见 `traceRows()`，这里只负责拼成文本）。
 *
 * 没有 `HEAD → <tipId>` 那一行：tip 就是树上那一行（加粗），再写一行说的是同一件事。这里打的
 * 是纯文本、看不出 tip —— 看得见的那条路是 `renderColoredTree()`。
 */
export function renderTree(tree: TraceTree, options: TreeRenderOptions = {}): string {
  const rows = traceRows(tree, options);
  if (rows.length === 0) return '（轨迹为空）';
  return rows.map((row) => row.text).join('\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}


/**
 * 落盘 / 传输用的节点形状。刻意用扁平数组（而不是嵌套 children）：
 * 追加写 JSONL 时每行独立可解析，崩溃也只丢最后一行；回放时重建父子关系。
 */
export interface SerializedTraceNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: TraceNodeKind;
  readonly status: TraceNodeStatus;
  readonly label: string;
  // 显式带 | undefined：exactOptionalPropertyTypes 下，TraceNode 的可选项才能直接赋过来。
  readonly detail?: string | undefined;
  readonly meta?: Record<string, string> | undefined;
  /** 这条节点对应的 pi 消息（见 `TraceNode.message`）。 */
  readonly message?: Message | undefined;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

export interface SerializedTrace {
  readonly sessionId: string;
  readonly nodes: readonly SerializedTraceNode[];
  readonly tipId: string | null;
  readonly nextSeq: number;
}

export function serializeTree(tree: TraceTree): SerializedTrace {
  return {
    sessionId: tree.sessionId,
    nodes: tree.order
      .map((id) => tree.nodes[id])
      .filter((node): node is TraceNode => node !== undefined)
      .map((node) => ({
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        status: node.status,
        label: node.label,
        ...(node.detail !== undefined ? { detail: node.detail } : {}),
        ...(node.meta !== undefined ? { meta: { ...node.meta } } : {}),
        ...(node.message !== undefined ? { message: node.message } : {}),
        createdAt: node.createdAt,
        endedAt: node.endedAt,
      })),
    tipId: tree.tipId,
    nextSeq: tree.nextSeq,
  };
}

/** 从 JSONL 的一行回放：重放每条记录，得到与当初一致的树。 */
export function applyTraceRecord(tree: TraceTree, record: SerializedTraceNode): TraceTree {
  const seq = Number.parseInt(record.id.replace(/^n/, ''), 10);
  const nodes: Record<string, TraceNode> = { ...tree.nodes, [record.id]: { ...record } };
  return {
    ...tree,
    nodes,
    order: tree.order.includes(record.id) ? tree.order : [...tree.order, record.id],
    nextSeq: Number.isNaN(seq) ? tree.nextSeq : Math.max(tree.nextSeq, seq + 1),
    // 回放必须与在线推进用同一条规则，否则重放出来的 HEAD 会和当时不一致。
    tipId: advancesTip({ ...record }) ? record.id : tree.tipId,
  };
}

export function deserializeTree(data: SerializedTrace): TraceTree {
  const base = createTraceTree(data.sessionId);
  const tree = data.nodes.reduce(applyTraceRecord, base);
  return { ...tree, nextSeq: Math.max(tree.nextSeq, data.nextSeq), tipId: data.tipId };
}
