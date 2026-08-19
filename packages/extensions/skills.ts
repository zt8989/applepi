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
 * `skills` system-prompt block on the `prompt/skills` stack (ADR-0010) that
 * surfaces every loaded skill's content. The system prompt is (re)built at
 * session start and on `/reload`; loading a skill emits
 * `system_prompt/skills` so the harness rebuilds all blocks.
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
        // Block event = semantic trigger; rebuilds ALL blocks (rebuild-all,
        // ADR-0010 Q9=a/Q12=a). Persisting happens in the core handler.
        await api.emit('system_prompt/skills', { name: args.name });
        return `loaded skill "${args.name}" (${content.length} chars) — system prompt rebuilt`;
      },
    });

    // Block: every loaded skill becomes the `skills` block (ADR-0010).
    // Contributes only when there is content; `sections` then includes
    // 'skills' (build-time truth).
    api.use('prompt/skills', async (ctx, next) => {
      const skills = ctx.session.scratch[key] as Record<string, string> | undefined;
      if (skills && Object.keys(skills).length > 0) {
        ctx.prompt!.set('skills', [
          Object.entries(skills)
            .map(([name, content]) => `[Skill: ${name}]\n${content}`)
            .join('\n\n'),
        ]);
      }
      await next();
    });
  };
}

/** Default skills extension (in-session scratch key). */
export const skillsExtension = createSkillsExtension();
