import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SessionContext } from './types.js';
import type { SessionStore } from './session.js';

/**
 * Security (ADR-0009, re-scoped by ADR-0015) — the permission-enforcement seam
 * of the split core. The default policy owns the **level skeleton**: the
 * three-value level model, the `level/set` event + `lastEvent` restore, and
 * the user-only `/level` command (registered by the Harness shell). It has NO
 * prompt text and NO runtime interception middleware — the "gate" is a
 * level-context guarantee: every tool `execute` reads the current level via
 * `getPermissionLevel(ctx)` and self-determines its behavior. The permission
 * DECLARATION fragment is owned by each bundle (`packages/bundle`).
 */

export const PERMISSION_SCRATCH_KEY = '__permissionLevel';
export const PERMISSION_LEVELS = ['readonly', 'workspace', 'fullaccess'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace';

/** Read the live permission level from a tool-call context (default: workspace). */
export function getPermissionLevel(ctx: { session: SessionContext }): PermissionLevel {
  const l = ctx.session.scratch[PERMISSION_SCRATCH_KEY] as PermissionLevel | undefined;
  return l && (PERMISSION_LEVELS as readonly string[]).includes(l)
    ? l
    : DEFAULT_PERMISSION_LEVEL;
}

/**
 * Restore the session's permission level from the LAST `level/set` event in
 * the session jsonl, falling back to `workspace`. Call after boot and
 * `/resume` (ADR-0007 Q3/Q11, moved to core by ADR-0009).
 */
export async function restorePermissionLevel(
  store: Pick<SessionStore, 'lastEvent'>,
  scratch: Record<string, any>,
): Promise<PermissionLevel> {
  const ev = await store.lastEvent('level/set');
  const level = (ev?.payload?.level as PermissionLevel | undefined) ?? DEFAULT_PERMISSION_LEVEL;
  scratch[PERMISSION_SCRATCH_KEY] = level;
  return level;
}

/**
 * Validate and apply a permission-level change: write the level into the
 * session scratch and record a `level/set` lifecycle event (ADR-0009). Shared
 * by the core `/level` slash command and the web level session action. The
 * flat prompt needs no rebuild — it is re-read each turn and reflects the new
 * level (ADR-0015: `level/set` is an ordinary state record, not a
 * prompt-rebuild trigger). Throws on an invalid level.
 */
export async function applyPermissionLevel(
  session: SessionContext,
  store: Pick<SessionStore, 'appendEvent'> | null,
  level: string,
): Promise<string> {
  const l = level.trim().toLowerCase() as PermissionLevel;
  if (!(PERMISSION_LEVELS as readonly string[]).includes(l)) {
    throw new Error(`level must be one of: ${PERMISSION_LEVELS.join('|')}`);
  }
  session.scratch[PERMISSION_SCRATCH_KEY] = l;
  await store?.appendEvent('level/set', { level: l });
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
  restore(store: Pick<SessionStore, 'lastEvent'>, session: SessionContext): Promise<void>;
}

/** The built-in default policy (ADR-0009 Q10=a: full level skeleton). */
export const defaultSecurityPolicy: SecurityPolicy = {
  async restore(store, session) {
    await restorePermissionLevel(store, session.scratch);
  },
};
