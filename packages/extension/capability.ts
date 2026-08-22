import type { PermissionLevel, SessionContext, ToolSpec } from '@applepi/core';

/**
 * Capability (ADR-0015) — an app-assembled capability unit referenced by a
 * bundle's `capabilities` list. Like a bundle, a capability is a declarative
 * producer; unlike a bundle it is scoped to ONE capability id (memory / skills
 * / ...). When the app resolves a bundle's capability ids here, it registers
 * the capability's tools and appends its flat prompt fragments.
 */
export interface CapabilityEnv {
  /** Process/project cwd. */
  cwd: string;
  /** Selected workspace path (web); defaults to `cwd`. */
  workspace?: string;
  /** Current permission level (for level-aware prompts). */
  level?: PermissionLevel;
}

export interface Capability {
  /** Stable id — matches entries in `BundleSpec.capabilities`. */
  id: string;
  /**
   * Flat prompt fragments this capability contributes THIS turn. It may read
   * session state (e.g. loaded skills): the flat prompt is re-read each turn,
   * so capabilities reflect live state without rebuild events (ADR-0015).
   */
  prompt(env: CapabilityEnv, session: SessionContext): string[];
  /** Tools contributed when this capability is enabled. */
  tools: ToolSpec[];
}
