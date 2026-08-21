import { bashTool, strReplaceEditorTool } from '@applepi/extensions';
import type { Bundle, BundleEnv, BundleSpec } from './types.js';

/**
 * base bundle — the minimal, exactly-two-tool capability unit (ADR-0015).
 *
 * Sibling to `standard`: it does NOT inherit/contain standard, and standard
 * does not inherit it. It registers only `bash` + `str_replace_editor` and a
 * minimal working persona — NO memory, skills, plan, goal, or subagent. Every
 * prompt fragment is bundle-owned (incl. a permission/capability declaration
 * tailored to its two-tool surface).
 */

/** Short identity + working-style persona (base's sole instruction fragment). */
export const BASE_PROMPT = 'You are a helpful software engineer assistant.';

/**
 * Permission/capability declaration owned by the base bundle (ADR-0015), and
 * level-aware: it renders the current permission level's behavior so the model
 * sees its boundaries without hitting tool errors. Worked into the prompt by
 * the app each turn (re-read the spec with the live level).
 */
export function basePermissionFragment(env: BundleEnv): string {
  const root = env.workspace ?? env.cwd;
  const level = env.level ?? 'workspace';
  const lines = [
    '## Permission & Capability',
    `Project root: ${root}`,
    'Tools available: bash, str_replace_editor (self-limiting by permission level).',
  ];
  if (level === 'readonly') {
    lines.push(
      'Permission level: READONLY. You may READ files anywhere; ALL writes are forbidden. bash runs read-only commands only; str_replace_editor is view-only.',
    );
  } else if (level === 'workspace') {
    lines.push(
      `Permission level: WORKSPACE. You may READ files anywhere; WRITES (file edits, new files) are restricted to paths inside the project root above.`,
    );
  } else {
    lines.push(
      'Permission level: FULLACCESS. Reads and writes anywhere are allowed; absolutely dangerous commands remain blocked by the bash denylist.',
    );
  }
  lines.push('No memory, skills, plan, goal, or subagent capabilities are available in this mode.');
  return lines.join('\n');
}

export const baseBundle: Bundle = {
  name: 'base',
  description:
    '极简双工具模式：仅 bash 与 str_replace_editor，无记忆/技能/子代理。',

  make(env: BundleEnv): BundleSpec {
    return {
      prompt: [BASE_PROMPT, basePermissionFragment(env)],
      // Exactly two tools — the defining property of base (ADR-0015).
      tools: [bashTool, strReplaceEditorTool],
      // No app-assembled capabilities.
      capabilities: [],
    };
  },
};
