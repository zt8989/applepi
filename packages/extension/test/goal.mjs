import { createGoal, getCapability } from '../dist/index.js';
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

const root = path.join(os.tmpdir(), `goal-test-${Date.now()}`);
await fs.rm(root, { force: true, recursive: true });

const cap = createGoal();
ok('registers as capability id=goal', cap.id === 'goal');

const tool = cap.tools[0];
ok('registers single "goal" tool', cap.tools.length === 1 && tool.name === 'goal');
ok('resolves via getCapability("goal")', getCapability('goal').tools[0].name === 'goal');

const env = { cwd: '/irrelevant', workspace: root };
const session = (permissionLevel) => ({
  session: { history: [], config: { workspace: root, permissionLevel }, scratch: {} },
});

// No goal → no prompt fragment.
ok('no fragment when no goal set', cap.prompt(env, { config: {} }).length === 0);

// set → fragment appears with the goal text.
const ctx = session('workspace');
let res = await tool.execute({ action: 'set', text: 'ship the harness' }, ctx);
ok('set returns confirmation', /set session goal: ship the harness/.test(res));
let promptText = cap.prompt(env, ctx.session).join('\n');
ok('fragment surfaces the current goal', promptText.includes('Current goal: ship the harness'));
const file = path.join(root, '.harness', 'goal.json');
const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
ok('persisted to .harness/goal.json under workspace root', onDisk.text === 'ship the harness');

// Fresh ctx (resumed session) still reads the goal from file.
const fresh = session('workspace');
promptText = cap.prompt(env, fresh.session).join('\n');
ok('goal fresh from file across ctx', promptText.includes('Current goal: ship the harness'));

// set replaces the goal.
res = await tool.execute({ action: 'set', text: 'new goal' }, fresh);
promptText = cap.prompt(env, fresh.session).join('\n');
ok('set replaces the goal', promptText.includes('Current goal: new goal') && !promptText.includes('ship the harness'));

// clear removes the file and the fragment.
res = await tool.execute({ action: 'clear' }, fresh);
ok('clear returns confirmation', /cleared session goal/.test(res));
ok('fragment absent after clear', cap.prompt(env, fresh.session).length === 0);
ok('file removed after clear', !(await fs.stat(file).catch(() => null)));

// ERROR on empty text; readonly blocks both actions.
res = await tool.execute({ action: 'set', text: '   ' }, session('workspace'));
ok('empty text returns ERROR', /ERROR: text required/.test(res));
res = await tool.execute({ action: 'set', text: 'nope' }, session('readonly'));
ok('goal set blocked at readonly', /BLOCKED \(readonly\)/.test(res));
res = await tool.execute({ action: 'clear' }, session('readonly'));
ok('goal clear blocked at readonly', /BLOCKED \(readonly\)/.test(res));

// fullaccess allows writes (the file stays inside the workspace root).
res = await tool.execute({ action: 'set', text: 'full ok' }, session('fullaccess'));
ok('goal set allowed at fullaccess', /set session goal: full ok/.test(res));

await fs.rm(root, { force: true, recursive: true });
console.log(`\n${passed} goal checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);