/**
 * 会话接口的浏览器侧封装（`/api/sessions` 那两条）。
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
