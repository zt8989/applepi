// End-to-end check for the skills reference extension, driven without a real
// LLM/API key. Loads the skills extension onto a real Harness and asserts that
// loaded skills are contributed to the `skills` system-prompt block
// (ADR-0010: prompt/base|permission|skills block stacks; sections = non-empty
// block names).
import { Harness } from '@applepi/core';
import { baseExtension, createSkillsExtension } from '@applepi/extensions';

const harness = new Harness();

// baseExtension (reference tools + outermost denylist) + skills extension
// (same wiring as main.ts, ADR-0005).
harness.registerExtension(baseExtension);
harness.registerExtension(createSkillsExtension());

const SKILL_CONTENT =
  'Always answer in a friendly, polite tone and start with "Hi there!".';

// Before any skill is loaded the section contributes nothing.
const empty = await harness.buildSystemPrompt();
console.log('--- system prompt (empty scratch):', JSON.stringify(empty));

// Simulate a `skill_load` writing into the session scratch bag.
harness.session.scratch.__skills = { polite: SKILL_CONTENT };

const built = await harness.buildSystemPrompt();
console.log('--- system prompt (with skill):', built.prompt.slice(0, 220));

const okInjected =
  built.prompt.includes(SKILL_CONTENT) && built.prompt.includes('[Skill: polite]');
const okEmpty = !empty.prompt.includes(SKILL_CONTENT);
const okSections =
  !empty.sections.includes('skills') && built.sections.includes('skills');

if (okInjected && okEmpty && okSections) {
  console.log('check-skills: OK');
} else {
  console.error('check-skills: FAIL');
  process.exit(1);
}
