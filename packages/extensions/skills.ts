import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SetupFn, HarnessApi, Ctx } from '@applepi/core';

export interface SkillsOptions {
  /** Marker key in session.scratch holding the loaded skills map. */
  scratchKey?: string;
}

const DEFAULT_SCRATCH_KEY = '__skills';

/**
 * Skills reference extension (spec §9.2). Provides a `skill_load` tool that
 * stashes a markdown instruction blob into the session scratch bag, plus a
 * system-prompt section on the `system_prompt` stack (ADR-0008) that surfaces
 * every loaded skill's content as a section of the system prompt (Q10=c —
 * extensions contribute, not rewrite; mechanism replaced by ADR-0008).
 * The system prompt is (re)built at session start and on `/reload`.
 */
export function createSkillsExtension(options: SkillsOptions = {}): SetupFn {
  const key = options.scratchKey ?? DEFAULT_SCRATCH_KEY;

  return (api: HarnessApi) => {
    api.registerTool({
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
        return `loaded skill "${args.name}" (${content.length} chars) — will be contributed to the system prompt on next build`;
      },
    });

    // Section: every loaded skill becomes a system-prompt section (ADR-0008).
    api.use('system_prompt', async (ctx, next) => {
      const skills = ctx.session.scratch[key] as Record<string, string> | undefined;
      if (skills && Object.keys(skills).length > 0) {
        ctx.promptParts!.push(
          Object.entries(skills)
            .map(([name, content]) => `[Skill: ${name}]\n${content}`)
            .join('\n\n'),
        );
        ctx.sections!.push('skills');
      }
      await next();
    });
  };
}

/** Default skills extension (in-session scratch key). */
export const skillsExtension = createSkillsExtension();
