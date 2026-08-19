import type { SetupFn } from '@applepi/core';
import { bashTool } from './tools/bash.js';
import { strReplaceEditorTool } from './tools/str_replace_editor.js';

/** Base system-prompt section contributed by baseExtension (ADR-0008 Q3=a). */
export const BASE_SYSTEM_PROMPT = [
  'You are a minimal local agent harness.',
  'You have two reference tools: `bash` and `str_replace_editor`.',
  'Use them to accomplish the user\'s request step by step.',
].join('\n');

/**
 * baseExtension — the default capability set for an agent (ADR-0005 Q2,
 * slimmed by ADR-0009). One `setup(api)` call registers the reference tools
 * and the base system-prompt section. It ships NO security wiring: since
 * ADR-0009 the permission system is a core mechanism (`SecurityPolicy` with a
 * default implementation), not an extension; each reference tool
 * self-determines its behavior from the permission level in context.
 */
export const baseExtension: SetupFn = (api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
  api.use(
    'system_prompt',
    async (ctx, next) => {
      ctx.promptParts!.push(BASE_SYSTEM_PROMPT);
      ctx.sections!.push('base');
      await next();
    },
    { priority: 1000 },
  );
};
