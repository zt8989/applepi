/**
 * Bundle — ADR-0015 capability unit (decisive foundation).
 *
 * A Bundle is a self-contained, DECLARATIVE capability set. It is a pure
 * `(env) => ({ prompt, tools })` producer: no `registerExtension`/SetupFn, no
 * onion/`api` — it only states (a) the ordered flat system-prompt fragments
 * and (b) the tools it contributes. An app selects ONE bundle (base or
 * standard) when creating a session, overlays its own interface fragments and
 * plugin appends, and hands the assembled spec to core's `llm`.
 *
 * base and standard are SIBLINGS — standard does not inherit base, there is no
 * `extends`. `capabilities` names the non-declarable, app-assembled parts the
 * session should enable (memory/skills/plan/goal/subagent/...); today these
 * are wired via the @applepi/extensions capability factories, and in the
 * flat-prompt step they lower into declarative tool specs + prompt fragments.
 */

import type { CapabilityEnv } from '@applepi/extensions';

/**
 * The environment a bundle's fragments render against. Merged with the
 * extension side's `CapabilityEnv` (deepen #05): the two were field-for-field
 * duplicates; `BundleEnv` is now that single shared type, so a bundle spec's
 * fragments and the capability fragments it aggregates always render against
 * the same env shape. (Permission-declaration duplication was already removed
 * by deepen #01's shared `permissionFragment`.)
 */
export type BundleEnv = CapabilityEnv;

/** The assembled capability of one bundle for one session. */
export interface BundleSpec {
  /**
   * Ordered flat system-prompt fragments (bundle-internal order, ADR-0015).
   * The bundle self-determines its own fragment order; the app places this
   * array before its interface fragments and the plugin tail.
   */
  prompt: string[];
  /** Tool registrations contributed by this bundle. */
  tools: import('@applepi/core').ToolSpec[];
  /**
   * Capability ids this session should enable beyond the declared tools:
   * e.g. 'memory' | 'skills' | 'plan' | 'goal' | 'subagent' | 'workflow' |
   * 'todo' | 'web' | 'ask_user'. App assembles these via the matching
   * extension factory (bridge until the flat-prompt step makes them
   * declarative).
   */
  capabilities: string[];
}

/** A runnable / hostable capability unit (ADR-0015: mode = hostable bundle). */
export interface Bundle {
  /** Stable bundle name: 'base' | 'standard'. */
  name: string;
  /** One-line human description (for the session-creation picker). */
  description: string;
  /**
   * The declarative capability set for a given environment. Pure — no side
   * effects, no core/onion access.
   */
  make(env: BundleEnv): BundleSpec;
}
