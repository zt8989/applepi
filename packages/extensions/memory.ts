import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SetupFn, HarnessApi, Ctx } from '@applepi/core';
import { getPermissionLevel } from '@applepi/core';

export interface MemoryOptions {
  /** Path to the JSON file backing memory. Defaults to ./harness-memory.json. */
  filePath?: string;
}

/**
 * Memory reference extension (Q8/A: same-process registration, no child
 * process bridge). Registers `memory_write` / `memory_read` tools that persist
 * a key/value store to a local JSON file and mirror it into the session
 * `scratch` bag so values are readable in-session without a file round-trip.
 */
export function createMemoryExtension(options: MemoryOptions = {}): SetupFn {
  const filePath =
    options.filePath ?? path.resolve(process.cwd(), 'harness-memory.json');

  async function load(): Promise<Record<string, any>> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  async function save(store: Record<string, any>): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  }

  return (api: HarnessApi) => {
    api.registerTool({
      name: 'memory_write',
      description:
        'Persist a key/value pair to durable local memory (JSON file). Survives across tool calls and sessions. Use it to remember facts the agent will need later.',
      parameters: z.object({
        key: z.string().describe('Unique key for the memory entry'),
        value: z.string().describe('Value to store'),
      }),
      approval: 'ask',
      execute: async (args: { key: string; value: string }, ctx: Ctx) => {
        // Self-determination (ADR-0009): memory_write is a write — rejected at
        // readonly. Its target file is extension-configured (trusted), so no
        // path check beyond the level gate.
        if (getPermissionLevel(ctx) === 'readonly') {
          return 'BLOCKED (readonly): memory_write is a write';
        }
        const store = await load();
        store[args.key] = args.value;
        await save(store);
        // In-session mirror: proves the extension can read/write session ctx.
        ctx.session.scratch['__memory'] = store;
        return `wrote memory["${args.key}"] = ${args.value}`;
      },
    });

    api.registerTool({
      name: 'memory_read',
      description:
        'Read a value previously stored via memory_write. Returns the stored value, or a "not found" notice if the key is absent.',
      parameters: z.object({
        key: z.string().describe('Key to look up'),
      }),
      approval: 'auto',
      execute: async (args: { key: string }, ctx: Ctx) => {
        // In-session mirror first (proves ctx read); fall back to the file as
        // the source of truth for values written in a prior session/call.
        const mirror = ctx.session.scratch['__memory'] as
          | Record<string, any>
          | undefined;
        if (mirror && args.key in mirror) {
          return `memory["${args.key}"] = ${mirror[args.key]}`;
        }
        const store = await load();
        if (args.key in store) {
          ctx.session.scratch['__memory'] = store;
          return `memory["${args.key}"] = ${store[args.key]}`;
        }
        return `memory["${args.key}"] not found`;
      },
    });
  };
}

/** Default memory extension writing to ./harness-memory.json. */
export const memoryExtension = createMemoryExtension();
