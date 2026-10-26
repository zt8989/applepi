/**
 * 轨迹持久化 —— 追加写 JSONL，只追加、不改写。
 *
 * 不覆盖写整棵树：崩溃/断电只丢最后没 flush 的一行，一行一个节点，回放就是逐行重放；
 * 多个进程各写各的也不会踩坏已有内容。
 *
 * ## v2 文件形状（首行版本头，之后每行的 `seq` 严格等于行号）
 *
 *     {"seq":1,"op":"header","v":2}
 *     {"seq":2,"op":"prompt.init",…}
 *     {"seq":3,"op":"add","node":{…}}
 *     {"seq":4,"op":"close","id":"<hash>",…}
 *     {"seq":5,"op":"message",…}
 *
 * `seq` 就是**分页游标**：取「第 1000～2000 行」不用解析任何一行，`seq` 一对就知道边界
 * 在哪。节点的 id 是内容 hash（见 trace.ts），与 `seq` 无关 —— seq 只标记「落在文件哪一行」。
 *
 * 同一个文件里混着几种记录：
 *   - `header`      文件版本（永远是第 1 行，`seq:1`）
 *   - `prompt.init` / `model.init` 系统装载，各一条，落在所有节点之前
 *   - `message`    一条对话消息（user / assistant / toolResult / 中途插的 system 段）
 *   - `add`        轨迹节点首次出现（带完整字段）
 *   - `close`      轨迹节点闭合（只带 id / status / endedAt，回放时打补丁）
 *
 * Node 端落文件，浏览器端落 localStorage，接口一致（都是 append 一个字符串）。
 */
import {
  applyTraceRecord,
  computeNodeId,
  createTraceTree,
  type SerializedTraceNode,
  type TraceTree,
} from './trace';
import type { SkillInfo } from './skills';

/** 轨迹文件的当前版本。旧文件（无版本头）算 v1，启动时统一迁移（见 config-home）。 */
export const TRACE_FILE_VERSION = 2;

/**
 * 装载记录（`prompt.init` / `model.init`），两种、各一条，混在轨迹文件的前几行。
 *
 * 不另开文件：回放只认自己那几种 op，装载记录混在前面不影响回放，而少一半文件少一半噪声。
 */

export type InitRecord =
  | {
      op: 'prompt.init';
      systemPrompt: string;
      /**
       * system prompt 的**分段**（`system-prompt.ts` 的 `buildPromptParts`）。
       *
       * 与 `systemPrompt`（它的渲染结果）一起落：中途的 prompt 变更只 patch 变了的
       * 段，回放时靠它还原「当时有哪几段」；没有它就只能当一整段（旧会话）。
       */
      sections?: Record<string, string>;
      tools: { name: string; description: string; parameters: unknown }[];
      /**
       * 装进来的 skill 清单（可选 —— 旧会话没这个字段）。
       *
       * 它们已经拼进 `systemPrompt` 了（reducer 的 prompt.init 干的），所以回放时
       * **不重扫 skill 目录** —— 当时的目录内容可能已经变了，重扫得到的是另一个 prompt。
       */
      skills?: SkillInfo[];
    }
  | {
      op: 'model.init';
      provider: string;
      modelId: string;
      thinkingLevel: string;
      /** 模型支不支持 reasoning（旧记录/测试里可能没有）。 */
      reasoning?: boolean;
      capabilities: {
        midConvoSystemMessages: boolean;
        midConvoToolAdditions: boolean;
        developerRole: boolean;
      };
    };

/** 回放一份装载段得到的两个块。哪条没读到就是 undefined。 */
export interface ReplayedInit {
  prompt: Extract<InitRecord, { op: 'prompt.init' }> | null;
  model: Extract<InitRecord, { op: 'model.init' }> | null;
}

/**
 * 一行记录的**载荷**（不带 seq）。落盘器算出来，写盘前统一盖上 `seq`（= 行号）。
 */
export type TracePayload =
  | { op: 'header'; v: number }
  | InitRecord
  | { op: 'message'; message: unknown }
  | { op: 'add'; node: SerializedTraceNode }
  | { op: 'close'; id: string; status: string; endedAt: number | null };

/** 磁盘上的一行：载荷 + `seq`（严格等于行号）。 */
export type TraceRecord = TracePayload & { seq: number };

/**
 * 回放时读到的一行。v1 文件没有 seq，版本头没有 op —— 都允许，
 * 靠 `op` / `v` 有没有值区分。
 */
type ReplayLine = Partial<TracePayload> & { seq?: number; v?: number };

/** 追加写一个字符串。Node 与浏览器各自实现。 */
export interface TraceSink {
  append(line: string): void | Promise<void>;
  /** 关闭（Node 端 flush 缓冲）。 */
  close?(): void | Promise<void>;
}

/**
 * 算出要追加写的记录。
 *
 * 游标是「本会话文件已写过多少个节点」（`order` 的前缀长度）—— 节点只会在尾部追加，
 * 前缀计数就是天然的去重线。另有 `needClose`：已 add 过、后来状态变了（pending →
 * ok/error/aborted）的节点，要补一条 close 补丁，由驱动器维护这个集合。
 */
export function pendingRecords(
  tree: TraceTree,
  persistedCount: number,
  needClose: ReadonlySet<string>,
): TracePayload[] {
  const records: TracePayload[] = [];
  for (let index = 0; index < tree.order.length; index += 1) {
    const id = tree.order[index];
    if (id === undefined) continue;
    const node = tree.nodes[id];
    if (!node) continue;
    const isNew = index >= persistedCount;
    if (needClose.has(id)) {
      // 建出来与闭合发生在两次 flush 之间（理论上不会：subscribe 是同步的）的保险：
      // 没落过盘的节点直接写完整的一条 add，不留「close 指向不存在的 add」的悬空行。
      if (isNew) {
        records.push({ op: 'add', node: toRecord(node) });
      } else {
        records.push({ op: 'close', id, status: node.status, endedAt: node.endedAt });
      }
      continue;
    }
    if (!isNew) continue;
    records.push({ op: 'add', node: toRecord(node) });
  }
  return records;
}

function toRecord(node: SerializedTraceNode): SerializedTraceNode {
  return { ...node };
}

/** 回放一份轨迹/对话 JSONL。 */
export interface ReplayedSession {
  tree: TraceTree;
  /** 按原顺序重建的对话消息。 */
  messages: unknown[];
  /** 装载段（prompt / model）。回放不必重装配工具、不必再问 provider 能力。 */
  init: ReplayedInit;
  /** 文件版本；没有版本头（v1）为 null。 */
  version: number | null;
}

/**
 * 从 JSONL 文本重建轨迹树**和**对话消息。坏行跳过（最后一行可能是崩溃时截断的）。
 *
 * 一并重建 messages 是「零 token 重放一轮对话」的关键：模型答过什么、工具返回了什么全在，
 * 不必再调一次模型。v1 文件（无版本头、id 是 `n7`）照常回放 —— id 只是透明字符串。
 */
export function replaySession(text: string, sessionId: string): ReplayedSession {
  let tree = createTraceTree(sessionId);
  const messages: unknown[] = [];
  const init: ReplayedInit = { prompt: null, model: null };
  let version: number | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: ReplayLine;
    try {
      record = JSON.parse(trimmed) as ReplayLine;
    } catch {
      continue; // 崩溃截断的半行，丢掉即可
    }
    // 版本头：只读版本号，不进树。兼容两种形状：带 op 的（我们写盘的形状）与裸 v 的。
    if (
      (record.op === 'header' || record.op === undefined) &&
      typeof record.v === 'number'
    ) {
      version = record.v;
      continue;
    }
    if (record.op === 'add') {
      tree = applyTraceRecord(tree, (record as { node: SerializedTraceNode }).node);
    } else if (record.op === 'close') {
      const { id, status, endedAt } = record as { id: string; status: string; endedAt: number | null };
      const node = tree.nodes[id];
      if (node) {
        tree = applyTraceRecord(tree, {
          ...node,
          status: status as SerializedTraceNode['status'],
          endedAt,
        });
      }
    } else if (record.op === 'message') {
      messages.push((record as { message: unknown }).message);
    } else if (record.op === 'prompt.init') {
      init.prompt = record as Extract<InitRecord, { op: 'prompt.init' }>;
    } else if (record.op === 'model.init') {
      init.model = record as Extract<InitRecord, { op: 'model.init' }>;
    }
  }
  return { tree, messages, init, version };
}

/** 只重建轨迹树（老调用方用它；不认识 message 行）。 */
export function replayTrace(text: string, sessionId: string): TraceTree {
  return replaySession(text, sessionId).tree;
}

/** 把记录数组渲染成 JSONL 文本（每条一行；seq 由调用方先盖好）。 */
export function toJsonl(records: readonly TraceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/**
 * 轨迹持久化驱动器：挂到 store 上，每次状态变化就把「还没落盘的节点」追加写出去。
 *
 * 不做成 effect 表里的 Cmd：它几乎每次 dispatch 都要跑（token 增量也触发），走 Cmd 会把环
 * 搅乱；而「错误也要持久化」恰恰要求它**不能**因为出错路径而不执行 —— 订阅器对成功/失败
 * 一视同仁。
 *
 * 写失败（磁盘满、权限）不打断环：报一次错，游标不动，下次状态变化再试。
 *
 * ## 游标全在这里，不在 state
 *
 * `seq` = 行号，行号属于**文件**；换会话就是换文件，游标跟着换。所以游标不再放
 * state（那是上一个实现的老坑：跨会话带着走，要么把新会话的节点全跳过、要么把
 * 恢复出来的树重写一遍）。换会话时内核调 `beginSession()` 把四个游标一次拨到位。
 */
export interface TracePersistence {
  /**
   * 恢复历史之后告诉落盘器「前 N 条消息已经在文件里了，别再写一遍」。
   *
   * `restoreSession` 会 `conversation.reset` 再逐条 `session.restored` 灌回 N 条历史，
   * 那些内容本来就在文件里 —— 落盘器只看 messages 有没有变长的话会整批重写一遍，
   * 轨迹文件里就出现「同一批消息两次」。
   */
  skipMessages(count: number): void;
  /**
   * 换会话（换文件）时由内核调用，把游标拨到新文件的起点：
   *   - `nextLine`：下一行的行号（新文件 = 1；续写 = 文件行数 + 1）；
   *   - `headerPending`：新文件要先写版本头（续写的 v1 文件**不补**头，行号照样对齐）；
   *   - `existingNodes`：文件里已经有的节点数（恢复会话 = 读回来的那棵树的大小），
   *     这些节点不再补 add。
   */
  beginSession(options: { nextLine: number; headerPending: boolean; existingNodes: number }): void;
  dispose(): void;
}

export function createTracePersistence(options: {
  store: {
    getState(): {
      trace: TraceTree;
      /** messages 也要读：回放时要靠它零 token 复现一轮对话。 */
      messages: readonly unknown[];
    };
    subscribe(listener: () => void): () => void;
    dispatch(action: unknown): unknown;
  };
  sink: TraceSink;
  onError?: ((error: unknown) => void) | undefined;
}): TracePersistence {
  const { store, sink, onError } = options;
  // 下一行的行号（= 下一条记录的 seq）。
  let nextLine = 1;
  // 新文件要先写版本头（第 1 行）。续写已有文件时由 beginSession 关掉。
  let headerPending = true;
  // 本文件已写过 add 的节点数（order 前缀长度）。
  let persistedNodes = 0;
  // 已经 add 过、但状态后来变了的节点：这些要写 close 补丁。
  let needClose = new Set<string>();
  // 上一轮每个节点的状态，用来发现「pending → 闭合」这种变化。
  let lastStatus = new Map<string, string>();
  // 已经落过盘的消息条数（新消息 = messages.length 变大了）。
  let persistedMessages = 0;

  const flush = (): void => {
    const { trace, messages } = store.getState();

    // 先找出状态变了的节点（上一轮 pending，这轮已闭合）。
    for (const id of trace.order) {
      const node = trace.nodes[id];
      if (!node) continue;
      if (lastStatus.get(id) === 'pending' && node.status !== 'pending') {
        needClose.add(id);
      }
    }

    const payloads = pendingRecords(trace, persistedNodes, needClose);
    for (const payload of payloads) {
      if (payload.op === 'close') needClose.delete(payload.id);
    }

    // 新消息：每条追加一行。回放时按顺序重放就能重建 messages。
    for (let i = persistedMessages; i < messages.length; i += 1) {
      const message = messages[i];
      // push 而不是 unshift：unshift 会把同一批新消息**倒过来**（[a,b,c] 变成 [c,b,a]），
      // 回放出来的对话顺序就反了。push 保持它们在 messages 里的先后。
      if (message !== undefined) payloads.push({ op: 'message', message });
    }

    if (payloads.length === 0) return;
    // 版本头永远赶在第一批载荷前面 —— 有载荷才有文件，空文件不需要头。
    const withHeader: TracePayload[] = headerPending
      ? [{ op: 'header', v: TRACE_FILE_VERSION }, ...payloads]
      : payloads;
    // 盖 seq：写盘前逐条编号，一条一行，seq 严格等于行号。
    const records: TraceRecord[] = withHeader.map((payload) => {
      const record: TraceRecord = { ...payload, seq: nextLine };
      nextLine += 1;
      return record;
    });

    lastStatus = snapshot(trace);
    headerPending = false;

    try {
      void sink.append(toJsonl(records));
    } catch (error) {
      onError?.(error);
      return; // 游标不动，下次还会再试
    }
    // 落盘成功才推进游标。
    for (const record of records) {
      if (record.op === 'add') persistedNodes += 1;
    }
    if (messages.length > persistedMessages) persistedMessages = messages.length;
  };

  const unsubscribe = store.subscribe(flush);
  lastStatus = snapshot(store.getState().trace);
  flush();
  return {
    skipMessages: (count: number): void => {
      if (count > persistedMessages) persistedMessages = count;
    },
    beginSession: ({
      nextLine: line,
      headerPending: pending,
      existingNodes,
    }): void => {
      nextLine = line;
      headerPending = pending;
      persistedNodes = existingNodes;
      persistedMessages = 0;
      needClose = new Set();
      lastStatus = new Map();
    },
    dispose: unsubscribe,
  };
}

function snapshot(trace: TraceTree): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of trace.order) {
    const node = trace.nodes[id];
    if (node) map.set(id, node.status);
  }
  return map;
}

/**
 * 把一份**旧格式（v1）**的轨迹 JSONL 文本升级成 v2：
 *   - 首行补版本头 `{"seq":1,"op":"header","v":2}`；
 *   - 每行补 `seq` = 新文件里的行号；
 *   - 节点 id 重算成内容 hash（SHA-1，与在线 `computeNodeId` 同一条规范），
 *     `add` 的 `node.id` / `node.parentId` 与 `close` 的 `id` 一起换；
 *   - v1 可能有多棵根（上下文族与对话族两条线）—— 除第一棵外，原来的根全部重挂到
 *     根节点（system prompt）下面，得到 v2 的单一根树。
 *
 * 已是 v2（首条可解析行带 `v: 2`）原样返回。坏行（崩溃截断）丢弃，与回放同一口径。
 * 纯函数：不动任何文件，文件层的扫描与原子替换在 config-home 的 `migrateTracesV2()`。
 */
export function upgradeTraceToV2(text: string): { text: string; upgraded: boolean } {
  const payloads: TracePayload[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: ReplayLine;
    try {
      record = JSON.parse(trimmed) as ReplayLine;
    } catch {
      continue;
    }
    if (
      (record.op === 'header' || record.op === undefined) &&
      typeof record.v === 'number'
    ) {
      if (record.v === TRACE_FILE_VERSION) return { text, upgraded: false };
      continue;
    }
    if (record.op !== undefined) payloads.push(record as TracePayload);
  }

  // 第一遍：按 add 的出现顺序重算 id，建成「旧 id → 新节点」表。
  // 原来的根（parentId === null）里，第一棵保持为根（它是 system prompt），其余挂到根上。
  const idMap = new Map<string, string>();
  const newNodes = new Map<string, SerializedTraceNode>();
  let rootId: string | null = null;
  let ordinal = 0;
  for (const payload of payloads) {
    if (payload.op !== 'add') continue;
    ordinal += 1;
    const node = payload.node;
    let parentId: string | null;
    if (node.parentId === null) {
      // 第一棵根就是 system 根；其余的根（旧对话族的 user 等）挂到它下面。
      parentId = rootId;
    } else {
      parentId = idMap.get(node.parentId) ?? null;
    }
    // system 根要能被认出来：meta.role = 'system'（与在线路径的 prompt.base 一致）。
    const meta =
      node.kind === 'prompt.base' ? { ...(node.meta ?? {}), role: 'system' } : node.meta;
    const id = computeNodeId(parentId, ordinal, {
      ...node,
      ...(meta !== undefined ? { meta } : {}),
    });
    idMap.set(node.id, id);
    if (node.parentId === null && rootId === null) rootId = id;
    const newNode: SerializedTraceNode = {
      ...node,
      id,
      parentId,
      ...(meta !== undefined ? { meta } : {}),
    };
    newNodes.set(node.id, newNode);
  }

  // 第二遍：按原顺序重排行，盖上新行号。
  const out: string[] = [JSON.stringify({ seq: 1, op: 'header', v: TRACE_FILE_VERSION })];
  let lineNo = 1;
  for (const payload of payloads) {
    lineNo += 1;
    if (payload.op === 'add') {
      const node = newNodes.get(payload.node.id);
      if (!node) continue;
      out.push(JSON.stringify({ ...payload, node, seq: lineNo }));
      continue;
    }
    if (payload.op === 'close') {
      out.push(JSON.stringify({ ...payload, id: idMap.get(payload.id) ?? payload.id, seq: lineNo }));
      continue;
    }
    out.push(JSON.stringify({ ...payload, seq: lineNo }));
  }
  return { text: `${out.join('\n')}\n`, upgraded: true };
}
