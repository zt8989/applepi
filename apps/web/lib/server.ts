import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Harness,
  SessionStore,
  slugWorkspace,
  resolveLlmConfig,
  PERMISSION_SCRATCH_KEY,
  PERMISSION_LEVELS,
  type ResolvedLlmConfig,
} from '@applepi/core';
import {
  baseExtension,
  createMemoryExtension,
  createSkillsExtension,
} from '@applepi/extensions';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

/**
 * Server-side wiring for the web interface (ADR-0011): one Harness per
 * workspace (baseExtension + memory + skills reference extensions), one
 * provider model from ~/.applepi (ADR-0004), sessions mapped 1:1 to the core
 * SessionStore jsonl.
 */

const SESSIONS_DIR = () => path.join(os.homedir(), '.applepi', 'sessions');
const MANIFEST_FILE = () => path.join(SESSIONS_DIR(), '.manifest.json');

/**
 * Best-effort reverse of `slugWorkspace`: the slug 'Users-x-applepi' came from
 * '/Users/x/applepi', but the mapping is ambiguous (dirs may contain '-'). We
 * try every split point longest-first — first i slug tokens as individual dirs,
 * the remaining tokens merged back into one — and accept the FIRST candidate
 * that exists on disk. Workspaces created by the CLI have no manifest entry,
 * so this is how the web recovers their real path.
 */
export async function unslugWorkspace(slug: string): Promise<string | null> {
  const parts = slug.split('-');
  if (parts.length < 2) return null;
  for (let split = parts.length - 1; split >= 1; split--) {
    const candidate =
      '/' + parts.slice(0, split).join('/') + '/' + parts.slice(split).join('-');
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      // keep trying shorter splits
    }
  }
  return null;
}

/** Resolve a workspace reference (path or slug) to a slug token. */
export function workspaceToSlug(workspace: string): string {
  if (!workspace.includes('/') && !workspace.includes('\\')) return workspace; // already a slug
  return slugWorkspace(workspace);
}

function buildModel(cfg: ResolvedLlmConfig): any {
  const providerSettings = { apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) };
  if (cfg.provider === 'anthropic') {
    return createAnthropic(providerSettings)(cfg.model);
  }
  return createOpenAI(providerSettings)(cfg.model);
}

let modelPromise: Promise<any> | null = null;
/** Lazily resolve the provider model (cached; fails fast on bad config). */
export function getModel(): Promise<any> {
  if (!modelPromise) {
    modelPromise = resolveLlmConfig().then(buildModel);
  }
  return modelPromise;
}

const harnessCache = new Map<string, Harness>();

/** One wired Harness per workspace slug (cached for the server's lifetime). */
export function getHarness(workspace: string): Harness {
  const slug = workspaceToSlug(workspace);
  let h = harnessCache.get(slug);
  if (!h) {
    h = new Harness({ workspace: slug });
    h.registerExtension(baseExtension);
    h.registerExtension(createMemoryExtension());
    h.registerExtension(createSkillsExtension());
    // attachSession registers the skill event middleware once; the store is
    // replaced per request via bindSession.
    h.attachSession(new SessionStore({ workspace: slug }));
    harnessCache.set(slug, h);
  }
  return h;
}

/**
 * Point the harness at a session (resume existing or create new) and restore
 * its permission level. Sets `session.config.workspace` so the reference
 * tools scope to the selected workspace.
 */
export async function bindSession(
  harness: Harness,
  workspace: string,
  sessionId?: string,
): Promise<SessionStore> {
  const slug = workspaceToSlug(workspace);
  // Tool working root: prefer the real path; resolve bare slugs (stale
  // localStorage) to the on-disk path so bash/str_replace get a valid cwd.
  let toolRoot = workspace;
  if (!workspace.includes('/') && !workspace.includes('\\')) {
    toolRoot = (await unslugWorkspace(workspace)) ?? workspace;
  }
  harness.session.config.workspace = toolRoot;
  let store: SessionStore;
  if (sessionId) {
    store = await harness.resume(sessionId);
  } else {
    store = new SessionStore({ workspace: slug });
    await store.create();
    harness.sessionStore = store;
    harness.session.history = [];
    // Persist the initial system prompt once (single persist path, ADR-0010).
    await harness.emit('system_prompt');
  }
  await harness.restoreSecurity(store);
  return store;
}

/** system prompt (freshly rebuilt) + session history. */
export async function buildTurnMessages(harness: Harness): Promise<any[]> {
  const built = await harness.buildSystemPrompt();
  return [{ role: 'system', content: built.prompt }, ...harness.session.history];
}

/** Read the slug -> path manifest (best effort). */
export async function readManifest(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

export interface SessionInfo {
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

export interface WorkspaceInfo {
  slug: string;
  path?: string;
  sessions: SessionInfo[];
}

/**
 * Derive a session's display title: last `title/set` event wins, else the
 * first user message text (truncated), else "New Chat".
 */
export async function sessionTitle(
  workspace: string,
  id: string,
): Promise<string> {
  const store = new SessionStore({ workspace, sessionId: id });
  let raw = '';
  try {
    raw = await fs.readFile(store.filePath(), 'utf8');
  } catch {
    return 'New Chat';
  }
  let title: string | undefined;
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const l = JSON.parse(line);
      if (l.kind === 'event' && l.event === 'title/set' && typeof l.payload?.title === 'string') {
        title = l.payload.title;
      } else if (l.kind === 'message' && l.role === 'user' && title === undefined) {
        let text = '';
        if (typeof l.content === 'string') text = l.content;
        else if (Array.isArray(l.content)) {
          text = l.content
            .map((p: any) => (p?.type === 'text' ? p.text : ''))
            .join('')
            .trim();
        }
        if (text) title = text.length > 40 ? text.slice(0, 40) + '…' : text;
      }
    } catch {
      // skip malformed lines
    }
  }
  return title ?? 'New Chat';
}

/** Read `pin/set` (last wins) from a session file. */
export async function sessionPinned(workspace: string, id: string): Promise<boolean> {
  const store = new SessionStore({ workspace, sessionId: id });
  try {
    const ev = await store.lastEvent('pin/set');
    return ev?.payload?.pinned === true;
  } catch {
    return false;
  }
}

/** Read `notify/set` (last wins) from a session file. */
export async function sessionNotify(workspace: string, id: string): Promise<boolean> {
  const store = new SessionStore({ workspace, sessionId: id });
  try {
    const ev = await store.lastEvent('notify/set');
    return ev?.payload?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * List existing workspaces (slugs from the sessions dir) with their sessions,
 * each session with title / mtime / pinned / notify. Archived sessions (in
 * `.archive`) are excluded. Workspaces without a manifest path are resolved
 * best-effort from their slug (CLI-created dirs) and backfilled.
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const manifest = await readManifest();
  let slugs: string[] = [];
  try {
    slugs = (await fs.readdir(SESSIONS_DIR(), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    // sessions dir missing -> no workspaces yet
  }
  let changed = false;
  const out: WorkspaceInfo[] = [];
  for (const slug of slugs) {
    const dir = path.join(SESSIONS_DIR(), slug);
    let files: { id: string; ts: number }[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const id = e.name.replace(/\.jsonl$/, '');
        const st = await fs.stat(path.join(dir, e.name));
        files.push({ id, ts: st.mtimeMs });
      }
    } catch {
      // skip unreadable workspace
    }
    files.sort((a, b) => b.ts - a.ts);
    const sessions: SessionInfo[] = [];
    for (const f of files) {
      sessions.push({
        id: f.id,
        title: await sessionTitle(slug, f.id),
        ts: new Date(f.ts).toISOString(),
        pinned: await sessionPinned(slug, f.id),
        notify: await sessionNotify(slug, f.id),
      });
    }
    let wsPath: string | undefined = manifest[slug];
    if (!wsPath) {
      // CLI-created workspace: recover the real path from the slug so tools
      // and session access work (and the picker shows a path, not a slug).
      wsPath = (await unslugWorkspace(slug)) ?? undefined;
      if (wsPath) {
        manifest[slug] = wsPath;
        changed = true;
      }
    }
    out.push({ slug, path: wsPath, sessions });
  }
  if (changed) {
    await fs.writeFile(MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8').catch(() => {});
  }
  return out;
}

/** Add a workspace by absolute path (validated); records it in the manifest. */
export async function addWorkspace(p: string): Promise<{ slug: string; path: string }> {
  const abs = path.resolve(p);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`workspace path does not exist or is not a directory: ${abs}`);
  }
  const slug = slugWorkspace(abs);
  await fs.mkdir(path.join(SESSIONS_DIR(), slug), { recursive: true });
  const manifest = await readManifest();
  manifest[slug] = abs;
  await fs.writeFile(MANIFEST_FILE(), JSON.stringify(manifest, null, 2), 'utf8');
  return { slug, path: abs };
}

export interface SessionActionRequest {
  action: 'rename' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'notify' | 'level';
  title?: string;
  pinned?: boolean;
  enabled?: boolean;
  level?: string;
}

const ARCHIVE_DIR = (slug: string) => path.join(SESSIONS_DIR(), slug, '.archive');

/**
 * Apply a session action. Most are lightweight event writes (rename/pin/
 * notify) or file moves (archive/unarchive); `level` restores the harness,
 * writes `level/set` (ADR-0009) and rebuilds the system prompt.
 */
export async function applySessionAction(
  workspace: string,
  sessionId: string,
  req: SessionActionRequest,
): Promise<{ ok: true }> {
  const slug = workspaceToSlug(workspace);
  const store = new SessionStore({ workspace: slug, sessionId });

  switch (req.action) {
    case 'rename': {
      const title = String(req.title ?? '').trim().slice(0, 80);
      if (!title) throw new Error('rename requires a title');
      await store.create(sessionId);
      await store.appendEvent('title/set', { title });
      return { ok: true };
    }
    case 'pin':
      await store.create(sessionId);
      await store.appendEvent('pin/set', { pinned: true });
      return { ok: true };
    case 'unpin':
      await store.create(sessionId);
      await store.appendEvent('pin/set', { pinned: false });
      return { ok: true };
    case 'notify':
      await store.create(sessionId);
      await store.appendEvent('notify/set', { enabled: req.enabled === true });
      return { ok: true };
    case 'archive': {
      await fs.mkdir(ARCHIVE_DIR(slug), { recursive: true });
      await fs.rename(
        path.join(SESSIONS_DIR(), slug, `${sessionId}.jsonl`),
        path.join(ARCHIVE_DIR(slug), `${sessionId}.jsonl`),
      );
      return { ok: true };
    }
    case 'unarchive': {
      const src = path.join(ARCHIVE_DIR(slug), `${sessionId}.jsonl`);
      const st = await fs.stat(src).catch(() => null);
      if (!st) throw new Error(`archived session not found: ${sessionId}`);
      await fs.rename(src, path.join(SESSIONS_DIR(), slug, `${sessionId}.jsonl`));
      return { ok: true };
    }
    case 'level': {
      const level = String(req.level ?? '');
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level as any)) {
        throw new Error(`level must be one of: ${PERMISSION_LEVELS.join('|')}`);
      }
      const harness = getHarness(workspace);
      const bound = await bindSession(harness, workspace, sessionId);
      harness.session.scratch[PERMISSION_SCRATCH_KEY] = level;
      await bound.appendEvent('level/set', { level });
      await harness.emit('system_prompt/permission', { level });
      return { ok: true };
    }
    default:
      throw new Error(`unknown session action: ${(req as any).action}`);
  }
}

/** Raw session file contents (export). */
export async function readSessionFile(
  workspace: string,
  sessionId: string,
): Promise<string> {
  const slug = workspaceToSlug(workspace);
  const store = new SessionStore({ workspace: slug, sessionId });
  return fs.readFile(store.filePath(), 'utf8');
}

const execAsync = promisify(exec);

/**
 * Native folder picker (macOS only): opens the system directory chooser via
 * osascript and returns the REAL absolute path. The browser's
 * showDirectoryPicker only yields an opaque handle — useless for a workspace
 * the tools must run in — so we pick server-side.
 */
export async function pickFolder(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('打开本地文件夹仅支持 macOS（当前平台: ' + process.platform + '）');
  }
  const { stdout } = await execAsync(
    `osascript -e 'POSIX path of (choose folder)'`,
    { timeout: 120000 },
  );
  const p = (stdout ?? '').trim();
  if (!p) throw new Error('未选择文件夹');
  return p;
}
