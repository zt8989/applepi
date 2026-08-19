import type { SetupFn } from '@applepi/core';
import { bashTool } from './tools/bash.js';
import { strReplaceEditorTool } from './tools/str_replace_editor.js';
import { createPermissionExtension } from './permission.js';

/**
 * baseExtension — the default capability set for an agent (ADR-0005 Q2,
 * extended by ADR-0007). One `setup(api)` call registers:
 *  - the two reference tools (`bash`, `str_replace_editor`)
 *  - the permission extension (`createPermissionExtension`): permission
 *    middleware mounted OUTERMOST (priority 1000) + tool-surface cropper +
 *    「Permission Level」 system-prompt section + `/level` slash command.
 *
 * The permission middleware embeds the denylist (`DENY`) as the absolute
 * floor at every level (ADR-0007 Q4); the security property of ADR-0005 (the
 * outermost registration convention that audits the FINAL command after inner
 * rewrites) is unchanged. Individual pieces remain exported for targeted
 * use/tests (Q7=A / Q12): `denylistMiddleware` (floor only) and
 * `permissionMiddleware` (floor + level checks).
 */
export const baseExtension: SetupFn = (api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
  createPermissionExtension()(api);
};
