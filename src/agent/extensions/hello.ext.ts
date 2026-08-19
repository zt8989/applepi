import type { SetupFn } from '../../core/index.js';
import { z } from 'zod';

/**
 * Sample extension — drop this file into <app>/extensions/ and it is
 * auto-discovered by the loader (Q12/Q14: local `extensions/` directory scan)
 * with NO change to harness or loader code.
 *
 * Pull-mode contract (Q9): the loader calls `setup(api)`; we register a tool
 * via `api.registerTool(...)`. The harness does the rest.
 */
const setup: SetupFn = (api) => {
  api.registerTool({
    name: 'hello',
    description:
      'Return a friendly greeting. Use to confirm that an auto-discovered extension is wired in.',
    parameters: z.object({
      name: z.string().optional().describe('Who to greet (defaults to "world")'),
    }),
    execute: async (args) => {
      const who = String(args.name ?? 'world').trim() || 'world';
      return `Hello, ${who}! (served by an auto-discovered extension)`;
    },
  });
};

export default setup;
