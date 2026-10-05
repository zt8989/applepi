/**
 * Node 端的轨迹落盘：追加写 `.trace/<sessionId>.jsonl`。
 *
 * 选 JSONL 而不是整树覆盖写，是因为它像 git 的 reflog：
 *   - 崩溃只丢最后没 flush 的一行，历史完好；
 *   - 追加写不会重写整个文件，长会话也不会越来越慢；
 *   - 一行一个节点，`wc -l` 就知道这次会话发生过多少次尝试。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TraceSink } from './trace-store';
import { replayTrace } from './trace-store';
import type { TraceTree } from './trace';

export const TRACE_DIR = '.trace';

/** 轨迹目录：相对路径（相对进程 cwd）或绝对路径。 */
export type TraceDir = string;

/** 某个会话的 JSONL 路径。 */
export function tracePath(sessionId: string, dir: string = TRACE_DIR): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

/**
 * 追加写文件的 sink。
 *
 * 写是异步的（不阻塞环），但**顺序必须保证**，所以内部串成一条 Promise 链：
 * 否则两次快速的状态变化可能乱序落盘，回放出来的树就错了。
 */
export function createFileSink(filePath: string): TraceSink {
  let queue: Promise<void> = Promise.resolve();
  let lastError: unknown = null;

  return {
    append(line: string): Promise<void> {
      queue = queue
        .then(async () => {
          const dir = path.dirname(filePath);
          if (!existsSync(dir)) await mkdir(dir, { recursive: true });
          // 补一个换行：每条记录独立成行。
          await appendFile(filePath, `${line}\n`, 'utf8');
        })
        .catch((error: unknown) => {
          // 不让写失败打断调用方（环还在跑）；记下来给上层看。
          lastError = error;
        });
      return queue;
    },
    async close(): Promise<void> {
      await queue;
      if (lastError) throw lastError;
    },
  };
}

/** 读回一个会话的轨迹（`/tree` 的回放用；文件不存在就返回 null）。 */
export async function loadTrace(
  sessionId: string,
  dir: string = TRACE_DIR,
): Promise<TraceTree | null> {
  const file = tracePath(sessionId, dir);
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  return replayTrace(text, sessionId);
}

/** 列出所有已落盘的会话 id（新的在后）。 */
export async function listSessions(dir: string = TRACE_DIR): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort();
}
