import { bashTool, strReplaceEditorTool } from '@applepi/extension';
import type { Bundle, BundleEnv, BundleSpec } from './types.js';

/**
 * base bundle — the minimal, exactly-two-tool capability unit (ADR-0015).
 *
 * Sibling to `standard`: it does NOT inherit/contain standard, and standard
 * does not inherit it. It registers only `bash` + `str_replace_editor` and a
 * minimal working persona — NO memory, skills, plan, goal, or subagent. The
 * permission/capability declaration is NOT bundle-owned here: both bundles
 * share the assembly-time `permissionFragment` built from the resolved tool
 * set (`assemble.ts`), so the prompt can never claim unwired tools.
 */

/** Short identity + working-style persona (base's sole instruction fragment). */
export const BASE_PROMPT = 'You are a helpful software engineer assistant.';

export const baseBundle: Bundle = {
  name: 'base',
  description:
    '极简双工具模式：仅 bash 与 str_replace_editor，无记忆/技能/子代理。',

  make(_env: BundleEnv): BundleSpec {
    return {
      prompt: [BASE_PROMPT],
      // Exactly two tools — the defining property of base (ADR-0015).
      tools: [bashTool, strReplaceEditorTool],
      // No app-assembled capabilities.
      capabilities: [],
    };
  },
};