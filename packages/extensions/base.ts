import type { SetupFn } from '@applepi/core';
import { bashTool } from './tools/bash.js';
import { strReplaceEditorTool } from './tools/str_replace_editor.js';
import { denylistMiddleware } from './denylist.js';

/**
 * baseExtension — the default capability set for an agent (ADR-0005, Q2).
 * One `setup(api)` call registers:
 *  - the two reference tools (`bash`, `str_replace_editor`)
 *  - the security extension (`denylistMiddleware`) mounted OUTERMOST
 *    (priority 1000), so it enters first and exits last.
 *
 * The denylist's "privileged" status is a registration convention, not a
 * runtime guarantee: any consumer that assembles its own extension set must
 * mount `denylistMiddleware` at priority 1000 to keep the same closed loop.
 * Individual pieces remain exported for targeted use/tests (Q7=A).
 */
export const baseExtension: SetupFn = (api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
  api.use('tool', denylistMiddleware, { priority: 1000 });
};
