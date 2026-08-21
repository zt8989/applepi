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
 * Register every tool a bundle spec (and each of its present capabilities)
 * contributes. `standard` resolves memory/skills via @applepi/extensions;
 * capability ids without a factory yet are skipped.
 */
export function enableBundleSpec(harness: Harness, spec: BundleSpec): void {
  for (const t of spec.tools) harness.registerTool(t);
  for (const id of spec.capabilities) {
    const cap = getCapability(id);
    if (cap) for (const t of cap.tools) harness.registerTool(t);
  }
}

export interface FlatPromptLayers {
  /** App-interface fragments (web/CLI env, working dir guidance). */
  app?: string[];
  /** Plugin tail fragments (append-only, ADR-0015). */
  plugins?: string[];
}

/**
 * Assemble the flat system prompt (ADR-0015): bundle fragments → capability
 * fragments → app interface fragments → plugin tail. Pure sequential
 * concatenation of declared order; callers re-read the spec + live env each
 * turn so level/keyword state flows in without rebuild events.
 */
export function assembleFlatPrompt(
  harness: Harness,
  spec: BundleSpec,
  layers: FlatPromptLayers = {},
): string {
  const env = bundleEnv(harness);
  const fragments = [...spec.prompt];
  for (const id of spec.capabilities) {
    const cap = getCapability(id);
    if (cap) fragments.push(...cap.prompt(env, harness.session));
  }
  if (layers.app) fragments.push(...layers.app);
  if (layers.plugins) fragments.push(...layers.plugins);
  return fragments.join('\n\n');
}
