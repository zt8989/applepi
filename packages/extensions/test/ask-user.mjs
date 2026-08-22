import { createAskUser, getCapability } from '../dist/index.js';
import { Harness, classifyApproval } from '@applepi/core';
import { z } from 'zod';

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

// Ask-user is a declarative capability (ADR-0015): { id, prompt, tools }.
const cap = createAskUser();
ok('registers as capability id=ask_user', cap.id === 'ask_user');
ok(
  'contributes a prompt fragment (ask-don\'t-guess guidance)',
  cap.prompt({ cwd: '/x' }, { history: [], config: {}, scratch: {} }).join(' ').includes('ask_user'),
);

const tool = cap.tools[0];
ok('registers single "ask_user" tool', cap.tools.length === 1 && tool.name === 'ask_user');
ok('approval is forced ask (string form)', tool.approval === 'ask');
ok('expectsAnswer flag set (approve-with-payload card)', tool.expectsAnswer === true);
const parsed = tool.parameters.safeParse({ question: 'which port?' });
ok('valid question parses', parsed.success);
ok('missing question rejected', !tool.parameters.safeParse({}).success);
ok('resolves via getCapability("ask_user")', getCapability('ask_user').tools[0].name === 'ask_user');

// Default-approve-without-answer is not a real path (the card never sends it),
// but the defensive execute must not pretend success.
const res = await tool.execute({ question: 'x' }, { session: { history: [], config: {}, scratch: {} } });
ok('execute (never called in practice) returns ERROR', /ERROR/.test(res));

// Wiring: on a real harness the stub classifies `ask` (forced), so the loop
// pauses instead of executing.
const harness = new Harness({ workspace: 'ask-user-test' });
harness.registerTool(tool);
const mode = await classifyApproval(harness, 'ask_user', { question: 'which port?' });
ok('classifyApproval(ask_user) = ask on a live harness', mode === 'ask');

console.log(`\n${passed} ask_user checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);