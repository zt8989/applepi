import { baseBundle } from './base.js';
import { standardBundle } from './standard.js';
import type { Bundle, BundleEnv, BundleSpec } from './types.js';

export { baseBundle, BASE_PROMPT, basePermissionFragment } from './base.js';
export {
  standardBundle,
  STANDARD_PROMPT,
  STANDARD_CAPABILITIES,
  standardPermissionFragment,
} from './standard.js';
export type { Bundle, BundleEnv, BundleSpec } from './types.js';
export { bundleEnv, enableBundleSpec, assembleFlatPrompt } from './assemble.js';
export type { FlatPromptLayers } from './assemble.js';

/**
 * The registry of runnable/hostable bundles (ADR-0015 modes). base and
 * standard are SIBLINGS — no inheritance, no `extends`; an app picks ONE per
 * session.
 */
export const BUNDLES: Record<string, Bundle> = {
  base: baseBundle,
  standard: standardBundle,
};

/** Resolve a bundle by its mode name ('base' | 'standard'); undefined if unknown. */
export function getBundle(name: string): Bundle | undefined {
  return BUNDLES[name];
}

/** Assemble a bundle's declarative spec for an environment (pure). */
export function makeBundleSpec(name: string, env: BundleEnv = makeDefaultEnv()): BundleSpec | undefined {
  return getBundle(name)?.make(env);
}

/** Default env: process cwd; `workspace` omitted (falls back to cwd). */
export function makeDefaultEnv(): BundleEnv {
  return { cwd: process.cwd() };
}
