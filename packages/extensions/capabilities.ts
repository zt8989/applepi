import type { Capability } from './capability.js';
import { createMemory } from './memory.js';
import { createSkills } from './skills.js';
import { createTodo } from './todo.js';

/**
 * Ready-made capability registry (ADR-0015). The app resolves a bundle's
 * `capabilities` ids here. Ids without a factory yet (plan / goal / web /
 * subagent / workflow / ask_user) are simply absent — the app skips them, so a
 * bundle may declare more than is currently implemented.
 */
export const CAPABILITIES: Record<string, Capability> = {
  memory: createMemory(),
  skills: createSkills(),
  todo: createTodo(),
};

/** Resolve a capability by id (undefined if no factory exists yet). */
export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES[id];
}
