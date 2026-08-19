import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec } from '@applepi/core';

const execAsync = promisify(exec);

export const bashTool: ToolSpec = {
  name: 'bash',
  description:
    'Run a shell command on the local machine and return its combined stdout/stderr. Use for filesystem operations, running scripts, and inspecting the environment.',
  parameters: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout: z
      .number()
      .optional()
      .describe('Maximum runtime in milliseconds (default 30000)'),
  }),
  async execute(args) {
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        timeout: args.timeout ?? 30000,
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = [stdout, stderr].filter(Boolean).join('\n');
      return out || '(no output)';
    } catch (e: any) {
      return `ERROR: ${e?.message ?? e}`;
    }
  },
};
