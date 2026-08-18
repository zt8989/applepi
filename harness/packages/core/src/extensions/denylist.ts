import type { SetupFn } from '../types.js';

/**
 * Default dangerous-command patterns. The denylist is registered as the
 * OUTERMOST tool middleware (priority 1000) so it enters first and exits last.
 *
 * Two-stage check (Q16 / spec §7):
 *  - ENTRY: the model-issued command is inspected before any execution. If it
 *    matches, we veto (return without calling next) so the command NEVER runs.
 *  - EXIT:  after inner middlewares have run — including any with (iii) rewrite
 *    permission that mutated `ctx.toolArgs.command` — we re-inspect the FINAL
 *    command. If it is now dangerous, we overwrite `ctx.toolResult` with
 *    BLOCKED, so the model can never obtain a real execution result for a
 *    command it was not allowed to run. This is what keeps (b) effective even
 *    under (iii) rewrite: the inner middleware may rewrite, but it cannot
 *    surface a result past the outermost gate.
 *
 * Threat model: the denylist stops the *model* from issuing dangerous commands.
 * Inner middlewares are same-process trusted extensions (Q6 zero-isolation
 * trust boundary at the loader); a deliberately malicious extension is out of
 * scope. The exit check is defense-in-depth so that even a trusted rewrite to a
 * dangerous command yields BLOCKED to the model rather than a real result.
 */
const DENY: RegExp[] = [
  /rm\s+-rf\b/,
  /rm\s+-r\s+\//,
  /sudo\s+rm\b/,
  /:\(\)\s*{\s*:/, // fork bomb
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+-R\s+0\d{3}\s+\//,
];

export const denylistExtension: SetupFn = (api) => {
  api.use(
    'tool',
    async (ctx, next) => {
      const isBash = ctx.toolName === 'bash';
      const cmd = () => String(ctx.toolArgs?.command ?? '');

      // ENTRY: block the model-issued command before any execution.
      if (isBash && DENY.some((re) => re.test(cmd()))) {
        ctx.toolResult = `BLOCKED by denylist: ${cmd()}`;
        return; // veto: do not call next()
      }

      await next();

      // EXIT: audit the FINAL command after inner (iii) rewrites. If a trusted
      // inner middleware rewrote a safe command into a dangerous one, the model
      // still receives BLOCKED — never the real execution result.
      if (isBash && DENY.some((re) => re.test(cmd()))) {
        ctx.toolResult = `BLOCKED by denylist: ${cmd()}`;
      }
    },
    { priority: 1000 },
  );
};
