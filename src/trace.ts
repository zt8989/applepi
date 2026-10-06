/**
 * 轨迹树（trace tree）—— 像 git log 一样的一次尝试一节点的结构。
 *
 * 想法直接照搬 git：agent 的执行历史不是一条线，而是**一棵树**。
 *   - 每个 commit 有一个 parent；这里每个节点有 parentId。
 *   - commit 有分支（--graph 里的 `|`、`/`、`\`）；这里重试就是分支。
 *   - HEAD 指向当前所在的那条线；这里 tipId 是「最后一条成功闭合的节点」。
 *
 * 关键设计（也是这个需求里最容易做错的地方）：
 *
 *   **attempt（尝试）节点的 parent 取的是「发起时」的 tip，而不是它自己产生的失败结果。**
 *
 *   所以：LLM 第 1 次调用超时 → 记一个 status='error' 的 `llm.attempt` 节点（不推进 tip），
 *   重试第 2 次 → 它的 parent 仍然是「超时前那个节点」。于是重试和失败是**兄弟**，
 *   树上长成 git 那样的分叉：
 *
 *        · user                 ← tip（超时前）
 *        ├─ ✗ llm.attempt       ← 父 id 指向上面那个节点
 *        │   └─ llm.error: LLM 调用超时（30s）
 *        └─ ✓ llm.attempt       ← 父 id 同样指向上面那个节点（不是指向上一条失败）
 *            └─ llm.result: 42
 *
 *   如果错误节点推进了 tip，第二次尝试就会被挂到错误节点底下，变成
 *   「错误的子节点才是正确的历史」——那就不是 git 的语义了。
 *
 * 本文件是纯函数：没有 IO、没有 Date.now()、没有随机数。同一个 Action 序列
 * 必然产出同一棵树（id 由 reducer 单调自增，不含时间戳），因此树可以在
 * reducer 里算，也可以在测试里断言，还能在 TUI 侧从 JSONL 回放重建。
 */

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
  /** 一次 LLM 调用尝试（可能在跑，也已成功或失败）。 */
  | 'llm.attempt'
  /** 一次 LLM 调用的成功结果。 */
  | 'llm.result'
  /** 一个工具调用尝试。 */
  | 'tool.attempt'
  /** 一个工具调用的结果。 */
  | 'tool.result'
  /** 某个尝试的失败（超时 / 网络 / 模型报错 / 工具抛错）。 */
  | 'error'
  /** 轮数上限等「主动收工」。 */
  | 'stop'
  /** 装载进来的基础 system prompt（prompt.init）。 */
  | 'prompt.base'
  /** 随 prompt 一起装进来的工具定义（prompt.init 的 tools）。 */
  | 'prompt.tools'
  /** 中途追加的一段 prompt（prompt.segment.added）。 */
  | 'prompt.segment'
  /** 装载的模型与它的能力（model.init）。 */
  | 'model.init'

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

/** 生成会话 id 的工具函数（调用方决定是否注入 Date.now，让测试可复现）。 */
export function newSessionId(now: number = Date.now()): string {
  return `s${now.toString(36)}`;
}

export function createTraceTree(sessionId: string): TraceTree {
  return { nodes: {}, order: [], tipId: null, nextSeq: 1, sessionId };
}

function nextNodeId(tree: TraceTree): { id: string; seq: number } {
  const seq = tree.nextSeq;
  return { id: `n${seq}`, seq };
}

/**
 * 只有这几类节点推进 tip。attempt 节点**永远不推进** —— 它是容器（分叉点），
 * 它的 result / error 子节点才是闭合点。
 *
 * 这条规则正是「重试的父 id 指向超时前的节点」的根本原因：失败的 attempt 自己不闭合，
 * 挂在它下面的 error 节点也不闭合（error 不在 TIP_ADVANCING_KINDS 里），
 * 于是 tip 原地不动，下一次尝试的 parent 仍然取到超时前那个节点。
 */
const TIP_ADVANCING_KINDS: ReadonlySet<TraceNodeKind> = new Set<TraceNodeKind>([
  'user',
  'llm.result',
  'tool.result',
  'stop',
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

// ─── 查询 ───

export function getNode(tree: TraceTree, id: string): TraceNode | undefined {
  return tree.nodes[id];
}

/** 某个节点的孩子（按插入顺序）。 */
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
  toolCalls: number;
  errors: number;
  retries: number;
  /** 累计耗时（所有已闭合节点）。 */
  durationMs: number;
}

export function traceStats(tree: TraceTree): TraceStats {
  let turns = 0;
  let toolCalls = 0;
  let errors = 0;
  let durationMs = 0;
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node) continue;
    if (node.kind === 'llm.result') turns += 1;
    if (node.kind === 'tool.result') toolCalls += 1;
    // 只数 kind==='error' 的**错误节点**。不能按 status 数：失败的 attempt 节点本身也会被
    // 标成 error（它闭合了，但没推进 tip），连同它的 error 子节点一起数就把一次失败数成两次。
    if (node.kind === 'error') errors += 1;
    if (node.endedAt !== null) durationMs += node.endedAt - node.createdAt;
  }
  // 「重试」= 同一个父节点下有**多个 LLM 尝试**（说明前一个没成，走了分支）。
  //
  // 只数 llm.attempt，**不能把 tool.attempt 算进来**：模型一轮里并行发两个工具时，
  // 这两个 tool.attempt 是同一个 llm.result 下的兄弟节点，按「多兄弟即重试」的判据会被记成一次重试。
  // 之前把工具也算上，于是每轮并行调用都虚增一个「重试」（实测一轮 2 个 bash 就 +1）。
  let retries = 0;
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node || node.parentId === null) continue;
    if (node.kind !== 'llm.attempt') continue;
    const attempts = childrenOf(tree, node.parentId).filter((c) => c.kind === 'llm.attempt');
    // index > 0：它是同父下的第 2 个及以后的尝试，也就是「前一个失败后的重试」。
    if (attempts.indexOf(node) > 0) {
      retries += 1;
    }
  }

  return { turns, toolCalls, errors, retries, durationMs };
}

// ─── 渲染：ASCII 树（--graph 风格） ───

export interface TreeRenderOptions {
  /** 树枝缩进宽度，默认 3（`├─ ` 的宽度）；改成别的值竖线会错位。 */
  readonly branchWidth?: number;
  /** 某个节点是否展开（默认全部展开）。 */
  readonly collapsed?: ReadonlySet<string> | undefined;
  /** 标出 tip 节点与根节点。 */
  readonly marks?: Readonly<Record<string, string>> | undefined;
  /** 宽度上限，超出截断。默认 100，0 表示不截。 */
  readonly maxWidth?: number;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return text;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function statusMark(node: TraceNode): string {
  switch (node.status) {
    case 'ok':
      return '✓';
    case 'error':
      return '✗';
    case 'aborted':
      return '⊘';
    case 'pending':
      return '·';
  }
}

function metaSuffix(node: TraceNode): string {
  if (!node.meta) return '';
  const entries = Object.entries(node.meta);
  if (entries.length === 0) return '';
  return ` (${entries.map(([k, v]) => `${k}=${v}`).join(', ')})`;
}

/**
 * 把树渲染成多行字符串。最后一行是 tip 标记（类似 git log 显示 HEAD）。
 *
 * ## 渲染策略：整棵树拉平，**只有错误才画出分叉**
 *
 * 一次**正常**对话在树里是一条长链：user → attempt → result → tool → result →
 * attempt → result …，有时还会并排几个工具（多个 tool.attempt 兄弟）。按 git 那样
 * 层层缩进，它是 5~7 层的阶梯，右半边全空着，而它**没有任何分支** —— 树形在这里是噪声。
 *
 * 所以规则是：**一组兄弟节点里没有失败，就整组不缩进**（就是一串平铺的行）。
 * 只有出现了失败，才切回树枝画法：
 *
 *   - 重试：同父下第 2 个及以后的 llm.attempt（前面那次失败）;
 *   - 并行工具：一个 llm.result 下多个 tool.attempt，**其中至少一个失败**；
 *   - 失败的工具调用：它和兄弟（哪怕成功的）一起挂成一小棵树。
 *
 * 单孩子永远不缩进 —— 没有分叉就没有要画的树枝。根节点（prompt.* / model.init / user
 * 那些「各自起头」的节点）也永远平铺：它们本来就是并列的一串，缩进会伪造出父子关系。
 *
 * 于是「正常 = 列表，出错 = 在出错的那里长出一小棵树」：
 *
 * ```
 * ✓ n1 user: 今天几号？
 * ✓ n2 llm.attempt: 第 1 次尝试 407ms
 * ✗ n3 llm.attempt: 第 2 次尝试（重试） 414ms
 * │  ✗ n4 error: LLM 调用超时（400ms） (kind=timeout)
 * ...
 * ```
 *
 * 树本身一点没变（还是同一棵树、同一套父子关系），只是**画法**不同 ——
 * `tipId`、分叉语义、回放全都不受影响。
 */

/** 这个节点算不算「出事了」。kind='error' 与 status='error' 都算（前者是错误节点，后者是失败的 attempt）。 */
function nodeFailed(node: TraceNode): boolean {
  return node.kind === 'error' || node.status === 'error';
}

/**
 * 一组兄弟节点要不要画树枝（= 是不是一次值得展开的分叉）。
 *
 * 判据是**「多于一个孩子，且其中至少一个失败」**，不是「多于一个孩子」：
 * 一轮里并行发三个工具、三个都成功，那只是「列表里有三行」，不是分叉；缩进它等于
 * 声称「第二、三个工具依赖第一个」，那是假的结构，用户会照着它推断因果。
 *
 * 只有一个孩子也返回 false：没有兄弟就没有分叉可言。
 */
export function isForkGroup(children: readonly TraceNode[]): boolean {
  if (children.length < 2) return false;
  return children.some(nodeFailed);
}
export function renderTree(tree: TraceTree, options: TreeRenderOptions = {}): string {
  // 树枝前缀恒为 3 字符（'├─ '），竖线也画在同一列，所以默认 3。
  const branchWidth = options.branchWidth ?? 3;
  const maxWidth = options.maxWidth ?? 100;
  const marks = options.marks ?? {};
  const lines: string[] = [];

  // 哪些节点是需要画树枝的「分叉组」的孩子。预先算好，别在循环里反复 childrenOf。
  const isForkChild = new Set<string>();
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node || node.parentId === null) continue;
    const siblings = childrenOf(tree, node.parentId);
    if (siblings.length > 1 && isForkGroup(siblings)) isForkChild.add(id);
  }

  /**
   * 某个节点该有的行首缩进。
   *
   * 规则：沿父链往上走，只数**分叉组**。每经过一个分叉组加一级缩进，中间那些单链的
   * 祖先**不占缩进** —— 于是正常对话是平铺的列表，只有出错的那一处（以及它下游跟着走的
   * 那几条线）才长出树枝。
   *
   * 注意这里数的是「祖先里的分叉组个数」，不是「祖先个数」：数后者会让一条纯单链
   * 照样一级一级往下缩 —— 那就等于没拉平。
   */
  const prefixOf = (id: string): string => {
    // 先沿父链收集「祖先里那些分叉组的孩子」（不含自己），从根到近排列。
    const forks: { last: boolean }[] = [];
    let cursor: string | null = tree.nodes[id]?.parentId ?? null;
    while (cursor !== null) {
      if (isForkChild.has(cursor)) forks.unshift({ last: isLastOf(cursor) });
      cursor = tree.nodes[cursor]?.parentId ?? null;
    }
    // 每个分叉组贡献一级缩进：组内不是最后一个就画竖线（后面还有兄弟），否则画空白。
    let prefix = '';
    for (const fork of forks) {
      prefix += fork.last ? ' '.repeat(branchWidth) : `│${' '.repeat(branchWidth - 1)}`;
    }
    // 自己那一级：只有自己也是分叉组的一员才画树枝。
    if (isForkChild.has(id)) {
      prefix += `${isLastOf(id) ? '└' : '├'}${'─'.repeat(branchWidth - 1)} `;
    }
    return prefix;
  };

  /** 它是不是自己那组兄弟里的最后一个（决定 ├─ 还是 └─）。 */
  const isLastOf = (id: string): boolean => {
    const parentId = tree.nodes[id]?.parentId ?? null;
    const siblings = childrenOf(tree, parentId);
    return siblings.length > 0 && siblings[siblings.length - 1]?.id === id;
  };

  // ── 按**发生顺序**（tree.order）逐行输出 ──
  //
  // 为什么不递归 walk：那会变成深度优先 —— 一个节点有两个孩子（并行工具）时，
  // 第一个孩子的整条下游（→ 下一轮 LLM → 下一批工具 → … 一直到会话末尾）会全部先打印，
  // 第二个孩子才轮得到。真实轨迹里这会让**最新的节点出现在中间**、最早的那个反而在底部，
  // 而用户在界面上看到的是一份时间倒流的记录。
  //
  // tree.order 就是落盘顺序，也就是「事情发生的顺序」；节点 id 单调自增，与它一致。
  // 缩进不改变顺序，只改变每行前面画什么 —— 两者互不干扰。
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node) continue;
    const mark = statusMark(node);
    const elapsed = node.endedAt === null ? '' : ` ${formatDuration(node.endedAt - node.createdAt)}`;
    const head =
      `${prefixOf(id)}${mark} ${marks[node.id] ?? ''}${node.id} ${node.kind}: ${node.label}` +
      `${elapsed}${metaSuffix(node)}`;
    lines.push(truncate(head, maxWidth));

    if (options.collapsed?.has(node.id)) {
      const hidden = childrenOf(tree, node.id).length;
      if (hidden > 0) {
        lines.push(truncate(`${' '.repeat(branchWidth)}   … ${hidden} 个子节点（已折叠）`, maxWidth));
      }
    }
  }

  if (lines.length === 0) return '（轨迹为空）';
  if (tree.tipId !== null) {
    lines.push(`HEAD → ${tree.tipId}`);
  }
  return lines.join('\n');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

// ─── 序列化 / 回放 ───

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
