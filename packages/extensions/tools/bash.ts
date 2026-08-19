import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ctx, ToolSpec } from '@applepi/core';
import { getPermissionLevel, isInsideProjectRoot, type PermissionLevel } from '@applepi/core';

const execAsync = promisify(exec);

/**
 * Default dangerous-command patterns — the ABSOLUTE floor at EVERY level
 * (ADR-0007 Q4; moved into the bash tool by ADR-0009 Q9=a: core holds no
 * tool-specific rules). Checked inside `execute` before anything runs.
 */
export const DENY: RegExp[] = [
  /rm\s+-rf\b/,
  /rm\s+-r\s+\//,
  /sudo\s+rm\b/,
  /:\(\)\s*{\s*:/, // fork bomb
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+0\d{3}\s+\//,
];

/** bash commands allowed at readonly (ADR-0007 Q8 whitelist — conservative). */
const READONLY_BASH_COMMANDS = new Set([
  'ls', 'cat', 'grep', 'pwd', 'head', 'tail', 'wc', 'find', 'stat', 'du', 'echo',
]);

/** bash commands recognized as writes (Q6 heuristic: identify + extract target). */
const WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'tee', 'sed', 'install', 'ln',
  'chmod', 'chown', 'truncate', 'dd', 'curl', 'wget',
]);

/**
 * Extract the write targets of a bash command (Q6 heuristic, fail-closed,
 * moved from permission.ts by ADR-0009):
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

/** Self-determine whether `cmd` may run at `level` (ADR-0009 Q4/Q5). */
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

export const bashTool: ToolSpec = {
  name: 'bash',
  description:
    'Run a shell command on the local machine and return its combined stdout/stderr. Use for filesystem operations, running scripts, and inspecting the environment.',
  parameters: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z
      .number()
      .optional()
      .describe('Maximum runtime in milliseconds (default 30000)'),
  }),
  async execute(args, ctx: Ctx) {
    const cmd = String(args.command ?? '');
    const level = getPermissionLevel(ctx);
    // Self-determination (ADR-0009): the denylist floor fires at EVERY level;
    // scope rules apply below fullaccess. A BLOCKED verdict never executes.
    const verdict = await checkBash(cmd, level);
    if (!verdict.allow) return `BLOCKED (${level}): ${verdict.reason}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: args.timeout ?? 30000,
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = [stdout, stderr].filter(Boolean).join('\n');
      return out || '(no output)';
    } catch (e: any) {
      return `ERROR: ${e?.message ?? e}`;
    }
  },
};
