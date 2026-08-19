import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Slug a cwd absolute path into a filesystem-safe workspace token. */
export function slugWorkspace(cwd: string): string {
  return path
    .resolve(cwd)
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+/g, '-');
}

export interface SessionLineBase {
  ts: string;
}
export interface SessionEvent extends SessionLineBase {
  kind: 'event';
  /** Lifecycle event name with embedded phase, e.g. "system_prompt/start". (ADR-0006) */
  event: string;
  payload: any;
}
export interface SessionMessage extends SessionLineBase {
  kind: 'message';
  role: string;
  content: any;
}
export type SessionLine = SessionEvent | SessionMessage;

export interface SessionStoreOptions {
  workspace?: string;
  sessionId?: string;
}

export interface LoadedSession {
  sessionId: string;
  workspace: string;
  messages: SessionMessage[];
}

type AppendableLine =
  | { kind: 'event'; event: string; payload: any; ts?: string }
  | { kind: 'message'; role: string; content: any; ts?: string };

/**
 * Core-owned, append-only session store. One jsonl file per session at
 * `~/.applepi/sessions/<workspace>/<session_id>.jsonl`. The file is never
 * rewritten; the LLM-facing message array is a pure read-time transform.
 */
export class SessionStore {
  readonly workspace: string;
  sessionId: string | null = null;

  constructor(opts: SessionStoreOptions = {}) {
    this.workspace = opts.workspace ?? slugWorkspace(process.cwd());
    this.sessionId = opts.sessionId ?? null;
  }

  private baseDir(): string {
    return path.join(os.homedir(), '.applepi', 'sessions', this.workspace);
  }

  filePath(id: string = this.sessionId ?? ''): string {
    if (!id) throw new Error('SessionStore: no session id (call create() first)');
    return path.join(this.baseDir(), `${id}.jsonl`);
  }

  /** Open (create if needed) a session and return its id. */
  async create(sessionId?: string): Promise<string> {
    // Honor an explicit arg, else an id set via options, else generate one.
    this.sessionId = sessionId ?? this.sessionId ?? randomUUID();
    await fs.mkdir(this.baseDir(), { recursive: true });
    return this.sessionId;
  }

  private async append(line: AppendableLine): Promise<void> {
    if (!this.sessionId) throw new Error('SessionStore: no session id (call create() first)');
    const full = {
      ...line,
      ts: line.ts ?? new Date().toISOString(),
    };
    await fs.appendFile(this.filePath(), JSON.stringify(full) + '\n', 'utf8');
  }

  async appendEvent(event: string, payload: any = {}): Promise<void> {
    await this.append({ kind: 'event', event, payload });
  }

  async appendMessage(role: string, content: any): Promise<void> {
    await this.append({ kind: 'message', role, content });
  }

  /** Read-time replay: message lines only, with reload replacing message[0]. */
  async load(): Promise<LoadedSession> {
    if (!this.sessionId) throw new Error('SessionStore: no session id (call create() first)');
    const raw = await fs.readFile(this.filePath(), 'utf8');
    const lines: SessionLine[] = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const messages = lines.filter((l): l is SessionMessage => l.kind === 'message');

    // ADR-0006: event field carries type+phase (e.g. "reload/start"). The `?.`
    // guard tolerates pre-0006 files where the line has no `event` field —
    // they simply never match, which is the intended no-back-compat behavior.
    const hasReload = lines.some((l) => l.kind === 'event' && l.event?.startsWith('reload'));
    let result = messages;
    if (hasReload) {
      const sysIdxs = messages
        .map((m, i) => (m.role === 'system' ? i : -1))
        .filter((i) => i >= 0);
      if (sysIdxs.length > 0) {
        const lastSys = sysIdxs[sysIdxs.length - 1];
        const lastSysMsg = messages[lastSys];
        // Most-recently-rebuilt system message becomes message[0]; all other
        // system messages are dropped. The raw jsonl is left untouched.
        result = [lastSysMsg, ...messages.filter((m) => m.role !== 'system')];
      }
    }

    return { sessionId: this.sessionId, workspace: this.workspace, messages: result };
  }

  /** List session ids in this workspace (filenames without extension). */
  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.baseDir());
      return files
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace(/\.jsonl$/, ''))
        .sort();
    } catch {
      return [];
    }
  }
}
