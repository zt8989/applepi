/**
 * 会话文件：`<sessionId>.jsonl`，首行 header，其后每行一条 entry。
 *
 * ## 格式照抄 pi
 *
 * header（`SessionHeader`，见 pi-coding-agent 的 session-manager.d.ts）：
 *
 *     {"type":"session","version":1,"id":"…","timestamp":"…","cwd":"…"}
 *
 * entry（`SessionEntryBase` + 各自的字段）：
 *
 *     {"type":"message","id":"…","parentId":null,"timestamp":"…","message":{…}}
 *
 * 为什么照抄：本项目**不要求** pi 能读我们的会话（那是另一件事），但抄一份格式有两个
 * 实利 —— 目录结构与 pi 一致（将来若要互通不用改），以及这份 header 定义是经过实战
 * 的，不用自己发明。
 *
 * ## 轨迹不写在这里
 *
 * 轨迹（一次尝试一节点）在 `traces/<id>.jsonl`，与本文件分开。理由：轨迹是**每次对话**
 * 的产物、落盘频繁；会话文件是给人读的历史。混在一起的话「读一个会话」要先跳过一堆
 * 与它无关的记录。
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, sessionPath } from './config-home';
import type { Message } from '@earendil-works/pi-ai';

export const SESSION_VERSION = 1;

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

let entrySeq = 0;
/** entry id：会话内单调递增（`e1` `e2` …）。 */
function nextEntryId(): string {
  entrySeq += 1;
  return `e${entrySeq}`;
}

export function resetEntrySeq(value = 0): void {
  entrySeq = value;
}

export function entrySeqValue(): number {
  return entrySeq;
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

// ─── 写 ───

export class SessionWriter {
  private readonly file: string;
  private header: SessionHeader | null = null;
  private lastId: string | null = null;
  /** header 是否已落盘（推迟到第一条消息，空会话不建文件）。 */
  private wroteHeader = false;
  /** 文件本来就存在（恢复旧会话）：header 已在盘上，不再写。 */
  private existed = false;

  constructor(
    readonly id: string,
    readonly cwd: string,
  ) {
    this.file = sessionPath(id, cwd);
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
    if (existsSync(this.file)) this.existed = true;
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
    const full: SessionEntry = {
      ...entry,
      id: entry.id ?? nextEntryId(),
      parentId: this.lastId,
      timestamp: nowIso(),
    };
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, 'utf8');
    this.lastId = full.id;
    entrySeq = Math.max(entrySeq, Number.parseInt(full.id.replace(/^e/, ''), 10) || 0);
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

// ─── 读 ───

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

/** 读会话并把其中的 message 条目按顺序取出（恢复历史用）。 */
export function readSessionMessages(file: string): Message[] {
  const session = readSession(file);
  if (!session) return [];
  const out: Message[] = [];
  for (const entry of session.entries) {
    if (entry.type === 'message') {
      const message = (entry as MessageEntry).message;
      if (message) out.push(message);
    }
  }
  return out;
}

/**
 * 只读 JSONL 的开头若干字节，逐行解析。
 *
 * ## 为什么需要它
 *
 * 会话文件里一条 toolResult 能有几百 KB（一次 `ls -la` 的输出、一次 grep 的全部命中），
 * 而**列表界面要的只是首条用户消息** —— 它在文件的前几行。为了显示 124 个会话的标题
 * 而把 18MB 全 parse 一遍（那是早先 `sessionTitle()` 干的事），就是「打开 /sessions 等一分钟」。
 *
 * `stopAfter` 是真正的省法：拿到想要的 entry 就不再往下读。标题那条路上第一条 user 消息
 * 一命中就停，于是实际读量与**第一个问题有多长**成正比，与这个会话聊了多久无关。
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
