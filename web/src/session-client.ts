/**
 * 会话接口的浏览器侧封装（`/api/sessions` 那几条）。
 *
 * 单独一个文件是为了让 `commands.ts` 不直接依赖 fetch 细节，测试与将来换传输都方便。
 */

export interface SessionSummary {
  id: string;
  cwd: string;
  mtimeMs: number;
  createdAt: string | null;
  entries: number;
  title: string;
  /** 这条会话的 cwd 是不是当前内核的 cwd。 */
  current: boolean;
}

/** 某一段历史会话的轨迹（`/api/sessions/:id/trace`）。只读，零 token。 */
export interface SessionTrace {
  id: string;
  /** 与 src/trace.ts 的 TraceTree 同构（内核原样给过来）。 */
  tree: import('../../src/trace').TraceTree;
  /** 那次对话的消息条数（详情页只报数，不展全文）。 */
  messages: number;
  stats: import('../../src/trace').TraceStats;
}

/**
 * 读一段历史会话的轨迹。
 *
 * 与 `restoreSession` 分开是故意的：**看不该动当前对话**。之前只有「恢复」一条路，
 * 于是想看某一次的执行过程就得先把正在进行的会话换掉。
 */
export async function loadSessionTrace(id: string): Promise<SessionTrace> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/trace`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `取轨迹失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as SessionTrace;
}

/** 清理的结果。`failed` 里是删不掉的（文件被别的进程占着），不当成整体失败。 */
export interface CleanResult {
  removed: number;
  sessions: number;
  failed: { id: string; reason: string }[];
  /** `all: true` 时回当前会话 id（清理不动它）。 */
  current?: string;
}

export async function listSessions(): Promise<{ sessions: SessionSummary[]; current: string }> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`取会话列表失败（HTTP ${res.status}）`);
  return (await res.json()) as { sessions: SessionSummary[]; current: string };
}

export async function restoreSession(id: string): Promise<{ id: string; restored: number }> {
  const res = await fetch('/api/sessions/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(`恢复失败（HTTP ${res.status}）`);
  return (await res.json()) as { id: string; restored: number };
}

/** 删掉指定的几条会话（连同它们的轨迹文件）。 */
export async function cleanSessions(ids: readonly string[]): Promise<CleanResult> {
  const res = await fetch('/api/sessions/clean', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`清理失败（HTTP ${res.status}）`);
  return (await res.json()) as CleanResult;
}

/**
 * 清掉除当前会话外的**全部**历史会话。
 *
 * 为什么需要「全清」而不是只给几条：测试与随手试跑会在配置家目录里堆出几百条
 * cwd 指向临时目录的会话（每跑一次测试就是一条），它们在列表里长得跟真会话一模一样，
 * 用户没法靠肉眼分辨、更不可能挨个点删。
 */
export async function cleanAllSessions(): Promise<CleanResult> {
  const res = await fetch('/api/sessions/clean', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  if (!res.ok) throw new Error(`清理失败（HTTP ${res.status}）`);
  return (await res.json()) as CleanResult;
}
