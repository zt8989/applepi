import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toText } from './message.js';
import type { ReasoningLevel, PermissionLevel } from './config.js';

/** Slug a cwd absolute path into a filesystem-safe workspace token. */
export function slugWorkspace(cwd: string): string {
  return path
    .resolve(cwd)
    .replace(/^[/\\]+/, '')
    .replace(/[/\\]+/g, '-')
    // Windows forbids these characters in file/dir names. The drive colon
    // (`C:`) in an absolute path would otherwise produce an invalid slug
    // (mkdir then fails with ENOENT).
    .replace(/[<>:"|?*]/g, '-');
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
  /**
   * Override the on-disk root for this store. Defaults to `~/.applepi/sessions`.
   * Tests inject a temp dir so they never touch the real user config.
   */
  baseDir?: string;
}

export interface LoadedSession {
  sessionId: string;
  workspace: string;
  messages: SessionMessage[];
}

/** Session display metadata for listing (deepen #02). */
export interface SessionSummary {
  id: string;
  /** Last `title/set` event, else the first user message (truncated). */
  title: string;
  /** File mtime (ISO). */
  ts: string;
  /** Last `pin/set` event payload (default false). */
  pinned: boolean;
  /** Last `notify/set` event payload (default false). */
  notify: boolean;
}

/** Extract plain text from a message's `content` via the shared contract. */
function messageText(content: any): string {
  return toText(content).trim();
}

/**
 * The unified session-scoped configuration (ADR-0016), persisted in a sibling
 * `<session_id>.config.json>` next to the jsonl. **Override-only (diff mode)**:
 * the file holds only values explicitly set for this session (model /
 * reasoningLevel / permissionLevel) plus the build-time identity fields
 * (workspace / mode). Absent fields are not written, so a `general` default
 * from settings.json can propagate to any session that has not overridden it.
 */
export interface SessionConfig {
  /** Tool working root (absolute path) — identity, build-time immutable. */
  workspace?: string;
  /** The bundle/mode the session runs under — identity, build-time immutable. */
  mode?: string;
  /** Session model override (providerId + modelId). */
  model?: { providerId: string; modelId: string };
  /** Session reasoning-level override. */
  reasoningLevel?: ReasoningLevel;
  /** Session permission-level override. */
  permissionLevel?: PermissionLevel;
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
  private readonly root: string;

  constructor(opts: SessionStoreOptions = {}) {
    this.workspace = opts.workspace ?? slugWorkspace(process.cwd());
    this.sessionId = opts.sessionId ?? null;
    // Default root: ~/.applepi/sessions. Overridable for tests (ADR-0014 era).
    this.root = opts.baseDir ?? path.join(os.homedir(), '.applepi', 'sessions');
  }

  private baseDir(): string {
    return path.join(this.root, this.workspace);
  }

  filePath(id: string = this.sessionId ?? ''): string {
    if (!id) throw new Error('SessionStore: no session id (call create() first)');
    return path.join(this.baseDir(), `${id}.jsonl`);
  }

  /** The sibling session-config file path (ADR-0016). */
  configPath(id: string = this.sessionId ?? ''): string {
    if (!id) throw new Error('SessionStore: no session id (call create() first)');
    return path.join(this.baseDir(), `${id}.config.json`);
  }

  /**
   * Read the session jsonl and split it into trimmed, non-empty raw lines.
   * The ONE place the file is read + line-split; each caller JSON.parses with
   * its own tolerance (deepen-followups #02):
   *   - `load()` / `lastEvent()` propagate parse errors (a corrupt line fails
   *     loudly);
   *   - `scanMeta()` skips corrupt lines.
   * A missing file propagates ENOENT — callers that tolerate absence
   * (`lastEvent` → null, `scanMeta` → {}) catch it here; `load()` lets it
   * propagate (its caller, `Harness.resume`, turns ENOENT into a fresh
   * session).
   */
  private async readLines(id: string = this.sessionId ?? ''): Promise<string[]> {
    const raw = await fs.readFile(this.filePath(id), 'utf8');
    return raw.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Read the session config (ADR-0016). Missing or corrupt file → `{}` (no
   * overrides, no fail-fast — it is not required config; P11 applies to the
   * global settings.json, not this per-session override file).
   */
  async loadConfig(): Promise<SessionConfig> {
    if (!this.sessionId) throw new Error('SessionStore: no session id (call create() first)');
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath(), 'utf8');
    } catch {
      return {};
    }
    try {
      return JSON.parse(raw) as SessionConfig;
    } catch {
      return {};
    }
  }

  /**
   * Persist the session config (ADR-0016). Atomic full rewrite (write a temp
   * sibling, then rename) so a crash never leaves a half-written file. The
   * jsonl is untouched — config and audit/messages live in separate files.
   */
  async saveConfig(config: SessionConfig): Promise<void> {
    if (!this.sessionId) throw new Error('SessionStore: no session id (call create() first)');
    await fs.mkdir(this.baseDir(), { recursive: true });
    const file = this.configPath();
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }

  /** Open (create if needed) a session and return its id. */
  async create(sessionId?: string): Promise<string> {
    // Honor an explicit arg, else an id set via options, else generate one.
    const id = sessionId ?? this.sessionId ?? randomUUID();
    this.sessionId = id;
    await fs.mkdir(this.baseDir(), { recursive: true });
    return id;
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
    const lines: SessionLine[] = (await this.readLines()).map((l) => JSON.parse(l));
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

  /**
   * Read the LAST event with the given name (e.g. `level/set`), or null if
   * none exists. Scans the file from the tail so the most recent occurrence
   * wins; the file is never mutated. Events are otherwise discarded by
   * `load()`, so this is the read primitive for state that lives in events.
   */
  async lastEvent(name: string): Promise<SessionEvent | null> {
    if (!this.sessionId) throw new Error('SessionStore: no session id (call create() first)');
    let lines: SessionLine[];
    try {
      lines = (await this.readLines()).map((l) => JSON.parse(l));
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null; // fresh session with no lines yet
      throw e; // parse errors fail loudly as before; non-ENOENT fs errors now
      // propagate too (previously swallowed into null) — absence is the only
      // tolerated "no state" case.
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.kind === 'event' && l.event === name) return l;
    }
    return null;
  }

  /**
   * Scan display metadata (title/pinned/notify) from the jsonl in one pass
   * (deepen #02). Last `title/set` wins; else the first user message text
   * (truncated at 40 chars); else no title (callers default it).
   */
  private async scanMeta(id: string): Promise<{ title?: string; pinned?: boolean; notify?: boolean }> {
    let lines: string[];
    try {
      lines = await this.readLines(id);
    } catch {
      return {}; // fresh session with no lines yet
    }
    let title: string | undefined;
    let firstUser: string | undefined;
    let pinned: boolean | undefined;
    let notify: boolean | undefined;
    for (const line of lines) {
      let l: SessionLine;
      try {
        l = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }
      if (l.kind === 'event') {
        if (l.event === 'title/set' && typeof l.payload?.title === 'string') {
          title = l.payload.title;
        } else if (l.event === 'pin/set') {
          pinned = l.payload?.pinned === true;
        } else if (l.event === 'notify/set') {
          notify = l.payload?.enabled === true;
        }
      } else if (l.kind === 'message' && l.role === 'user' && firstUser === undefined) {
        const text = messageText(l.content);
        if (text) firstUser = text.length > 40 ? text.slice(0, 40) + '…' : text;
      }
    }
    return { title: title ?? firstUser, pinned, notify };
  }

  /** Display title for a session id: last `title/set`, else first user message (truncated). */
  async title(id: string = this.sessionId ?? ''): Promise<string> {
    const meta = await this.scanMeta(id);
    return meta.title ?? 'New Chat';
  }

  /** Whether the session is pinned (last `pin/set`, default false). */
  async pinned(id: string = this.sessionId ?? ''): Promise<boolean> {
    const meta = await this.scanMeta(id);
    return meta.pinned ?? false;
  }

  /** Whether session notifications are on (last `notify/set`, default false). */
  async notify(id: string = this.sessionId ?? ''): Promise<boolean> {
    const meta = await this.scanMeta(id);
    return meta.notify ?? false;
  }

  /** List this workspace's sessions with display metadata, newest mtime first. */
  async listSessions(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.baseDir());
    } catch {
      return [];
    }
    const ids = names
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
    const withMtime: { id: string; mtimeMs: number }[] = [];
    for (const id of ids) {
      try {
        const st = await fs.stat(this.filePath(id));
        withMtime.push({ id, mtimeMs: st.mtimeMs });
      } catch {
        // skip unreadable session file
      }
    }
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SessionSummary[] = [];
    for (const { id, mtimeMs } of withMtime) {
      const meta = await this.scanMeta(id);
      out.push({
        id,
        title: meta.title ?? 'New Chat',
        ts: new Date(mtimeMs).toISOString(),
        pinned: meta.pinned ?? false,
        notify: meta.notify ?? false,
      });
    }
    return out;
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
