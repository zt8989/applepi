import { z } from 'zod';
import type { Ctx, ToolSpec } from '@applepi/core';
import { getPermissionLevel, workspaceRoot } from '@applepi/core';
import type { Capability } from './capability.js';
import {
  loadJson,
  loadJsonSync,
  removeFile,
  saveJson,
  stateFilePath,
} from './state-file.js';

const FILE = 'goal.json';

export interface Goal {
  text: string;
}

/**
 * Goal capability (standard batch #1). A `goal` tool with two actions —
 * set / clear — keeps a session goal as a JSON file under the workspace
 * root's `.harness/` dir. The prompt fragment surfaces the current goal every
 * turn ("Current goal: …"), keeping long conversations on track; clearing the
 * goal removes the fragment entirely. Same state-file shape and level
 * semantics as the todo capability; both actions are writes (readonly blocks).
 */
export function createGoal(): Capability {
  const tools: ToolSpec[] = [
    {
      name: 'goal',
      description:
        'Set or clear the session goal (a JSON file in the workspace). The current goal is shown in the system prompt every turn until cleared. Actions: set a new goal ("set", text), or clear it ("clear").',
      parameters: z.object({
        action: z.enum(['set', 'clear']).describe('Operation to perform'),
        text: z
          .string()
          .optional()
          .describe('The goal text (required for action=set)'),
      }),
      approval: 'ask',
      execute: async (
        args: { action: 'set' | 'clear'; text?: string },
        ctx: Ctx,
      ) => {
        if (getPermissionLevel(ctx) === 'readonly') {
          return `BLOCKED (readonly): goal ${args.action} is a write`;
        }
        const file = stateFilePath(workspaceRoot(ctx), FILE);
        if (args.action === 'clear') {
          await removeFile(file);
          return 'cleared session goal';
        }
        if (!args.text?.trim()) return 'ERROR: text required for goal set';
        const goal: Goal = { text: args.text.trim() };
        await saveJson(file, goal);
        return `set session goal: ${goal.text}`;
      },
    },
  ];

  return {
    id: 'goal',
    prompt: (env) => {
      const root = env.workspace ?? env.cwd;
      const goal = loadJsonSync<Goal>(stateFilePath(root, FILE));
      if (!goal) return [];
      return [`Current goal: ${goal.text}`];
    },
    tools,
  };
}