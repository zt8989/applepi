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
import {
  replaySession,
  replayTrace,
  type ReplayedSession,
  type TraceSink,
} from './trace-store';
import type { TraceTree } from './trace';
import { tracesDir } from './config-home';

/**
 * 轨迹目录。**默认落在配置家目录里**（`~/.redux-agent/traces/`），不再是项目下的
 * `.trace/` —— 轨迹是会话级产物，和会话文件放一起才对；放项目里会在每个仓库留一堆
 * 垃圾，而且换个目录就「找不到历史」。
 *
 * 传字符串则用该目录（相对路径相对进程 cwd），测试用。
 */
export type TraceDir = string | null;

/** 解析成绝对目录。 */
function resolveDir(dir?: TraceDir): string {
  if (dir) return path.resolve(dir);
  return tracesDir();
}

/** 某个会话的轨迹 JSONL 路径。 */
export function tracePath(sessionId: string, dir?: TraceDir): string {
  return path.join(resolveDir(dir), `${sessionId}.jsonl`);
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

/**
 * 读回一个会话：轨迹树 + 对话消息（零 token 复现一轮对话）。
 * 文件不存在就返回 null。
 */
export async function loadSession(
  sessionId: string,
  dir?: TraceDir,
): Promise<ReplayedSession | null> {
  const file = tracePath(sessionId, dir);
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  return replaySession(text, sessionId);
}

/** 读回一个会话的轨迹树（只要树，不要消息；老调用方用它）。 */
export async function loadTrace(
  sessionId: string,
  dir?: TraceDir,
): Promise<TraceTree | null> {
  const file = tracePath(sessionId, dir);
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  return replayTrace(text, sessionId);
}

/**
 * 列出所有已落盘的**轨迹**会话 id。
 *
 * 注意这不是「会话列表」—— 后者在 config-home 的 `listSessions()`，那是给人看的历史。
 */
export async function listSessions(dir?: TraceDir): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const target = resolveDir(dir);
  if (!existsSync(target)) return [];
  const entries = await readdir(target);
  return entries
    .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.init.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort();
}
