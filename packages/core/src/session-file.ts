/**
 * 会话文件：`<时间戳>_<id>.jsonl`，首行 header，其后每行一条 entry。
 *
 * 格式照抄 pi（header + `<SessionEntryBase>` 派生的各类 entry），好处是目录结构与 header 定义
 * 都与 pi 一致 —— 将来要互通不必改，也不必自己发明一份格式。文件名与 id 同一规则（ISO 串把
 * `:` `.` 换成 `-`，id 是 UUIDv7）：目录一眼看出先后，id 不靠文件名也能从 header 读出来。
 * 改名之前的旧文件（`<id>.jsonl`）仍然读得到（见 config-home 的 `findFileById`）。
 *
 * 轨迹（一次尝试一节点）不写在这里，在 `traces/<时间戳>_<id>.jsonl`：轨迹落盘频繁，混在
 * 一起的话「读一个会话」得先跳过一堆无关记录。
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ensureDir, findFileById, sessionDirFor, sessionFileName } from './config-home';
import type { Message, SystemMessage } from '@earendil-works/pi-ai';

/**
 * 会话文件版本 —— **与 pi 当前那版对齐（`CURRENT_SESSION_VERSION = 3`）**，因为我们产出的
 * 必须是 pi 能直接读的文件。pi 的 v1→v3 迁移只是补 `id`/`parentId` 树与 role 改名，那些
 * 字段我们写的时候本来就有，所以 v3 不是「要迁移」，是「本来就是这个形状」。
 *
 * v3 的两样开头脑子（本文件 + session-recorder 一起产出）：**`model_change`**（pi 用它恢复
 * 「这一段用哪个模型」）与**一条 `system` 消息**（`sections` = 整份 prompt 的分段 +
 * `toolsAdded` = 装载时那批工具的完整声明），pi 靠它 `_restoreToolsFromTranscript()` 把工具
 * 表装回来。
 */
export const SESSION_VERSION = 3;

export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  /** ISO 时间。 */
  timestamp: string;
  cwd: string;
  /** 分叉来源（pi 用来做 session tree）。我们还没用上，但字段留着。 */
  parentSession?: string;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  /** ISO 时间。 */
  timestamp: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: 'message';
  message: Message;
}

export interface ModelChangeEntry extends SessionEntry {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface ThinkingChangeEntry extends SessionEntry {
  type: 'thinking_level_change';
  thinkingLevel: string;
}

/** 一次会话在内存里的形态。 */
export interface Session {
  header: SessionHeader;
  entries: SessionEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * entry id 的序号（`e1` `e2` …）。
 *
 * **每一份 entry 占一个序号** —— 不只是 `message`，`model_change` /
 * `thinking_level_change` / 开头那条 system 消息也都占。续写一个已存在的会话时，
 * 序号从文件里**最后一条 entry** 接着数（见 `SessionWriter.start`），否则新写的
 * entry 会与已有的撞 id，而 pi 用 id/parentId 建会话树 —— 撞了树就散。
 */
function seqOf(id: string): number {
  return Number.parseInt(id.replace(/^e/, ''), 10) || 0;
}

export function createSessionHeader(options: {
  id: string;
  cwd: string;
  parentSession?: string | undefined;
}): SessionHeader {
  return {
    type: 'session',
    version: SESSION_VERSION,
    id: options.id,
    timestamp: nowIso(),
    cwd: options.cwd,
    ...(options.parentSession !== undefined ? { parentSession: options.parentSession } : {}),
  };
}


export class SessionWriter {
  private readonly file: string;
  private header: SessionHeader | null = null;
  private lastId: string | null = null;
  /** 下一条 entry 的序号（从已有文件接着数，见 `start`）。 */
  private seq = 0;
  /** header 是否已落盘（推迟到第一条消息，空会话不建文件）。 */
  private wroteHeader = false;
  /** 文件本来就存在（恢复旧会话）：header 已在盘上，不再写。 */
  private existed = false;

  constructor(
    readonly id: string,
    readonly cwd: string,
  ) {
    // 会话文件路径：
    //   - **已有**这个 id 的文件（恢复旧会话）就用它 —— 不能改名，续写要写回原文件；
    //   - 否则按 pi 的形状建新名 `<时间戳>_<id>.jsonl`（时间戳取现在）。
    //
    // 为什么不一律用新名：恢复一个历史会话时，用户期望的就是「接着写那个文件」。
    // 另建一个新名的文件会让同一个会话在盘上分成两份，而旧那份从此不再更新。
    this.file =
      findFileById(sessionDirFor(cwd), id) ?? path.join(sessionDirFor(cwd), sessionFileName(id));
  }

  get path(): string {
    return this.file;
  }

  /**
   * 记住 header，但**先不落盘**。
   *
   * 为什么不立刻写：每次启动内核都会建一个会话，如果这时就把 header 写下去，
   * `sessions/` 里会攒一堆「一行 header、零条消息」的空文件 —— 用户列表里全是噪声。
   * 真正的写盘推迟到第一条消息（见 `append`）。
   */
  start(header?: SessionHeader): void {
    this.header = header ?? createSessionHeader({ id: this.id, cwd: this.cwd });
    // 文件已存在说明是恢复旧会话：header 用现成的，不重写。
    if (existsSync(this.file)) {
      this.existed = true;
      // 续写要把链接上：`parentId` 必须是文件里最后一条 entry（不是 null），
      // entry id 也从它后面接着数（不与已有的撞）。pi 用 id/parentId 建会话树，
      // 断了链它会把这半段当成另一棵树 —— 恢复时只看得到后半段。
      const last = readLastEntry(this.file);
      if (last) {
        this.lastId = last.id;
        this.seq = Math.max(this.seq, seqOf(last.id));
      }
    }
  }

  /** 确保 header 已落盘（第一次写消息时调）。 */
  private ensureHeader(): void {
    if (this.wroteHeader || this.existed) {
      this.wroteHeader = true;
      return;
    }
    ensureDir(path.dirname(this.file));
    writeFileSync(this.file, `${JSON.stringify(this.header)}\n`, 'utf8');
    this.wroteHeader = true;
  }

  append(entry: { type: string; id?: string } & Record<string, unknown>): SessionEntry {
    // 第一条消息到了才落 header —— 空的会话文件不写盘。
    this.ensureHeader();
    this.seq += 1;
    const full: SessionEntry = {
      ...entry,
      id: entry.id ?? `e${this.seq}`,
      parentId: this.lastId,
      timestamp: nowIso(),
    };
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, 'utf8');
    this.lastId = full.id;
    this.seq = Math.max(this.seq, seqOf(full.id));
    return full;
  }

  appendMessage(message: Message): MessageEntry {
    return this.append({ type: 'message', message }) as MessageEntry;
  }

  appendModelChange(provider: string, modelId: string): ModelChangeEntry {
    return this.append({ type: 'model_change', provider, modelId }) as ModelChangeEntry;
  }

  appendThinkingChange(thinkingLevel: string): ThinkingChangeEntry {
    return this.append({ type: 'thinking_level_change', thinkingLevel }) as ThinkingChangeEntry;
  }
}


/**
 * 读文件里**最后一条** entry（续写时接上 `id` / `parentId` 链用）。
 *
 * 只读尾巴一段：一个会话文件是只追加的，最后一条就在末尾。单条 entry 可能很大
 * （一条 toolResult 能有几百 KB），所以尾巴窗口取 1MB；万一最后一行比窗口还长、
 * 解析不出来，再退回整份读一次（正确优先 —— 这是续写，宁可慢一点也不能接错 id）。
 */
function readLastEntry(file: string): SessionEntry | null {
  const window = 1024 * 1024;
  let fd: number | undefined;
  let text: string;
  let fromStart = false;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - window);
    fromStart = start === 0;
    const buf = Buffer.allocUnsafe(size - start);
    if (buf.length === 0) return null;
    const read = readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8', 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }

  const lines = text.split('\n').filter((l) => l.trim() !== '');
  // 窗口从半行开始时，第一条可能被截断 —— 跳过它。
  const candidates = fromStart ? lines : lines.slice(1);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i] as string) as SessionEntry;
      if (parsed.type === 'session') continue;
      return parsed;
    } catch {
      // 这一行被窗口截断（或崩溃半行）：上一行也不是它，退回整份读。
      break;
    }
  }
  if (fromStart) return null;
  try {
    const parsed = readSession(file);
    return parsed && parsed.entries.length > 0 ? (parsed.entries[parsed.entries.length - 1] as SessionEntry) : null;
  } catch {
    return null;
  }
}

export function readSession(file: string): Session | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const headerLine = lines.find((l) => l.trim() !== '');
  if (!headerLine) return null;
  let header: SessionHeader;
  try {
    header = JSON.parse(headerLine) as SessionHeader;
  } catch {
    return null; // header 坏掉：当作没有这个会话
  }
  if (header.type !== 'session') return null;

  const entries: SessionEntry[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as SessionEntry;
      // 跳过 header 自己。
      if (parsed.type === 'session') continue;
      entries.push(parsed);
    } catch {
      // 崩溃截断的半行：跳过，不让整个会话读不出来。
    }
  }
  return { header, entries };
}

/**
 * 这条 message 是不是 pi v3 的**开头 system 消息**（system prompt + tools）。两条判据：
 * head 一定带 `toolsAdded`（中途那条段 patch 没有它）；万一工具一个都没有，head 也**没有
 * `source` 字段**，而段 patch 都带着它。只看**第一条** message：head 永远在最前。
 */
function isLeadingHead(message: Message): boolean {
  const sys = message as SystemMessage;
  if (sys.role !== 'system') return false;
  if (Array.isArray(sys.toolsAdded) && sys.toolsAdded.length > 0) return true;
  return !('source' in (message as Record<string, unknown>));
}

/** 把读出来的会话里的 message 条目按顺序取出（恢复历史用）。 */
export function sessionMessages(session: Session): Message[] {
  const out: Message[] = [];
  // 第一条 message 若是 head（system prompt + tools），**跳过**：它不是对话消息，
  // 而是「请求头部」—— 本项目那份由 `state.prompt` 重建、每轮前置，读回来会变成
  // 两条 head（前缀也对不上了）。v1 老文件与 pi 的文件都走这条判断。
  let firstMessage = true;
  for (const entry of session.entries) {
    if (entry.type === 'message') {
      const message = (entry as MessageEntry).message;
      if (!message) continue;
      if (firstMessage) {
        firstMessage = false;
        if (isLeadingHead(message)) continue;
      }
      out.push(message);
    }
  }
  return out;
}

/** 读会话并把其中的 message 条目按顺序取出（恢复历史用）。 */
export function readSessionMessages(file: string): Message[] {
  const session = readSession(file);
  return session ? sessionMessages(session) : [];
}

/**
 * 一个会话里与**思考级别**有关的事实。
 *
 * 三项一次给全，因为它们总是同一时刻被问的（启动解析级别 + 决定要不要回填一条记录），
 * 而分开各扫一遍这个文件在长会话上是 18MB × N。
 */
export interface SessionThinkingInfo {
  /**
   * 文件里有几条消息。
   *
   * **0 = pi 眼里「这不算已有会话」** —— pi 的 `hasExistingSession` 是
   * `existingSession.messages.length > 0`（`core/sdk.js:84`）。空壳文件（只有 header 或只有
   * `model_change`）会走「新会话」那条分支，于是**不会**去读它的思考级别。
   */
  hasMessages: boolean;
  /**
   * 有没有 `thinking_level_change` 条目。
   *
   * 没有 = 这个会话没记过用哪一档（早于这个功能的会话、或手写的文件），按 pi 的
   * `sdk.js:279-283` 应该**回填一条**，否则下次恢复又得靠默认值猜。
   */
  hasEntry: boolean;
  /**
   * 最后一条 `thinking_level_change` 的**原文**（没有就是 `undefined`）。
   *
   * 原文而不是校验过的档位：会话文件是用户可改的，而「读文件」这一层不该替调用方决定
   * 坏值怎么处理（`thinking-level.ts` 的解析函数把非法值当「没给」）。
   * 「最后一条生效」与 pi 的 `getSessionContextSettings()` 同一口径（它沿叶子路径走，
   * 最后一条覆盖前面所有）。本项目还没有分支树，所以「文件里最后一条」等价。
   */
  level: string | undefined;
}

/** 从读出来的会话里取思考级别那几项事实。 */
export function sessionThinking(session: Session): SessionThinkingInfo {
  let messages = 0;
  let hasEntry = false;
  let level: string | undefined;
  for (const entry of session.entries) {
    if (entry.type === 'message') {
      messages += 1;
    } else if (entry.type === 'thinking_level_change') {
      hasEntry = true;
      const value = (entry as ThinkingChangeEntry).thinkingLevel;
      if (typeof value === 'string') level = value;
    }
  }
  return { hasMessages: messages > 0, hasEntry, level };
}

/**
 * 读盘版：一次性拿「这个会话已经有什么」。文件不存在 → `undefined`。
 *
 * 启动（`--session <id>` 决定初始档位）与恢复（决定要不要把级别带回来、要不要回填一条
 * 记录）都用它，所以「这个会话有没有那条记录」只有一个定义。
 */
export function readSessionThinking(file: string): SessionThinkingInfo | undefined {
  const session = readSession(file);
  return session ? sessionThinking(session) : undefined;
}

/**
 * 只读 JSONL 的开头若干字节，逐行解析。
 *
 * 一条 toolResult 能有几百 KB（一次 grep 的全部命中），而列表界面要的只是首条用户消息 ——
 * 它在文件的前几行。为显示标题把 18MB 全 parse 一遍就是「打开 /resume 等一分钟」。
 *
 * `stopAfter` 是真正的省法：拿到想要的 entry 就不再往下读，于是读量与「第一个问题有多长」
 * 成正比，与这个会话聊了多久无关。
 *
 * @param bytes     最多读多少字节（至少读到一整行，不截半行）
 * @param stopAfter 返回 true 就停：不再解析后面的行，也不再继续读盘
 */
export function readJsonlHead(
  file: string,
  bytes: number,
  options: { stopAfter?: (entry: SessionEntry) => boolean } = {},
): { header: SessionHeader | null; content: SessionEntry[] } {
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    text = buf.toString('utf8', 0, read);
  } catch {
    return { header: null, content: [] };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }

  // 末尾那一行可能被截断了（读盘只取了前 N 字节），不能当半行 JSON.parse ——
  // 截断的行本来就可能 parse 失败，而让它「失败就被跳过」等于把一行正常内容丢掉。
  const lastNewline = text.lastIndexOf('\n');
  const usable = lastNewline < 0 ? '' : text.slice(0, lastNewline);

  let header: SessionHeader | null = null;
  const content: SessionEntry[] = [];
  for (const line of usable.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: SessionEntry;
    try {
      parsed = JSON.parse(line) as SessionEntry;
    } catch {
      continue; // 崩溃截断的半行：跳过，不让整个会话读不出来。
    }
    if (parsed.type === 'session') {
      header = header ?? (parsed as unknown as SessionHeader);
      continue;
    }
    content.push(parsed);
    if (options.stopAfter?.(parsed)) break;
  }
  return { header, content };
}

/**
 * 只读 JSONL 的**最后**若干字节，倒着扫行。
 *
 * 列表里那栏「最近一次活动」的 `timestamp` 在每一行里，而最后一次活动几乎总在**文件末尾**
 * （会话文件只追加）—— 从尾巴读就不必把整个会话读一遍。
 *
 * 取**最大** timestamp 而不是最后一行的：文件里可能留着空壳会话（header 之后没有消息），
 * 中途失败的那一轮也可能「工具结果写完了、assistant 消息没写」，那时末尾那行不代表最后一次
 * 真正说过话。代价只是多读已经在读的这段字节，收益是排序与「3 分钟前」那个数**准**。
 *
 * @param bytes 最多读文件末尾多少字节
 */
export function readJsonlTail(file: string, bytes: number): { lastActivityMs: number } {
  let fd: number | undefined;
  let text: string;
  try {
    fd = openSync(file, 'r');
    // 先问文件多大，再决定从哪儿读、读多少 —— 单次 readSync 到末尾会读到 null。
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - start);
    if (buf.length === 0) return { lastActivityMs: 0 };
    const read = readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8', 0, read);
  } catch {
    return { lastActivityMs: 0 };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 读失败后的清理失败不值得抛。
      }
    }
  }

  // 开头那一行可能被截断了（从中间开始读），不能当半行 JSON.parse。
  const firstNewline = text.indexOf('\n');
  const usable = firstNewline < 0 ? '' : text.slice(firstNewline + 1);

  let lastActivityMs = 0;
  for (const line of usable.split('\n')) {
    if (line.trim() === '') continue;
    let entry: SessionEntry & { message?: { role?: string; timestamp?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // 崩溃截断的半行：跳过，不让整个会话读不出来。
    }
    // 与 pi 的 `getMessageActivityTime()` 同一口径：**只算** user/assistant。
    // toolResult 的 timestamp 也会「动」，而那不该让会话看起来刚刚活跃过。
    const message = entry.message;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const ms =
      typeof message.timestamp === 'number'
        ? message.timestamp
        : Date.parse(String(entry.timestamp ?? ''));
    if (Number.isFinite(ms) && ms > lastActivityMs) lastActivityMs = ms;
  }
  return { lastActivityMs };
}

export interface SessionInfoEntryLike extends SessionEntry {
  type: 'session_info';
  /** 用户给会话起的名字。空串 = 显式清掉上一个名字（与 pi 同一语义）。 */
  name?: string;
}

/**
 * 给会话起名：往那个会话文件**追加**一条 `session_info`（调用方：`/name` 与历史面板的重命名）。
 *
 * 与 pi 同一个 entry type，所以两边都能读到这个名字（都是「倒着找最后一条 `session_info`」）。
 *
 * **append 而不是重写**：entry 用 `parentId` 串成一条链，重写要重排那条链，而改名不该动它。
 *
 * **随机 id 而不是接着 writer 的 `seq` 数**：本函数是带外调用，与正在记录的 `SessionWriter`
 * 各按「链尾 id 往后数」会算出同一个 id，链上就出现两个同 id 节点。副作用是这条
 * `session_info` 与下一条消息在 `parentId` 上成了兄弟 —— 可接受（pi 的会话树本来就有分叉，
 * 它外部 append 时也是这个形状）。
 *
 * 名字里的换行压成空格：一条 `session_info` = 一行 JSON，换行会把它劈成两半，于是这个名字
 * 看起来没生效。**空名字 = 清掉名字**（pi 的语义：最后一条说了算，空串 = 显式清名）。
 */
export function appendSessionName(file: string, name: string): void {
  const sanitized = name.replace(/[\r\n]+/g, ' ').trim();
  if (sanitized === '') return;
  const entry = {
    type: 'session_info',
    // id：8 位随机（pi 的 `generateId()` 也是 8 位）。这条 entry 不参与消息树，
    // 但要有 id 才能与 pi 的 `session_info` 形状一致。
    id: randomUUID().slice(0, 8),
    parentId: lastEntryId(file),
    timestamp: new Date().toISOString(),
    name: sanitized,
  };
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * 最后一条 entry 的 id（链尾）。读文件末尾 64KB 就够 —— 一条 entry id 只有 8 字符。
 *
 * 读不到就 `null`（一条 `session_info` 挂在链首是合法的：那条链后面还有消息）。
 */
function lastEntryId(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.allocUnsafe(size - start);
    readSync(fd, buf, 0, buf.length, start);
    // 开头那一行可能被截断了，跳过它。
    const lines = buf.toString('utf8').split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;
      let entry: { type?: string; id?: string };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        continue; // 崩溃截断的半行：跳过。
      }
      if (entry.type !== 'session') return entry.id ?? null;
    }
    return null;
  } catch {
    return null;
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

/** 会话的第一句话（列表里做标题用）。 */
export function sessionTitle(file: string, maxLength = 40): string {
  const messages = readSessionMessages(file);
  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : contentToText(m.content);
      const line = text.trim().split('\n')[0] ?? '';
      return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
    }
  }
  return '(空会话)';
}

function contentToText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => ('text' in c ? c.text : '[image]')).join(' ');
  }
  return '';
}
