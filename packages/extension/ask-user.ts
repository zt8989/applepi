import { z } from 'zod';
import type { ToolSpec } from '@applepi/core';
import type { Capability } from './capability.js';

/**
 * Ask-user capability (standard batch #1). A single `ask_user` tool that
 * pauses the streaming loop at an explicit question (ADR-0011 pause/resume,
 * #02 approve-with-payload): the web approval card renders a text input, and
 * the user's answer IS this tool call's result — `execute` is never called.
 * Self-determination is moot (no side effects, no file access): the tool is
 * available at every permission level; `expectsAnswer` is what the card keys
 * on, so the status line reads "等待你的回答" instead of "等待批准".
 */
export function createAskUser(): Capability {
  const tools: ToolSpec[] = [
    {
      name: 'ask_user',
      description:
        'Ask the user a question and wait for their answer. Use it when you lack crucial information only the user can provide (a decision, a preference, a fact you cannot infer) instead of guessing. The user\'s reply is returned as the tool result.',
      parameters: z.object({
        question: z.string().describe('The question to ask the user, phrased as a single clear question'),
      }),
      approval: 'ask',
      expectsAnswer: true,
      execute: () =>
        'ERROR: ask_user requires an answer from the approval card; approving without an answer is not supported',
    },
  ];

  return {
    id: 'ask_user',
    prompt: () => [
      'When you lack crucial information that only the user can provide (a decision, a preference, an unknown fact), call the "ask_user" tool with a clear question and wait for the answer — do not guess or silently assume.',
    ],
    tools,
  };
}