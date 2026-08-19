import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx, HarnessApi, SessionContext } from './types.js';
import type { SessionStore } from './session.js';

/**
 * SecurityPolicy (ADR-0009) — core-built security mechanism with a default
 * implementation. Core guarantees a policy is always installed (default when
 * none is supplied); consumers may explicitly replace it, and replacement
 * means self-responsibility.
 *
 * The default policy owns the **level skeleton**: the three-value level model,
 * the `level/set` event + `lastEvent` restore, the 「Permission Level」
 * system-prompt section, and the user-only `/level` command. It has NO runtime
 * interception middleware (permissionMiddleware was removed, Q12=a) — the
 * "gate" is a level-context guarantee: every tool `execute` reads the current
 * level via `getPermissionLevel(ctx)` and self-determines its behavior.
 */

export const PERMISSION_SCRATCH_KEY = '__permissionLevel';
export const PERMISSION_LEVELS = ['readonly', 'workspace', 'fullaccess'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace';

/** Read the live permission level from a tool-call context (default: workspace). */
export function getPermissionLevel(ctx: Pick<Ctx, 'session'>): PermissionLevel {
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

// ---- project root (cwd realpath) — generic primitive for tools ------------

let cachedRoot: string | null = null;

/** The permission-context project root: `realpath(process.cwd())` (Q6). */
export function projectRoot(): string {
  if (!cachedRoot) cachedRoot = path.resolve(process.cwd());
  return cachedRoot;
}

/**
 * True if `p` (after realpath resolution) is inside the project root.
 * Shared mechanism for tools that scope writes (bash, str_replace_editor).
 */
export async function isInsideProjectRoot(p: string): Promise<boolean> {
  const root = projectRoot();
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

/** The 「Permission Level」 system-prompt section (ADR-0007 Q9, ADR-0008). */
export function buildPermissionSection(level: PermissionLevel, root: string): string {
  const lines = [`## Permission Level: ${level}`];
  if (level === 'readonly') {
    lines.push(
      'You are running at READONLY permission level.',
      '- You may READ files anywhere; ALL writes are forbidden.',
      '- Tools self-limit at this level (e.g. bash runs read-only commands only; str_replace_editor is view-only).',
    );
  } else if (level === 'workspace') {
    lines.push(
      `You are running at WORKSPACE permission level. Project root: ${root}`,
      '- You may READ files anywhere.',
      '- WRITES (file edits, new files, memory writes) are restricted to paths inside the project root above.',
      '- Unanalyzable compound commands are blocked by the bash tool.',
    );
  } else {
    lines.push(
      'You are running at FULLACCESS permission level.',
      '- Reads and writes anywhere are allowed.',
      '- Absolutely dangerous commands remain blocked (rm -rf, fork bombs, mkfs., dd if=, ...).',
    );
  }
  return lines.join('\n');
}

export interface SecurityPolicy {
  /**
   * Restore policy state (e.g. the permission level) from the session store.
   * Called on boot, `/resume`, and `/new` — after a SessionStore is attached.
   */
  restore(store: Pick<SessionStore, 'lastEvent'>, session: SessionContext): Promise<void>;
  /**
   * Install the policy's mechanisms into the harness (prompt section, slash
   * commands). Called once at construction; these registrations are CORE-owned
   * and survive extension reload.
   */
  install(api: HarnessApi): void;
}

/** The built-in default policy (ADR-0009 Q10=a: full level skeleton). */
export const defaultSecurityPolicy: SecurityPolicy = {
  async restore(store, session) {
    await restorePermissionLevel(store, session.scratch);
  },

  install(api) {
    // 「Permission Level」 section on the system_prompt stack (ADR-0008).
    api.use(
      'system_prompt',
      async (ctx, next) => {
        ctx.promptParts!.push(buildPermissionSection(getPermissionLevel(ctx), projectRoot()));
        ctx.sections!.push('permission');
        await next();
      },
      { priority: 1000 },
    );

    // `/level` — user-only; the model has no level-changing tool (Q7).
    api.registerSlashCommand('level', async (arg: string) => {
      const level = arg.trim().toLowerCase() as PermissionLevel;
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level)) {
        return `usage: /level <${PERMISSION_LEVELS.join('|')}>`;
      }
      api.ctx.scratch[PERMISSION_SCRATCH_KEY] = level;
      await api.emit('level/set', { level });
      await api.emit('system_prompt'); // rebuild + persist (core handler)
      return `[level] ${level} (system prompt rebuilt; tools self-determine per call)`;
    });
  },
};
