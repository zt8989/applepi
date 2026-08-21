// End-to-end check for the skills capability (ADR-0015), driven without a real
// LLM/API key. Enables the `standard` bundle (which resolves the `skills`
// capability), loads a skill through the tool seam, and asserts the flat
// system prompt (re-assembled per turn) surfaces the loaded skill — no rebuild
// events, no block stacks.
import { Harness } from '@applepi/core';
import {
  makeBundleSpec,
  bundleEnv,
  enableBundleSpec,
  assembleFlatPrompt,
} from '@applepi/bundle';

const harness = new Harness();
const spec = makeBundleSpec('standard', { cwd: process.cwd() })!;
enableBundleSpec(harness, spec);

const SKILL_CONTENT =
  'Always answer in a friendly, polite tone and start with "Hi there!".';

// Re-assemble the flat prompt for this turn (what main.ts does each turn).
function prompt(): string {
  return assembleFlatPrompt(harness, makeBundleSpec('standard', bundleEnv(harness))!, { app: [] });
}

// Before any skill is loaded the capability contributes nothing.
const empty = prompt();
console.log('--- system prompt head (empty scratch):', JSON.stringify(empty.slice(0, 120)));

// skill_load through the tool seam (as runLoop does).
const ctx: any = {
  session: harness.session,
  state: {},
  toolName: 'skill_load',
  toolArgs: { name: 'polite', content: SKILL_CONTENT },
};
await harness.executeTool(ctx);

const built = prompt();
console.log('--- system prompt (with skill) contains skill:', built.includes('[Skill: polite]'));

const okInjected =
  built.includes(SKILL_CONTENT) && built.includes('[Skill: polite]');
const okEmpty = !empty.includes(SKILL_CONTENT);

if (okInjected && okEmpty) {
  console.log('check-skills: OK');
} else {
  console.error('check-skills: FAIL');
  process.exit(1);
}
