import type { SetupFn } from '../types.js';

/**
 * Default dangerous-command patterns. The denylist is registered as the
 * OUTERMOST tool middleware (priority 1000) so it inspects the model-issued
 * command on entry, before any trusted inner middleware runs. It vetoes by
 * returning WITHOUT calling next() — the tool never executes.
 *
 * Threat model: this stops the *model* from issuing dangerous commands. Inner
 * middlewares are same-process trusted extensions (per the Q6 zero-isolation
 * trust boundary at the loader), so a malicious rewrite by an extension is out
 * of scope; the denylist's job is to catch model mistakes at the boundary.
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
      if (ctx.toolName === 'bash') {
        const cmd = String(ctx.toolArgs?.command ?? '');
        if (DENY.some((re) => re.test(cmd))) {
          ctx.toolResult = `BLOCKED by denylist: ${cmd}`;
          return; // veto: do not call next()
        }
      }
      await next();
    },
    { priority: 1000 },
  );
};
