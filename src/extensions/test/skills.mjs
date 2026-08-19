import { createSkillsExtension } from '../../../dist/extensions/index.js';
import { Harness } from '../../../dist/core/index.js';

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

// --- llm middleware injects the skill into the system prompt ---
const msgs = [{ role: 'user', content: 'hi' }];
const llmCtx = { session: harness.session, state: {}, messages: msgs };
await harness.bus.run('llm', llmCtx, async () => {});
ok('llm middleware prepends a system message', msgs[0].role === 'system');
const sysText = JSON.stringify(msgs[0].content);
ok('system message contains skill content', sysText.includes('Be friendly and concise.'));
ok('system message tagged with skill name', sysText.includes('[Skill: polite]'));

// --- no skills loaded => no injection ---
const harness2 = new Harness();
harness2.registerExtension(createSkillsExtension());
const msgs2 = [{ role: 'user', content: 'hi' }];
await harness2.bus.run(
  'llm',
  { session: harness2.session, state: {}, messages: msgs2 },
  async () => {},
);
ok('no injection when no skill is loaded', msgs2[0].role === 'user');

console.log(`\n${passed} skills checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
