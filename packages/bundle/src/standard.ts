import { bashTool, strReplaceEditorTool } from '@applepi/extension';
import type { Bundle, BundleEnv, BundleSpec } from './types.js';

/**
 * standard bundle — the self-contained, full capability unit (ADR-0015).
 *
 * Sibling to `base`: it does NOT inherit base and base does not contain it;
 * there is no `extends`. It reuses the shared reference tool implementations
 * (bash, str_replace_editor from @applepi/extension) and declares the full
 * capability complement — memory, skills, web, plan, goal, subagent, workflow,
 * todo, ask_user — as app-assembled capabilities (bridged to the existing
 * extension factories until the flat-prompt step lowers them into declarative
 * tool specs + fragments).
 *
 * Its persona converges to the same minimal string as `base` (deepen #01).
 * The permission/capability declaration is NOT bundle-owned: `assemble.ts`
 * injects the shared `permissionFragment` built from the ACTUAL resolved tool
 * set, so standard no longer claims unwired web/todo/subagent/workflow
 * capabilities in the prompt.
 */

/** Standard mode's identity + working-style persona (shared minimal string). */
export const STANDARD_PROMPT = 'You are a helpful software engineer assistant.';

/** The canonical standard capability complement (ADR-0015 full set). */
export const STANDARD_CAPABILITIES = [
  'memory',
  'skills',
  'web',
  'plan',
  'goal',
  'subagent',
  'workflow',
  'todo',
  'ask_user',
] as const;

export const standardBundle: Bundle = {
  name: 'standard',
  description:
    '标准模式：全量能力包（工具 + 技能 + 记忆 + 规划/目标/子代理/工作流）。',

  make(_env: BundleEnv): BundleSpec {
    return {
      prompt: [STANDARD_PROMPT],
      // Reuses the shared reference tool implementations (SIBLING set — it does
      // NOT inherit base, it declares its own copy of the shared tools).
      tools: [bashTool, strReplaceEditorTool],
      capabilities: [...STANDARD_CAPABILITIES],
    };
  },
};