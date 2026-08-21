import type { Harness } from '@applepi/core';
import { getPermissionLevel } from '@applepi/core';
import { getCapability } from '@applepi/extensions';
import type { BundleEnv, BundleSpec } from './types.js';

/**
 * App-facing assembly helpers (ADR-0015). The bundle DEFINITIONS stay pure;
 * these are the library calls an app makes to wire a chosen bundle onto a
 * harness and to assemble the flat system prompt each turn.
 */

/** Build the BundleEnv the bundle/capabilities render against for this turn. */
export function bundleEnv(harness: Harness, opts?: { cwd?: string }): BundleEnv {
  return {
    cwd: opts?.cwd ?? process.cwd(),
    workspace: harness.session.config.workspace as string | undefined,
    level: getPermissionLevel({ session: harness.session }),
  };
}

/**
 * The tool-name set a bundle ACTUALLY contributes when enabled: the spec's
 * own tools plus every present capability's tools (deduped, declared order).
 * Because it reads the same `getCapability` registry `enableBundleSpec` uses,
 * the prompt and the registered surface can never drift apart.
 */
function resolvedTools(spec: BundleSpec): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  for (const t of spec.tools) add(t.name);
  for (const id of spec.capabilities) {
    const cap = getCapability(id);
    if (cap) for (const t of cap.tools) add(t.name);
  }
  return names;
}

/**
 * The shared permission/capability declaration fragment (deepen #01). Both
 * bundles render the same shape — `## Permission & Capability`, project root,
 * the resolved tool list, and the live level line — so base/standard can
 * never claim tools that are not actually wired. Inserted by
 * `assembleFlatPrompt` after the persona, before capability fragments.
 */
export function permissionFragment(env: BundleEnv, tools: string[]): string {
  const root = env.workspace ?? env.cwd;
  const level = env.level ?? 'workspace';
  const lines = [
    '## Permission & Capability',
    `Project root: ${root}`,
    `Tools available: ${tools.join(', ')}.`,
  ];
  if (level === 'readonly') {
    lines.push(
      'Permission level: READONLY. You may READ files anywhere; ALL writes are forbidden — every tool self-limits to read-only behavior.',
    );
  } else if (level === 'workspace') {
    lines.push(
      `Permission level: WORKSPACE. You may READ files anywhere; WRITES (file edits, new files) are restricted to paths inside the project root above.`,
    );
  } else {
    lines.push(
      'Permission level: FULLACCESS. Reads and writes anywhere are allowed; absolutely dangerous commands remain blocked by the bash denylist.',
    );
  }
  return lines.join('\n');
}

/**
 * Register every tool a bundle spec (and each of its present capabilities)
 * contributes. `standard` resolves memory/skills via @applepi/extensions;
 * capability ids without a factory yet are skipped — and warned about, so a
 * declared-but-unwired id is visible instead of silently absent.
 */
export function enableBundleSpec(harness: Harness, spec: BundleSpec): void {
  for (const t of spec.tools) harness.registerTool(t);
  for (const id of spec.capabilities) {
    const cap = getCapability(id);
    if (cap) {
      for (const t of cap.tools) harness.registerTool(t);
    } else {
      console.warn(`[bundle] declared capability "${id}" has no factory — skipped`);
    }
  }
}

export interface FlatPromptLayers {
  /** App-interface fragments (web/CLI env, working dir guidance). */
  app?: string[];
  /** Plugin tail fragments (append-only, ADR-0015). */
  plugins?: string[];
}

/**
 * Assemble the flat system prompt (ADR-0015): persona + shared permission
 * fragment (built from the ACTUAL resolved tool set) → capability fragments →
 * app interface fragments → plugin tail. Pure sequential concatenation of
 * declared order; callers re-read the spec + live env each turn so
 * level/keyword state flows in without rebuild events.
 */
export function assembleFlatPrompt(
  harness: Harness,
  spec: BundleSpec,
  layers: FlatPromptLayers = {},
): string {
  const env = bundleEnv(harness);
  const fragments = [...spec.prompt, permissionFragment(env, resolvedTools(spec))];
  for (const id of spec.capabilities) {
    const cap = getCapability(id);
    if (cap) fragments.push(...cap.prompt(env, harness.session));
  }
  if (layers.app) fragments.push(...layers.app);
  if (layers.plugins) fragments.push(...layers.plugins);
  return fragments.join('\n\n');
}