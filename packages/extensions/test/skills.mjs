import { createSkills } from '../dist/index.js';

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

// Skills is a declarative capability (ADR-0015): { id, prompt, tools }.
const cap = createSkills();
const tools = cap.tools;
const load = tools.find((t) => t.name === 'skill_load');
ok('registers skill_load tool', !!load);

const session = { history: [], config: {}, scratch: {} };
const env = { cwd: process.cwd() };

// skill_load stores into session scratch; flat prompt re-read reflects it.
const ctx = { session, state: {}, messages: [] };
const res = await load.execute({ name: 'polite', content: 'Be friendly and concise.' }, ctx);
ok('skill_load persists to session.scratch.__skills', session.scratch['__skills']?.polite === 'Be friendly and concise.');
ok('skill_load returns confirmation', /loaded skill/.test(res));

// The capability's prompt() (called by the app each turn) surfaces the skill —
// no rebuild event, no buildSystemPrompt (ADR-0015 flat model).
const fragments = cap.prompt(env, session);
ok('prompt contains skill content', fragments.join('\n').includes('Be friendly and concise.'));
ok('prompt tagged with skill name', fragments.join('\n').includes('[Skill: polite]'));
ok('prompt reflects the loaded count', fragments.length === 1);

// No skills loaded => nothing contributed from the capability.
const emptyCap = createSkills();
const emptyFragments = emptyCap.prompt(env, { history: [], config: {}, scratch: {} });
ok('no fragments when no skill is loaded', emptyFragments.length === 0);

// Loading a second skill adds another fragment.
await load.execute({ name: 'other', content: 'Do things differently.' }, ctx);
const fragments2 = cap.prompt(env, session);
ok('second skill contributes its own fragment', fragments2.length === 2);

console.log(`\n${passed} skills checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
