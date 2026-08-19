import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SetupFn, HarnessApi, Ctx, Middleware } from '../core/index.js';

export interface SkillsOptions {
  /** Marker key in session.scratch holding the loaded skills map. */
  scratchKey?: string;
}

const DEFAULT_SCRATCH_KEY = '__skills';

/**
 * Skills reference extension (spec §9.2). Provides a `skill_load` tool that
 * stashes a markdown instruction blob into the session scratch bag, plus an
 * `llm` onion-stack middleware that injects every loaded skill's content into
 * the next LLM call's system prompt. This is the canonical example of an
 * extension extending the `llm` stack by rewriting `ctx.messages` (Q15).
 */
export function createSkillsExtension(options: SkillsOptions = {}): SetupFn {
  const key = options.scratchKey ?? DEFAULT_SCRATCH_KEY;

  return (api: HarnessApi) => {
    api.registerTool({
      name: 'skill_load',
      description:
        'Load a skill (a markdown instruction blob) so its guidance is injected into the next LLM call as a system instruction. Pass `content` directly, or `path` to load a markdown file. Loaded skills stay injected until the session ends.',
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
        return `loaded skill "${args.name}" (${content.length} chars) — will be injected into the next LLM call`;
      },
    });

    const injectSkills: Middleware = async (ctx: Ctx, next) => {
      const skills = ctx.session.scratch[key] as Record<string, string> | undefined;
      if (skills && Object.keys(skills).length > 0) {
        const block = Object.entries(skills)
          .map(([name, content]) => `[Skill: ${name}]\n${content}`)
          .join('\n\n');
        const msgs = ctx.messages ?? [];
        const injected = `\n\n--- Active skills ---\n${block}\n---`;
        const sysIdx = msgs.findIndex((m: any) => m.role === 'system');
        if (sysIdx >= 0) {
          appendToContent(msgs[sysIdx], injected);
        } else {
          msgs.unshift({ role: 'system', content: `Active skills:\n${injected}` });
        }
      }
      await next();
    };
    api.use('llm', injectSkills);
  };
}

/** Append text to a message whose content may be a string or a parts array. */
function appendToContent(msg: any, text: string): void {
  if (typeof msg.content === 'string') {
    msg.content += text;
  } else if (Array.isArray(msg.content)) {
    msg.content.push({ type: 'text', text });
  } else {
    msg.content = text;
  }
}

/** Default skills extension (in-session scratch key). */
export const skillsExtension = createSkillsExtension();
