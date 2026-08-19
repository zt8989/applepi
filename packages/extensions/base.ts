import type { SetupFn } from '@applepi/core';
import { bashTool } from './tools/bash.js';
import { strReplaceEditorTool } from './tools/str_replace_editor.js';

/**
 * Base system-prompt block contributed by baseExtension (ADR-0010).
 * Identity + working style only — tool information lives in the Vercel tool
 * defs, not the prompt (Q13/Q17=b: no tool listing in the system prompt).
 */
export const BASE_SYSTEM_PROMPT = [
  'You are a minimal local agent harness.',
  'Use the tools available to you to accomplish the user\'s request step by step.',
].join('\n');

/**
 * baseExtension — the default capability set for an agent (ADR-0005 Q2,
 * slimmed by ADR-0009). One `setup(api)` call registers the reference tools
 * and the base system-prompt block (on the `prompt/base` stack, ADR-0010).
 * It ships NO security wiring: since ADR-0009 the permission system is a core
 * mechanism (`SecurityPolicy` with a default implementation), not an
 * extension; each reference tool self-determines its behavior from the
 * permission level in context.
 */
export const baseExtension: SetupFn = (api) => {
  api.registerTool(bashTool);
  api.registerTool(strReplaceEditorTool);
  api.use(
    'prompt/base',
    async (ctx, next) => {
      ctx.prompt!.set('base', [BASE_SYSTEM_PROMPT]);
      await next();
    },
    { priority: 1000 },
  );
};
