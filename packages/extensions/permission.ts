import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  Ctx,
  HarnessApi,
  Middleware,
  SessionStore,
  SetupFn,
  ToolDef,
} from '@applepi/core';
import { DENY } from './denylist.js';

/**
 * Permission-level system (ADR-0007). Replaces the denylist-only security
 * extension with a read/write scope model:
 *
 *   readonly    — read anywhere, write nowhere
 *   workspace   — read anywhere, write only inside project root (cwd realpath)
 *   fullaccess  — read/write anywhere (denylist floor still applies)
 *
 * Two orthogonal mechanisms (Q10=c):
 *  (a) Registration-time cropping: a ToolFilter rewrites what the model sees in
 *      `buildToolDefs()` — readonly hides `memory_write` entirely and crops
 *      `str_replace_editor` to `view` only.
 *  (b) Runtime interception: `permissionMiddleware` mounts at priority 1000
 *      (outermost) and audits the FINAL args after inner rewrites, so a
 *      mis-cropped or rewritten call never surfaces a real result.
 *
 * The denylist (`DENY` from denylist.js) is the absolute floor at EVERY level.
 *
 * The current level lives in `session.scratch[PERMISSION_SCRATCH_KEY]`,
 * restored from the last `level/set` event on start/`/resume` (Q3/Q11),
 * defaulting to `workspace`. Only the USER can change it via `/level` — the
 * model has no level-changing tool (Q7, no self-privilege-escalation).
 */

export const PERMISSION_SCRATCH_KEY = '__permissionLevel';
export const PERMISSION_LEVELS = ['readonly', 'workspace', 'fullaccess'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace';

/** bash commands allowed at readonly (Q8 whitelist — conservative). */
const READONLY_BASH_COMMANDS = new Set([
  'ls', 'cat', 'grep', 'pwd', 'head', 'tail', 'wc', 'find', 'stat', 'du', 'echo',
]);

/** bash commands recognized as writes (Q6 heuristic: identify + extract target). */
const WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'tee', 'sed', 'install', 'ln',
  'chmod', 'chown', 'truncate', 'dd', 'curl', 'wget',
]);

/** Tools whose behavior is read-only in this harness regardless of level. */
const READ_TOOLS = new Set(['memory_read', 'skill_load']);

// ---- project root (cwd realpath), cached per process -----------------------

let cachedRoot: string | null = null;
function projectRootSync(): string {
  if (!cachedRoot) cachedRoot = path.resolve(process.cwd());
  return cachedRoot;
}

/** True if `p` (after realpath resolution) is inside the project root. */
async function isInsideProjectRoot(p: string): Promise<boolean> {
  const root = projectRootSync();
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

// ---- bash write-target identification (Q6 heuristic, fail-closed) ----------

/**
 * Extract the write targets of a bash command.
 * Returns:
 *  - `null` when the command cannot be reliably analyzed (compound/redirect
 *    forms we refuse to guess at) — caller must BLOCK (conservative);
 *  - `[]` when the command is not a write (read-only / unknown-but-benign);
 *  - non-empty path list when write targets were identified.
 */
function identifyWriteTargets(cmd: string): string[] | null {
  const trimmed = cmd.trim();
  // Compound commands (`|`, `;`, `&&`, `$()`, backticks) defeat path
  // extraction — fail closed (Q6 conservative).
  if (/[|;&`]|\$\(|\n/.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0] ?? '';
  const targets: string[] = [];

  // Shell redirections `> file` / `>> file` / `2> file`.
  const redirRe = /(?:^|\s)(?:2?>>?|1>>?)\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirRe.exec(trimmed)) !== null) {
    targets.push(m[1].replace(/^["']|["']$/g, ''));
  }
  if (targets.length > 0) return targets;

  if (WRITE_COMMANDS.has(first)) {
    if (first === 'dd') {
      const of = /(?:^|\s)of=(\S+)/.exec(trimmed);
      return of ? [of[1]] : null;
    }
    if (first === 'sed') {
      // `sed -i 's/x/y/' file` — target is the trailing operand.
      return tokens.includes('-i') ? tokens.slice(-1).filter((t) => !t.startsWith('-')) : [];
    }
    if (first === 'curl' || first === 'wget') {
      const oi = tokens.indexOf('-o');
      const Oi = tokens.indexOf('-O');
      if (oi !== -1 && tokens[oi + 1]) return [tokens[oi + 1]];
      if (Oi !== -1) return [tokens[Oi + 1] ?? '.'];
      return null; // cannot determine where curl/wget writes — fail closed
    }
    // Generic write commands: every non-flag, non-assignment operand is a
    // candidate target (`rm -rf foo`, `mv a b`, `touch /etc/x`, ...).
    const paths = tokens
      .slice(1)
      .filter((t) => !t.startsWith('-') && !t.includes('='));
    return paths.length > 0 ? paths : null;
  }
  return []; // not a recognized write command
}

type Verdict = { allow: true } | { allow: false; reason: string };

function blocked(reason: string): Verdict {
  return { allow: false, reason };
}

/** Bash command check: denylist floor + level rules. */
async function checkBash(cmd: string, level: PermissionLevel): Promise<Verdict> {
  for (const re of DENY) {
    if (re.test(cmd)) return blocked(`denylist: ${cmd}`);
  }
  if (level === 'fullaccess') return { allow: true };

  const first = cmd.trim().split(/\s+/)[0] ?? '';
  const targets = identifyWriteTargets(cmd);
  if (targets === null) {
    return blocked(`cannot reliably analyze command at ${level}: ${cmd}`);
  }
  if (targets.length > 0) {
    if (level === 'readonly') return blocked(`readonly: no writes allowed`);
    for (const t of targets) {
      if (!(await isInsideProjectRoot(t))) {
        return blocked(`workspace: write target outside project root: ${t}`);
      }
    }
    return { allow: true };
  }
  // Not a recognized write: allow only whitelisted read-only commands.
  if (READONLY_BASH_COMMANDS.has(first)) return { allow: true };
  return blocked(`command not allowed at ${level}: ${first}`);
}

/** str_replace_editor check by its `command` enum + path scope. */
async function checkSre(args: any, level: PermissionLevel): Promise<Verdict> {
  const command = args?.command;
  if (level === 'readonly') {
    return command === 'view' ? { allow: true } : blocked('readonly: str_replace_editor view only');
  }
  if (level === 'workspace' && (command === 'write' || command === 'str_replace')) {
    const p = args?.path;
    if (typeof p !== 'string' || !(await isInsideProjectRoot(p))) {
      return blocked(`workspace: write path outside project root: ${String(p)}`);
    }
  }
  return { allow: true };
}

/** Tool-level check for the permission middleware (Q8/Q15). */
async function checkTool(ctx: Ctx, level: PermissionLevel): Promise<Verdict> {
  const tool = ctx.toolName ?? '';
  if (tool === 'bash') {
    return checkBash(String(ctx.toolArgs?.command ?? ''), level);
  }
  if (tool === 'str_replace_editor') {
    return checkSre(ctx.toolArgs, level);
  }
  if (tool === 'memory_write') {
    // Fixed target `harness-memory.json` lives in project root by default.
    if (level === 'readonly') return blocked('readonly: memory_write is a write');
    return { allow: true };
  }
  if (READ_TOOLS.has(tool)) return { allow: true };
  return { allow: true }; // unknown tool: same-process trusted extension (P5)
}

function currentLevel(ctx: Ctx): PermissionLevel {
  const l = ctx.session.scratch[PERMISSION_SCRATCH_KEY] as PermissionLevel | undefined;
  return l && (PERMISSION_LEVELS as readonly string[]).includes(l)
    ? l
    : DEFAULT_PERMISSION_LEVEL;
}

function blockMsg(v: Verdict, level: PermissionLevel): string {
  return v.allow ? '' : `BLOCKED (${level}): ${v.reason}`;
}

/**
 * The permission middleware — mounts outermost (priority 1000). ENTRY vetoes a
 * call that violates the current level (or the denylist floor); EXIT re-audits
 * the FINAL args after inner rewrites and overwrites `ctx.toolResult` with a
 * BLOCKED message if they now violate policy (no real result leaks).
 */
export const permissionMiddleware: Middleware = async (ctx, next) => {
  const level = currentLevel(ctx);
  const entry = await checkTool(ctx, level);
  if (!entry.allow) {
    ctx.toolResult = blockMsg(entry, level);
    return; // veto
  }
  await next();
  const exit = await checkTool(ctx, level);
  if (!exit.allow) {
    ctx.toolResult = blockMsg(exit, level);
  }
};

// ---- ToolFilter: crop what the model sees (Q14=b) ---------------------------

function cropTool(toolName: string, def: ToolDef, level: PermissionLevel): ToolDef | null {
  if (level === 'fullaccess') return def;
  if (level === 'readonly') {
    if (toolName === 'memory_write') return null; // hidden entirely
    if (toolName === 'str_replace_editor') {
      return {
        ...def,
        parameters: z.object({
          command: z.literal('view').describe('Action to perform (readonly: view only)'),
          path: z.string().describe('Absolute or relative file path'),
        }),
      };
    }
    if (toolName === 'bash') {
      return {
        ...def,
        description:
          `Run a read-only shell command (allowed: ${[...READONLY_BASH_COMMANDS].join(', ')}). ` +
          'Writes, pipes and compound commands are blocked.',
      };
    }
    return def;
  }
  // workspace: keep tools, annotate the path scope.
  if (toolName === 'bash') {
    return {
      ...def,
      description:
        `Run a shell command. Writes are restricted to the project root: ${projectRootSync()}. ` +
        'Unanalyzable compound commands are blocked.',
    };
  }
  if (toolName === 'str_replace_editor') {
    return {
      ...def,
      description:
        `View, create, or edit files. Writes (write/str_replace) are restricted to the project root: ${projectRootSync()}.`,
    };
  }
  return def;
}

// ---- system-prompt section (Q9, ADR-0008) ----------------------------------

function buildPermissionSection(level: PermissionLevel, root: string): string {
  const lines = [`## Permission Level: ${level}`];
  if (level === 'readonly') {
    lines.push(
      'You are running at READONLY permission level.',
      '- You may READ files anywhere and run only these read-only commands: ' +
        [...READONLY_BASH_COMMANDS].join(', ') + '.',
      '- str_replace_editor is view-only; memory_write is unavailable; ALL writes are forbidden.',
    );
  } else if (level === 'workspace') {
    lines.push(
      `You are running at WORKSPACE permission level. Project root: ${root}`,
      '- You may READ files anywhere.',
      '- WRITES (file edits, new files, memory writes) are restricted to paths inside the project root above.',
      '- Unanalyzable compound commands are blocked.',
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

// ---- restore from jsonl (Q3/Q11) -------------------------------------------

/**
 * Restore the session's permission level from the LAST `level/set` event in the
 * session jsonl, falling back to `workspace`. Call after boot and `/resume`.
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

// ---- extension -----------------------------------------------------------------

/**
 * The permission extension (ADR-0007, section moved to the `system_prompt`
 * stack by ADR-0008). One `setup(api)` call:
 *  - mounts `permissionMiddleware` at priority 1000 (outermost),
 *  - registers the ToolFilter that crops the model-facing tool surface,
 *  - contributes the 「Permission Level」 system-prompt section via the
 *    `system_prompt` stack (entry: push section + label),
 *  - registers the `/level` slash command (user-only; no model-facing tool).
 */
export function createPermissionExtension(): SetupFn {
  return (api: HarnessApi) => {
    api.use('tool', permissionMiddleware, { priority: 1000 });

    // Crop the model-facing tool surface by the LIVE level from api.ctx
    // (the same SessionContext the middleware reads, so /level switches take
    // effect on the next buildToolDefs()).
    api.registerToolFilter((toolName: string, def: ToolDef) => {
      const level =
        (api.ctx.scratch[PERMISSION_SCRATCH_KEY] as PermissionLevel | undefined) ??
        DEFAULT_PERMISSION_LEVEL;
      return cropTool(toolName, def, level);
    });

    // 「Permission Level」 section: pushed on the system_prompt stack.
    // Reads the LIVE level from ctx.session at build time (Q9 + ADR-0008).
    api.use('system_prompt', async (ctx, next) => {
      const level =
        (ctx.session.scratch[PERMISSION_SCRATCH_KEY] as PermissionLevel | undefined) ??
        DEFAULT_PERMISSION_LEVEL;
      ctx.promptParts!.push(buildPermissionSection(level, projectRootSync()));
      ctx.sections!.push('permission');
      await next();
    });

    api.registerSlashCommand('level', async (arg: string) => {
      const level = arg.trim().toLowerCase() as PermissionLevel;
      if (!(PERMISSION_LEVELS as readonly string[]).includes(level)) {
        return `usage: /level <${PERMISSION_LEVELS.join('|')}>`;
      }
      api.ctx.scratch[PERMISSION_SCRATCH_KEY] = level;
      await api.emit('level/set', { level });
      await api.emit('system_prompt'); // rebuild + persist (core handler)
      return `[level] ${level} (system prompt rebuilt; tool surface re-cropped)`;
    });
  };
}
