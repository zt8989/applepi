/**
 * 轨迹持久化 —— 追加写 JSONL，像 git 自己的 reflog 那样只追加、不改写。
 *
 * 为什么不覆盖写整棵树：
 *   - 崩溃/断电只丢最后没 flush 的一行，之前的历史完好；
 *   - 一行一个节点，回放就是逐行重放，天然幂等且能中途接着写；
 *   - 多个进程/多个标签页各写各的也不会互相踩坏已有内容。
 *
 * 同一个文件里既有「新增节点」也有「节点状态变更」，所以每行带一个 op：
 *   - `add`   节点首次出现（带完整字段）
 *   - `close` 节点闭合（只带 id / status / endedAt，回放时打补丁）
 *
 * Node 端落文件，浏览器端落 localStorage，接口一致（都是 append 一个字符串）。
 */
import { applyTraceRecord, createTraceTree, type SerializedTraceNode, type TraceTree } from './trace';

/** 一行落盘记录。 */
export type TraceRecord =
  | { op: 'add'; node: SerializedTraceNode }
  | { op: 'close'; id: string; status: string; endedAt: number | null };

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

/** 从 JSONL 文本重建轨迹树。坏行跳过（最后一行可能是崩溃时截断的）。 */
export function replayTrace(text: string, sessionId: string): TraceTree {
  let tree = createTraceTree(sessionId);
  const closed = new Set<string>();
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
      closed.add(record.id);
      const node = tree.nodes[record.id];
      if (node) {
        tree = applyTraceRecord(tree, {
          ...node,
          status: record.status as SerializedTraceNode['status'],
          endedAt: record.endedAt,
        });
      }
    }
  }
  return tree;
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
  dispose(): void;
}

export function createTracePersistence(options: {
  store: {
    getState(): { trace: TraceTree; persistedSeq: number };
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

  const flush = (): void => {
    const { trace, persistedSeq } = store.getState();

    // 先找出状态变了的节点（上一轮 pending，这轮已闭合）。
    for (const id of trace.order) {
      const node = trace.nodes[id];
      if (!node) continue;
      if (lastStatus.get(id) === 'pending' && node.status !== 'pending') {
        needClose.add(id);
      }
    }

    const records = pendingRecords(trace, persistedSeq, needClose);
    for (const record of records) {
      if (record.op === 'close') needClose.delete(record.id);
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
    const maxSeq = maxSeqOf(records);
    if (maxSeq > persistedSeq) {
      store.dispatch({ type: 'trace.persisted', upToSeq: maxSeq });
    }
  };

  const unsubscribe = store.subscribe(flush);
  lastStatus = snapshot(store.getState().trace);
  flush();
  return { dispose: unsubscribe };
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
