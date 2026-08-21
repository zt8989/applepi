import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Capability } from './capability.js';
import type { Ctx, ToolSpec } from '@applepi/core';

export interface SkillsOptions {
  /** Marker key in session.scratch holding the loaded skills map. */
  scratchKey?: string;
}

const DEFAULT_SCRATCH_KEY = '__skills';

/**
 * Skills capability (ADR-0015). A `skill_load` tool stashes a markdown
 * instruction blob into the session scratch bag; the capability's `prompt()`
 * surfaces every loaded skill as a flat fragment. The system prompt is
 * re-read each turn, so loading a skill does NOT emit any rebuild event — the
 * next turn's assembly naturally includes it (ADR-0015 flat model).
 */
export function createSkills(options: SkillsOptions = {}): Capability {
  const key = options.scratchKey ?? DEFAULT_SCRATCH_KEY;

  const tools: ToolSpec[] = [
    {
      name: 'skill_load',
      description:
        'Load a skill (a markdown instruction blob) so its guidance is contributed to the system prompt. Pass `content` directly, or `path` to load a markdown file. Loaded skills persist in the session scratch until the session ends or `/reload`.',
      parameters: z.object({
        name: z.string().describe('Skill name / identifier'),
        content: z
          .string()
          .optional()
          .describe('Inline markdown instructions for the skill'),
        path: z
          .string()
          .optional()
          .describe('Path to a markdown file holding the skill instructions'),
      }),
      approval: 'auto',
      execute: async (
        args: { name: string; content?: string; path?: string },
        ctx: Ctx,
      ) => {
        let content = args.content;
        if (!content && args.path) {
          content = await fs.readFile(path.resolve(args.path), 'utf8');
        }
        if (!content) {
          return 'skill_load: provide `content` or `path`';
        }
        const skills = (ctx.session.scratch[key] as Record<string, string>) ?? {};
        skills[args.name] = content;
        ctx.session.scratch[key] = skills;
        return `loaded skill "${args.name}" (${content.length} chars) — its instructions are now part of the system prompt`;
      },
    },
  ];

  return {
    id: 'skills',
    prompt: (_env, session) => {
      const skills = (session.scratch[key] as Record<string, string> | undefined) ?? {};
      return Object.entries(skills).map(
        ([name, content]) => `[Skill: ${name}]\n${content}`,
      );
    },
    tools,
  };
}
