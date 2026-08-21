import { bashTool, strReplaceEditorTool } from '@applepi/extensions';
import type { Bundle, BundleEnv, BundleSpec } from './types.js';

/**
 * standard bundle — the self-contained, full capability unit (ADR-0015).
 *
 * Sibling to `base`: it does NOT inherit base and base does not contain it;
 * there is no `extends`. It reuses the shared reference tool implementations
 * (bash, str_replace_editor from @applepi/extensions) and declares the full
 * capability complement — memory, skills, web, plan, goal, subagent, workflow,
 * todo, ask_user — as app-assembled capabilities (bridged to the existing
 * extension factories until the flat-prompt step lowers them into declarative
 * tool specs + fragments). Its prompt is its own (persona + full-set
 * permission/capability declaration); it does not reuse base's fragments.
 */

/** Standard mode's identity + working-style persona (its own fragment). */
export const STANDARD_PROMPT =
  'You are a coding agent with the full capability set: shell, file editing, memory, skills, web, planning, goals, subagents and workflows.';

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

/** Permission/capability declaration owned by the standard bundle (ADR-0015),
 *  level-aware: renders the live permission level so the model sees its
 *  boundaries each turn (re-read the spec with the live level). */
export function standardPermissionFragment(env: BundleEnv): string {
  const root = env.workspace ?? env.cwd;
  const level = env.level ?? 'workspace';
  const lines = [
    '## Permission & Capability',
    `Project root: ${root}`,
    'Tools: bash, str_replace_editor, memory_read/memory_write, skill_load, web search, todo, subagent, workflow, ralph, ask_user.',
    'Capabilities: memory, skills, web, plan mode, goals, subagents, workflows, todo, ask_user.',
  ];
  if (level === 'readonly') {
    lines.push('Permission level: READONLY. Reads anywhere; ALL writes forbidden (bash read-only commands, editor view-only, memory_write blocked).');
  } else if (level === 'workspace') {
    lines.push(`Permission level: WORKSPACE. Reads anywhere; writes restricted to paths inside the project root above.`);
  } else {
    lines.push('Permission level: FULLACCESS. Reads/writes anywhere except the bash denylist floor.');
  }
  lines.push('Each tool self-limits by the current permission level (readonly / workspace / fullaccess).');
  return lines.join('\n');
}

export const standardBundle: Bundle = {
  name: 'standard',
  description:
    '标准模式：全量能力包（工具 + 技能 + 记忆 + 规划/目标/子代理/工作流）。',

  make(env: BundleEnv): BundleSpec {
    return {
      prompt: [STANDARD_PROMPT, standardPermissionFragment(env)],
      // Reuses the shared reference tool implementations (SIBLING set — it does
      // NOT inherit base, it declares its own copy of the shared tools).
      tools: [bashTool, strReplaceEditorTool],
      capabilities: [...STANDARD_CAPABILITIES],
    };
  },
};
