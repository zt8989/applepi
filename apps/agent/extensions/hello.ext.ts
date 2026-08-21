import { z } from 'zod';
import type { ToolSpec } from '@applepi/core';
import type { PluginSpec } from '../plugins.js';

/**
 * Sample plugin — drop a file into <app>/extensions/ and the app-layer loader
 * (apps/agent/plugins.ts, ADR-0015) discovers it with NO change to core or
 * loader code. A plugin is append-only: it registers tools and appends prompt
 * fragments at the tail of the flat system prompt. The default export is a
 * plain declarative `{ prompt?, tools? }` object.
 */

const tools: ToolSpec[] = [
  {
    name: 'hello',
    description:
      'Return a friendly greeting. Use to confirm that a discovered plugin is wired in.',
    parameters: z.object({
      name: z.string().optional().describe('Who to greet (defaults to "world")'),
    }),
    execute: async (args) => {
      const who = String(args.name ?? 'world').trim() || 'world';
      return `Hello, ${who}! (served by a discovered plugin)`;
    },
  },
];

const plugin: PluginSpec = {
  tools,
  prompt: [
    'A greeting plugin is loaded: you may use the `hello` tool to greet the user.',
  ],
};

export default plugin;
