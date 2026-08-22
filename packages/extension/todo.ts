import { z } from 'zod';
import type { Ctx, ToolSpec } from '@applepi/core';
import { getPermissionLevel, workspaceRoot } from '@applepi/core';
import type { Capability } from './capability.js';
import { loadJson, loadJsonSync, saveJson, stateFilePath } from './state-file.js';

const FILE = 'todo.json';

export interface TodoList {
  items: { text: string; done: boolean }[];
}

/** Render the list for the prompt fragment / `list` action (1-based indexes). */
function render(list: TodoList): string {
  if (list.items.length === 0) return '(todo list is empty)';
  return list.items
    .map((it, i) => `  ${i + 1}. ${it.done ? '[x]' : '[ ]'} ${it.text}`)
    .join('\n');
}

/**
 * Todo capability (standard batch #1). A single `todo` tool with an action
 * enum (add / done / remove / list) keeps a persistent task list, stored as a
 * small JSON file under the workspace root's `.harness/` dir. The capability's
 * prompt fragment renders the CURRENT list each turn (the flat prompt is
 * re-read every turn, so no rebuild events), keeping the model's view of the
 * list as fresh as the file — across turns and across resumed sessions.
 * Permission self-determination (ADR-0009): writes are rejected at readonly;
 * the file is extension-fixed inside the workspace root, so the workspace
 * level passes by construction.
 */
export function createTodo(): Capability {
  async function load(root: string): Promise<TodoList> {
    return (await loadJson<TodoList>(stateFilePath(root, FILE))) ?? { items: [] };
  }

  const tools: ToolSpec[] = [
    {
      name: 'todo',
      description:
        'Maintain the persistent todo list (a JSON file in the workspace). Actions: add a task ("add"), mark a task done ("done"), remove a task ("remove"), or read the current list ("list"). Indexes are 1-based as numbered in the system prompt.',
      parameters: z.object({
        action: z.enum(['add', 'done', 'remove', 'list']).describe('Operation to perform'),
        text: z
          .string()
          .optional()
          .describe('Task text (required for action=add)'),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-based task index as numbered in the prompt (for done/remove)'),
      }),
      approval: (args) => (args?.action === 'list' ? 'auto' : 'ask'),
      execute: async (
        args: { action: 'add' | 'done' | 'remove' | 'list'; text?: string; index?: number },
        ctx: Ctx,
      ) => {
        if (args.action === 'list') {
          return render(await load(workspaceRoot(ctx)));
        }
        if (getPermissionLevel(ctx) === 'readonly') {
          return `BLOCKED (readonly): todo ${args.action} is a write`;
        }
        const file = stateFilePath(workspaceRoot(ctx), FILE);
        const list = await load(workspaceRoot(ctx));
        if (args.action === 'add') {
          if (!args.text?.trim()) return 'ERROR: text required for todo add';
          list.items.push({ text: args.text.trim(), done: false });
          await saveJson(file, list);
          return `added todo ${list.items.length}: ${args.text.trim()}`;
        }
        const item = list.items[args.index! - 1];
        if (!item) return `ERROR: no todo at index ${args.index}`;
        if (args.action === 'done') {
          item.done = true;
          await saveJson(file, list);
          return `marked todo ${args.index} done: ${item.text}`;
        }
        list.items.splice(args.index! - 1, 1);
        await saveJson(file, list);
        return `removed todo: ${item.text}`;
      },
    },
  ];

  return {
    id: 'todo',
    prompt: (env) => {
      const root = env.workspace ?? env.cwd;
      const list = loadJsonSync<TodoList>(stateFilePath(root, FILE)) ?? { items: [] };
      return [
        'A persistent todo list is available via the "todo" tool; the indexes below are 1-based and current:',
        render(list),
      ];
    },
    tools,
  };
}