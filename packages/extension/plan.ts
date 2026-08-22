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

const FILE = 'plan.json';

export interface Plan {
  steps: { text: string; done: boolean }[];
}

/** Render the plan for the prompt fragment / `list` action (1-based indexes). */
function render(plan: Plan): string {
  if (plan.steps.length === 0) return '(plan has no steps yet)';
  return plan.steps
    .map((s, i) => `  ${i + 1}. ${s.done ? '[x]' : '[ ]'} ${s.text}`)
    .join('\n');
}

/**
 * Plan capability (standard batch #1). A `plan` tool with an action enum
 * (set / done / clear / list) keeps a persistent step-by-step plan as a JSON
 * file under the workspace root's `.harness/` dir. `set` replaces the whole
 * plan; `done` advances a step. The prompt fragment renders the CURRENT plan
 * each turn (flat prompt is re-read every turn), so the model sees its own
 * plan and its progress without rebuild events. No plan on disk → no fragment.
 * Same shape and level semantics as the todo capability.
 */
export function createPlan(): Capability {
  async function load(root: string): Promise<Plan | null> {
    return loadJson<Plan>(stateFilePath(root, FILE));
  }

  const tools: ToolSpec[] = [
    {
      name: 'plan',
      description:
        'Maintain a persistent step-by-step plan (a JSON file in the workspace). Actions: set a new plan ("set", steps), mark a step done ("done", index), clear the plan ("clear"), or read the current plan ("list"). Steps replace the whole plan on "set". Indexes are 1-based as numbered in the system prompt.',
      parameters: z.object({
        action: z.enum(['set', 'done', 'clear', 'list']).describe('Operation to perform'),
        steps: z
          .array(z.string())
          .optional()
          .describe('Steps of the new plan (required for action=set)'),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based step index as numbered in the prompt (for action=done)'),
      }),
      approval: (args) => (args?.action === 'list' ? 'auto' : 'ask'),
      execute: async (
        args: { action: 'set' | 'done' | 'clear' | 'list'; steps?: string[]; index?: number },
        ctx: Ctx,
      ) => {
        const file = stateFilePath(workspaceRoot(ctx), FILE);
        if (args.action === 'list') {
          const plan = await load(workspaceRoot(ctx));
          return plan ? render(plan) : '(no plan set yet)';
        }
        if (getPermissionLevel(ctx) === 'readonly') {
          return `BLOCKED (readonly): plan ${args.action} is a write`;
        }
        if (args.action === 'clear') {
          await removeFile(file);
          return 'cleared plan';
        }
        if (args.action === 'set') {
          const steps = (args.steps ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
          if (steps.length === 0) return 'ERROR: steps required for plan set';
          const plan: Plan = { steps: steps.map((text) => ({ text, done: false })) };
          await saveJson(file, plan);
          return `set plan with ${plan.steps.length} steps`;
        }
        const plan = (await load(workspaceRoot(ctx))) ?? { steps: [] };
        const step = plan.steps[args.index! - 1];
        if (!step) return `ERROR: no step at index ${args.index}`;
        step.done = true;
        await saveJson(file, plan);
        return `marked step ${args.index} done: ${step.text}`;
      },
    },
  ];

  return {
    id: 'plan',
    prompt: (env) => {
      const root = env.workspace ?? env.cwd;
      const plan = loadJsonSync<Plan>(stateFilePath(root, FILE));
      if (!plan) return [];
      return [
        'A persistent step-by-step plan is active; keep it current with the "plan" tool (set / done / clear / list). Steps below are 1-based:',
        render(plan),
      ];
    },
    tools,
  };
}