/**
 * 轨迹持久化 —— 追加写 JSONL，像 git 自己的 reflog 那样只追加、不改写。
 *
 * 为什么不覆盖写整棵树：
 *   - 崩溃/断电只丢最后没 flush 的一行，之前的历史完好；
 *   - 一行一个节点，回放就是逐行重放，天然幂等且能中途接着写；
 *   - 多个进程/多个标签页各写各的也不会互相踩坏已有内容。
 *
 * 同一个文件里混着五类记录，每行带一个 op：
 *   - `prompt.init` / `model.init` 系统装载，各一条，落在所有节点之前
 *   - `message`    一条对话消息（user / assistant / toolResult / 中途插的 system 段）
 *   - `add`        轨迹节点首次出现（带完整字段）
 *   - `close`      轨迹节点闭合（只带 id / status / endedAt，回放时打补丁）
 *
 * 前三种是为了**回放**：读一遍 JSONL 就能把「当时发给模型的是什么」和「模型答了什么」
 * 全部重建出来，一次 token 都不用花。
 *
 * Node 端落文件，浏览器端落 localStorage，接口一致（都是 append 一个字符串）。
 */
import { applyTraceRecord, createTraceTree, type SerializedTraceNode, type TraceTree } from './trace';

/**
 * 装载记录（`prompt.init` / `model.init`）。两种，各一条。
 *
 * 它们**混在轨迹文件的前几行**，不另开文件。
 * 拆出去过的理由（"回放要先跳过无关的装载记录"）不成立 —— 回放只认自己那几种 op，
 * 其余一律忽略；而且每个会话多一个文件，目录里全是 jsonl 很难翻。
 * 老会话的 `.init.jsonl` 已由一次性迁移脚本合并，不再有回退读的代码路径。
 */

export type InitRecord =
  | {
      op: 'prompt.init';
      systemPrompt: string;
      tools: { name: string; description: string; parameters: unknown }[];
    }
  | {
      op: 'model.init';
      provider: string;
      modelId: string;
      thinkingLevel: string;
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
 * 一行轨迹 / 对话记录。`message` 让回放能重建 messages（零 token 复现一轮对话）。
 *
 * `prompt.init` / `model.init` 也在这里面（不另开 `<id>.init.jsonl`）：
 * 回放只认自己那几种 op、其余忽略，所以装载记录混在前面**不影响**回放，
 * 而少一半文件对「目录里全是 jsonl」的观感差别很大。
 */
export type TraceRecord = InitRecord | { op: 'message'; message: unknown } | { op: 'add'; node: SerializedTraceNode } | { op: 'close'; id: string; status: string; endedAt: number | null };

/** 追加写一个字符串。Node 与浏览器各自实现。 */
export interface TraceSink {
  append(line: string): void | Promise<void>;
  /** 关闭（Node 端 flush 缓冲）。 */
  close?(): void | Promise<void>;
}

// ─── 收集器：从状态树算出「还没落盘的那几行」 ───

/**
 * 算出要追加写的记录。
 * 两个游标各管一段：
 *   - `persistedSeq`：已用 add 落盘到的最大 seq。比它大的节点要补 add。
 *   - `needClose`：已经 add 过、后来状态变了（pending → ok/error/aborted）的节点，
 *     要补一条 close 补丁。由驱动器（`createTracePersistence`）维护这个集合。
 *
 * 这样即使一个节点先 add 后 close，也只会在第一次落盘时出现完整字段，之后只写补丁。
 */
export function pendingRecords(
  tree: TraceTree,
  persistedSeq: number,
  needClose: ReadonlySet<string>,
): TraceRecord[] {
  const records: TraceRecord[] = [];
  for (const id of tree.order) {
    const node = tree.nodes[id];
    if (!node) continue;
    if (needClose.has(id)) {
      records.push({ op: 'close', id, status: node.status, endedAt: node.endedAt });
      continue;
    }
    const seq = Number.parseInt(id.replace(/^n/, ''), 10);
    if (Number.isNaN(seq) || seq <= persistedSeq) continue;
    records.push({ op: 'add', node: toRecord(node) });
  }
  return records;
}

function toRecord(node: SerializedTraceNode): SerializedTraceNode {
  return { ...node };
}

// ─── 回放 ───

/** 回放一份轨迹/对话 JSONL。 */
export interface ReplayedSession {
  tree: TraceTree;
  /** 按原顺序重建的对话消息。 */
  messages: unknown[];
  /** 装载段（prompt / model）。回放不必重装配工具、不必再问 provider 能力。 */
  init: ReplayedInit;
}

/**
 * 从 JSONL 文本重建轨迹树**和**对话消息。坏行跳过（最后一行可能是崩溃时截断的）。
 *
 * messages 一并重建是「零 token 复现一轮对话」的关键：回放出来的会话里，模型答过什么、
 * 工具返回了什么，全都在，不必再调一次模型。
 */
export function replaySession(text: string, sessionId: string): ReplayedSession {
  let tree = createTraceTree(sessionId);
  const messages: unknown[] = [];
  const init: ReplayedInit = { prompt: null, model: null };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: TraceRecord;
    try {
      record = JSON.parse(trimmed) as TraceRecord;
    } catch {
      continue; // 崩溃截断的半行，丢掉即可
    }
    if (record.op === 'add') {
      tree = applyTraceRecord(tree, record.node);
    } else if (record.op === 'close') {
      const node = tree.nodes[record.id];
      if (node) {
        tree = applyTraceRecord(tree, {
          ...node,
          status: record.status as SerializedTraceNode['status'],
          endedAt: record.endedAt,
        });
      }
    } else if (record.op === 'message') {
      messages.push(record.message);
    } else if (record.op === 'prompt.init') {
      init.prompt = record;
    } else if (record.op === 'model.init') {
      init.model = record;
    }
  }
  return { tree, messages, init };
}

/** 只重建轨迹树（老调用方用它；不认识 message 行）。 */
export function replayTrace(text: string, sessionId: string): TraceTree {
  return replaySession(text, sessionId).tree;
}

/** 把记录数组渲染成 JSONL 文本。 */
export function toJsonl(records: readonly TraceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

// ─── 驱动器：盯住 store，把新节点刷进 sink ───

/**
 * 轨迹持久化驱动器。挂到 store 上，每次状态变化就把「还没落盘的节点」追加写出去。
 *
 * 为什么不把落盘做成 effect 表里的 Cmd：
 *   - 它跟 LLM/工具那些 effect 不是一回事，几乎每次 dispatch 都要跑（token 增量也会触发），
 *     走 Cmd 会把环搅乱；
 *   - 而「错误也要持久化」这个需求恰恰要求它**不能**因为出错路径而不执行。
 *     一个订阅器对成功/失败一视同仁，这正是我们要的语义。
 *
 * 写失败（磁盘满、权限）不会打断环：只报一次警告，游标不动，下次状态变化再试。
 */
export interface TracePersistence {
  /**
   * 恢复历史之后告诉落盘器「前 N 条消息已经在文件里了，别再写一遍」。
   *
   * 为什么需要它：`restoreSession` 会 `conversation.reset`（清空 messages）再逐条 `session.restored`
   * 把 N 条历史灌回来。那些内容**本来就在文件里**，不是新产生的 —— 但落盘器只看 messages 有没有变长，
   * 于是从游标 0 开始把整批重写一遍，轨迹文件里就出现了「同一批消息出现两次」。
   *
   * 与 `dispose` 一样是给内核用的出口：store 只有一个，落盘器也只有这一个，所以由它来归位游标。
   */
  skipMessages(count: number): void;
  dispose(): void;
}

export function createTracePersistence(options: {
  store: {
    getState(): {
      trace: TraceTree;
      persistedSeq: number;
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
  // 已经 add 过、但状态后来变了的节点：这些要写 close 补丁。
  const needClose = new Set<string>();
  // 上一轮每个节点的状态，用来发现「pending → 闭合」这种变化。
  let lastStatus = new Map<string, string>();
  // 已经落过盘的消息条数（新消息 = messages.length 变大了）。
  let persistedMessages = 0;

  const flush = (): void => {
    const { trace, persistedSeq, messages } = store.getState();

    // 先找出状态变了的节点（上一轮 pending，这轮已闭合）。
    for (const id of trace.order) {
      const node = trace.nodes[id];
      if (!node) continue;
      if (lastStatus.get(id) === 'pending' && node.status !== 'pending') {
        needClose.add(id);
      }
    }

    const records: TraceRecord[] = pendingRecords(trace, persistedSeq, needClose);
    for (const record of records) {
      if (record.op === 'close') needClose.delete(record.id);
    }

    // 新消息：每条追加一行。回放时按顺序重放就能重建 messages。
    for (let i = persistedMessages; i < messages.length; i += 1) {
      const message = messages[i];
      // push 而不是 unshift：unshift 会把同一批新消息**倒过来**（[a,b,c] 变成 [c,b,a]），
      // 回放出来的对话顺序就反了。push 保持它们在 messages 里的先后。
      if (message !== undefined) records.push({ op: 'message', message });
    }

    lastStatus = snapshot(trace);
    if (records.length === 0) return;

    try {
      void sink.append(toJsonl(records));
    } catch (error) {
      onError?.(error);
      return; // 游标不动，下次还会再试
    }
    // 落盘成功才推进游标。
    if (messages.length > persistedMessages) persistedMessages = messages.length;
    const maxSeq = maxSeqOf(records);
    if (maxSeq > persistedSeq) {
      store.dispatch({ type: 'trace.persisted', upToSeq: maxSeq });
    }
  };

  const unsubscribe = store.subscribe(flush);
  lastStatus = snapshot(store.getState().trace);
  flush();
  return {
    /**
     * 恢复历史后由内核调用：那 N 条消息已经在文件里，游标直接推过去。
     *
     * 必须**在灌消息之前**调 —— flush 是 store 订阅器，`session.restored` 每条都会触发它，
     * 等灌完再调就晚了（第一批已经写掉了）。见 kernel.ts 的 restoreSession。
     */
    skipMessages: (count: number): void => {
      if (count > persistedMessages) persistedMessages = count;
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

/** 这批记录里最大的节点 seq；close 补丁没有 seq，返回 0 表示不推进游标。 */
function maxSeqOf(records: readonly TraceRecord[]): number {
  let max = 0;
  for (const record of records) {
    if (record.op !== 'add') continue;
    const seq = Number.parseInt(record.node.id.replace(/^n/, ''), 10);
    if (!Number.isNaN(seq)) max = Math.max(max, seq);
  }
  return max;
}
