import { createSkillsExtension } from '../dist/index.js';
import { Harness } from '@applepi/core';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`);
  }
}

// --- Extension wiring ---
const harness = new Harness();
harness.registerExtension(createSkillsExtension());

const tools = harness.api.getTools();
const load = tools.find((t) => t.name === 'skill_load');
ok('registers skill_load tool', !!load);

// --- skill_load stores into session scratch ---
const ctx = { session: harness.session, state: {}, messages: [] };
const res = await load.execute(
  { name: 'polite', content: 'Be friendly and concise.' },
  ctx,
);
ok(
  'skill_load persists to session.scratch.__skills',
  harness.session.scratch['__skills']?.polite === 'Be friendly and concise.',
);
ok('skill_load returns confirmation', /loaded skill/.test(res));

// --- system-prompt section renders loaded skills (Q10=c, ADR-0008) ---
const built = await harness.buildSystemPrompt();
ok('system prompt contains skill content', built.prompt.includes('Be friendly and concise.'));
ok('system prompt tagged with skill name', built.prompt.includes('[Skill: polite]'));
ok(
  'section label is "skills" in build-time sections',
  built.sections.includes('skills'),
);

// --- no skills loaded => nothing contributed from the skills section ---
// (the prompt is NOT empty since ADR-0009: the core SecurityPolicy always
// contributes the 「Permission Level」 section)
const harness2 = new Harness();
harness2.registerExtension(createSkillsExtension());
const empty = await harness2.buildSystemPrompt();
ok('no injection when no skill is loaded', !empty.prompt.includes('Be friendly and concise.') && !empty.prompt.includes('[Skill:'));
ok('no skills section when nothing is contributed', !empty.sections.includes('skills'));

console.log(`\n${passed} skills checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
