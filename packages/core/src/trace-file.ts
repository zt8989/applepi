/**
 * Node 端的轨迹落盘：追加写 `traces/--<cwd 编码>--/<时间戳>_<id>.jsonl`。
 *
 * 用 JSONL 追加而不是整树覆盖写：崩溃只丢最后没 flush 的一行；长会话不会越写越慢；
 * `wc -l` 就知道这次会话发生过多少次尝试。
 *
 * **目录布局与 sessions/ 一致**（`--<cwd 编码>--/` 子目录，见 config-home 的
 * `traceDirFor`）：会话与它的轨迹同生同死，按工作目录归类后两边的目录名、文件名
 * 一一对应 —— 删一条会话时轨迹就在同名的旁边；跨项目 `/resume` 时轨迹也跟着
 * cwd 走，不会把两个项目的树混在一个平目录里。
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import {
  replaySession,
  replayTrace,
  type ReplayedSession,
  type TraceSink,
} from './trace-store';
import type { TraceTree } from './trace';
import {
  traceDirFor,
  findFileById,
  traceFileName,
  sessionIdFromFileName,
} from './config-home';

/**
 * 轨迹目录；不给就落在配置家目录（`~/.pi/agent/traces/`）。传字符串则用该目录
 * （相对路径相对进程 cwd），测试用 —— 旧形状是平目录，读回时仍然认。
 */
export type TraceDir = string | null;

/**
 * 某个会话的轨迹 JSONL 路径。
 *
 * **在 cwd 对应的目录里按 id 扫**（新名 `<时间戳>_<id>.jsonl` 与旧名 `<id>.jsonl` 都认），
 * 找不到就按新形状拼一个（时间戳取现在）—— 调用方多是「准备写」。真要判存在自己
 * `existsSync`。旧平布局由启动时的 `migrateFlatTraces()` 一次性归位（见 config-home），
 * 这里不再回退去扫。
 */
export interface TracePathOptions {
  /** 工作目录：轨迹落在它编码出来的子目录里。 */
  cwd?: string;
  /** 显式目录（测试 / 自定义布局）：给了就**只**用这个目录，不再叠 cwd 编码。 */
  dir?: string;
}

export function tracePath(sessionId: string, options?: TracePathOptions | string): string {
  if (typeof options === 'string') {
    // 旧的位置参数形态（第二个参数就是目录）：只在那个目录里找。
    const target = path.resolve(options);
    return findFileById(target, sessionId) ?? path.join(target, traceFileName(sessionId));
  }
  const { cwd, dir } = options ?? {};
  if (dir) {
    const target = path.resolve(dir);
    return findFileById(target, sessionId) ?? path.join(target, traceFileName(sessionId));
  }
  const scoped = traceDirFor(cwd ?? process.cwd());
  const hit = findFileById(scoped, sessionId);
  if (hit !== null) return hit;
  return path.join(scoped, traceFileName(sessionId));
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
 * 读回一个会话：轨迹树 + 对话消息（不复用模型地重现一轮对话）。
 * 文件不存在就返回 null。
 */
export async function loadSession(
  sessionId: string,
  options?: TracePathOptions | string,
): Promise<ReplayedSession | null> {
  const file = tracePath(sessionId, options);
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  return replaySession(text, sessionId);
}

/** 只读回轨迹树（不要消息）。 */
export async function loadTrace(
  sessionId: string,
  options?: TracePathOptions | string,
): Promise<TraceTree | null> {
  const file = tracePath(sessionId, options);
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  return replayTrace(text, sessionId);
}

/**
 * 数一个轨迹文件的**完整行数**（不含末尾没换行的半行 —— 那是崩溃残骸，读回时也会被跳过）。
 *
 * 用途只有一处：续写已有文件前把落盘器的行游标拨到文件末尾（`seq` 严格等于行号的前提）。
 * 分块流式数换行，不把全文读进内存。文件不存在返回 0。
 */
export function countTraceLines(file: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(64 * 1024);
    let newlines = 0;
    let pos = 0;
    let partial = false;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      pos += read;
      partial = buf[read - 1] !== 0x0a;
      for (let i = 0; i < read; i += 1) {
        if (buf[i] === 0x0a) newlines += 1;
      }
    }
    // 末尾没换行的半行不算一行：追加会从新行开始，行号才算得准。
    return partial ? newlines + 1 : newlines;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }
}

/**
 * 列出所有已落盘的**轨迹**会话 id：扫 cwd 对应的子目录；显式 `dir` 则扫那个目录
 * （测试）。跨项目找 id 用 config-home 的 `findTraceFile`。
 */
export async function listTraceSessionIds(options?: TracePathOptions): Promise<string[]> {
  const target = options?.dir
    ? path.resolve(options.dir)
    : traceDirFor(options?.cwd ?? process.cwd());
  if (!existsSync(target)) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.init.jsonl'))
    .map((entry) => entry.name);
  return names.map((name) => sessionIdFromFileName(name)).sort();
}
