import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SessionContext } from './types.js';
import type { SessionStore } from './session.js';
import {
  DEFAULT_PERMISSION_LEVEL,
  PERMISSION_LEVELS,
  loadSettings,
  type PermissionLevel,
} from './config.js';

/**
 * Security (ADR-0009, re-scoped by ADR-0015/0016) — the permission-enforcement
 * seam of the split core. The default policy owns the **level skeleton**: the
 * three-value level model and its storage. Per ADR-0016 the level lives in
 * `session.config.permissionLevel` (the `level/set` jsonl event and the scratch
 * slot are gone): the session override, else the `general.permissionLevel`
 * global default, else `workspace`. The effective level is resolved at boot /
 * `/resume` / `/level` and written into `session.config`, so the hot per-tool
 * read (`getPermissionLevel`) is a sync in-memory lookup. It has NO prompt text
 * and NO runtime interception middleware — the "gate" is a level-context
 * guarantee: every tool `execute` reads the current level via
 * `getPermissionLevel(ctx)` and self-determines its behavior. The permission
 * DECLARATION fragment is owned by each bundle (`packages/bundle`).
 */

/** Read the live permission level from a tool-call context (default: workspace). */
export function getPermissionLevel(ctx: { session: SessionContext }): PermissionLevel {
  const l = ctx.session.config?.permissionLevel as PermissionLevel | undefined;
  return l && (PERMISSION_LEVELS as readonly string[]).includes(l)
    ? l
    : DEFAULT_PERMISSION_LEVEL;
}

/**
 * Resolve the effective level for a session: persisted override
 * (`session.config.permissionLevel`) ?? `general.permissionLevel` global default
 * ?? `workspace`. Missing/invalid override falls through to the global default.
 * Asynchronous — reads the settings.json `general` block. Call after boot and
 * `/resume` (ADR-0007 Q3/Q11, moved to core by ADR-0009, re-homed by ADR-0016).
 */
export async function resolvePermissionLevel(store: Pick<SessionStore, 'loadConfig'>): Promise<PermissionLevel> {
  const overrides = await store.loadConfig();
  const sessionLevel = overrides.permissionLevel;
  if (sessionLevel && (PERMISSION_LEVELS as readonly string[]).includes(sessionLevel)) {
    return sessionLevel;
  }
  try {
    return (await loadSettings()).general?.permissionLevel ?? DEFAULT_PERMISSION_LEVEL;
  } catch {
    return DEFAULT_PERMISSION_LEVEL;
  }
}

/**
 * Restore the session's permission level into `session.config.permissionLevel`.
 * Resolves the effective level (per the cascade above) and writes it into the
 * in-memory session config so `getPermissionLevel` stays a sync read. The
 * resolved value is NOT persisted to the config file — only the user-set
 * override is (applyPermissionLevel), preserving override-only diff semantics.
 */
export async function restorePermissionLevel(
  store: Pick<SessionStore, 'loadConfig'>,
  session: SessionContext,
): Promise<PermissionLevel> {
  const level = await resolvePermissionLevel(store);
  session.config = { ...session.config, permissionLevel: level };
  return level;
}

/**
 * Validate and apply a permission-level change: write the level into
 * `session.config.permissionLevel` AND persist it as an override in the config
 * file (ADR-0016 — was a `level/set` event). Shared by the core `/level` slash
 * command and the web level session action. The flat prompt needs no rebuild —
 * it is re-read each turn and reflects the new level. Throws on an invalid
 * level.
 */
export async function applyPermissionLevel(
  session: SessionContext,
  store: Pick<SessionStore, 'loadConfig' | 'saveConfig'> | null,
  level: string,
): Promise<string> {
  const l = level.trim().toLowerCase() as PermissionLevel;
  if (!(PERMISSION_LEVELS as readonly string[]).includes(l)) {
    throw new Error(`level must be one of: ${PERMISSION_LEVELS.join('|')}`);
  }
  session.config = { ...session.config, permissionLevel: l };
  if (store) {
    const overrides = await store.loadConfig();
    await store.saveConfig({ ...overrides, permissionLevel: l });
  }
  return `[level] ${l} (tools self-determine per call)`;
}

// ---- project root (cwd realpath) — generic primitive for tools ------------

let cachedRoot: string | null = null;

/** The permission-context project root: `realpath(process.cwd())` (Q6). */
export function projectRoot(): string {
  if (!cachedRoot) cachedRoot = path.resolve(process.cwd());
  return cachedRoot;
}

/**
 * The tool working root for a session: the workspace path from
 * `session.config.workspace` (set by stream/web interfaces, ADR-0011) when
 * present, else the process cwd (CLI behavior unchanged).
 */
export function workspaceRoot(ctx: { session?: { config?: Record<string, any> } }): string {
  const w = ctx?.session?.config?.workspace;
  return typeof w === 'string' && w ? path.resolve(w) : projectRoot();
}

/**
 * True if `p` (after realpath resolution) is inside the project root.
 * `rootOverride` lets stream/web sessions scope checks to the selected
 * workspace instead of the process cwd.
 * Shared mechanism for tools that scope writes (bash, str_replace_editor).
 */
export async function isInsideProjectRoot(p: string, rootOverride?: string): Promise<boolean> {
  const root = rootOverride ? path.resolve(rootOverride) : projectRoot();
  const abs = path.resolve(root, p);
  let resolved = abs;
  try {
    resolved = await realpath(abs);
  } catch {
    // Target may not exist yet (mkdir/touch a new file): resolve the parent
    // directory's links, then re-attach the basename.
    try {
      resolved = path.join(await realpath(path.dirname(abs)), path.basename(abs));
    } catch {
      /* keep the raw resolved path */
    }
  }
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ---- default policy ----------------------------------------------------------

export interface SecurityPolicy {
  /**
   * Restore policy state (e.g. the permission level) from the session store.
   * Called on boot, `/resume`, and `/new` — after a SessionStore is attached.
   */
  restore(store: SessionStore, session: SessionContext): Promise<void>;
}

/** The built-in default policy (ADR-0009 Q10=a: full level skeleton). */
export const defaultSecurityPolicy: SecurityPolicy = {
  async restore(store, session) {
    await restorePermissionLevel(store, session);
  },
};
