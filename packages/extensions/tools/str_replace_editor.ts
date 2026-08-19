import { z } from 'zod';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import type { Ctx, ToolSpec } from '@applepi/core';
import { getPermissionLevel, isInsideProjectRoot } from '@applepi/core';

/**
 * str_replace_editor — self-determining per level (ADR-0009 Q6=a; the sre path
 * rule moved here from permission.ts): readonly allows `view` only; workspace
 * allows `write`/`str_replace` only inside the project root; fullaccess allows
 * all. The model always sees the full schema (Q8=b, no cropping).
 */
export const strReplaceEditorTool: ToolSpec = {
  name: 'str_replace_editor',
  description:
    'View, create, or edit files on the local filesystem. Use for reading source, writing new files, or making precise string replacements.',
  parameters: z.object({
    command: z
      .enum(['view', 'str_replace', 'write'])
      .describe('Action to perform'),
    path: z.string().describe('Absolute or relative file path'),
    content: z.string().optional().describe('File content (required for write)'),
    old_str: z
      .string()
      .optional()
      .describe('Exact string to replace (required for str_replace)'),
    new_str: z
      .string()
      .optional()
      .describe('Replacement string (required for str_replace)'),
  }),
  async execute(args, ctx: Ctx) {
    const level = getPermissionLevel(ctx);
    const command = args.command;

    // Self-determination (ADR-0009): scope by level before touching the disk.
    if (level === 'readonly' && command !== 'view') {
      return `BLOCKED (readonly): str_replace_editor view only`;
    }
    if (
      level === 'workspace' &&
      (command === 'write' || command === 'str_replace')
    ) {
      const p = args.path;
      if (typeof p !== 'string' || !(await isInsideProjectRoot(p))) {
        return `BLOCKED (workspace): write path outside project root: ${String(p)}`;
      }
    }

    try {
      if (command === 'view') {
        const s = await stat(args.path);
        if (s.isDirectory()) {
          const entries = await readdir(args.path, { withFileTypes: true });
          return entries
            .map((e) => (e.isDirectory() ? `[dir] ${e.name}` : e.name))
            .join('\n');
        }
        return await readFile(args.path, 'utf8');
      }
      if (command === 'write') {
        if (args.content === undefined) return 'ERROR: content required for write';
        await writeFile(args.path, args.content, 'utf8');
        return `WROTE ${args.path} (${args.content.length} bytes)`;
      }
      if (command === 'str_replace') {
        if (!args.old_str || args.new_str === undefined) {
          return 'ERROR: old_str and new_str required for str_replace';
        }
        const text = await readFile(args.path, 'utf8');
        const idx = text.indexOf(args.old_str);
        if (idx === -1) return 'ERROR: old_str not found in file';
        const updated =
          text.slice(0, idx) + args.new_str + text.slice(idx + args.old_str.length);
        await writeFile(args.path, updated, 'utf8');
        return `REPLACED one occurrence in ${args.path}`;
      }
      return 'ERROR: unknown command';
    } catch (e: any) {
      return `ERROR: ${e?.message ?? e}`;
    }
  },
};
