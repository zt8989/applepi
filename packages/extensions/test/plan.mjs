import { createPlan, getCapability } from '../dist/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

const root = path.join(os.tmpdir(), `plan-test-${Date.now()}`);
await fs.rm(root, { force: true, recursive: true });

const cap = createPlan();
ok('registers as capability id=plan', cap.id === 'plan');

const tool = cap.tools[0];
ok('registers single "plan" tool', cap.tools.length === 1 && tool.name === 'plan');
ok('resolves via getCapability("plan")', getCapability('plan').tools[0].name === 'plan');

const env = { cwd: '/irrelevant', workspace: root };
const session = (permissionLevel) => ({
  session: { history: [], config: { workspace: root, permissionLevel }, scratch: {} },
});

// No plan on disk → no prompt fragment (absent, not a lie).
ok('no fragment when no plan exists', cap.prompt(env, { config: {} }).length === 0);

// set replaces the whole plan; prompt reflects it next turn.
const ctx = session('workspace');
let res = await tool.execute({ action: 'set', steps: ['explore', 'design', 'ship'] }, ctx);
ok('set returns confirmation', /set plan with 3 steps/.test(res));
let promptText = cap.prompt(env, ctx.session).join('\n');
ok('prompt lists the plan steps 1-based', /1\. \[ \] explore/.test(promptText) && /3\. \[ \] ship/.test(promptText));
const file = path.join(root, '.harness', 'plan.json');
const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
ok('persisted to .harness/plan.json under workspace root', onDisk.steps.length === 3);

// done advances a step; prompt shows [x].
res = await tool.execute({ action: 'done', index: 2 }, ctx);
ok('done returns confirmation', /marked step 2 done: design/.test(res));
promptText = cap.prompt(env, ctx.session).join('\n');
ok('prompt shows [x] on done step', /2\. \[x\] design/.test(promptText));
ok('other steps still open', /1\. \[ \] explore/.test(promptText));

// list action renders the current plan; fresh ctx reads from file (resume).
const fresh = session('workspace');
res = await tool.execute({ action: 'list' }, fresh);
ok('list works across fresh ctx (file-backed)', /\[x\] design/.test(res));

// set again replaces the whole plan.
res = await tool.execute({ action: 'set', steps: ['redo'] }, fresh);
promptText = cap.prompt(env, fresh.session).join('\n');
ok('set replaces the whole plan', promptText.includes('redo') && !promptText.includes('explore'));

// clear removes the file and the fragment.
res = await tool.execute({ action: 'clear' }, fresh);
ok('clear returns confirmation', /cleared plan/.test(res));
ok('fragment absent after clear', cap.prompt(env, fresh.session).length === 0);
res = await tool.execute({ action: 'list' }, fresh);
ok('list after clear says no plan', /no plan set yet/.test(res));

// Bad index → ERROR, no mutation.
const ctx2 = session('workspace');
await tool.execute({ action: 'set', steps: ['one'] }, ctx2);
res = await tool.execute({ action: 'done', index: 5 }, ctx2);
ok('bad step index returns ERROR', /ERROR: no step at index 5/.test(res));

// Approval: list auto, writes ask. Readonly blocks writes.
ok('list is auto-approved', tool.approval({ action: 'list' }) === 'auto');
ok('set is ask-approved', tool.approval({ action: 'set' }) === 'ask');
res = await tool.execute({ action: 'set', steps: ['nope'] }, session('readonly'));
ok('plan set blocked at readonly', /BLOCKED \(readonly\)/.test(res));
res = await tool.execute({ action: 'clear' }, session('readonly'));
ok('plan clear blocked at readonly', /BLOCKED \(readonly\)/.test(res));

// fullaccess allows writes like workspace (the file stays inside the root).
res = await tool.execute({ action: 'set', steps: ['full ok'] }, session('fullaccess'));
ok('plan set allowed at fullaccess', /set plan with 1 steps/.test(res));

await fs.rm(root, { force: true, recursive: true });
console.log(`\n${passed} plan checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);