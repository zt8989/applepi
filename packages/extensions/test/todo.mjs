import { createTodo, getCapability } from '../dist/index.js';
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

const root = path.join(os.tmpdir(), `todo-test-${Date.now()}`);
await fs.rm(root, { force: true, recursive: true });

// Todo is a declarative capability (ADR-0015): { id, prompt, tools }.
const cap = createTodo();
ok('registers as capability id=todo', cap.id === 'todo');
ok(
  'contributes a flat prompt fragment (sync renderer)',
  typeof cap.prompt === 'function' &&
    cap.prompt({ cwd: '/x', workspace: root }, { history: [], config: {}, scratch: {} }).length >= 1,
);

const tool = cap.tools[0];
ok('registers single "todo" tool', cap.tools.length === 1 && tool.name === 'todo');
ok('resolves via getCapability("todo")', getCapability('todo').tools[0].name === 'todo');

const env = { cwd: '/irrelevant', workspace: root };
const session = (permissionLevel) => ({
  session: { history: [], config: { workspace: root, permissionLevel }, scratch: {} },
});

// Empty list: prompt shows an honest empty state.
ok('empty list renders "(todo list is empty)"', cap.prompt(env, { config: {} }).join('\n').includes('(todo list is empty)'));

// add → file persisted under the workspace root, prompt reflects it next turn.
const ctx = session('workspace');
let res = await tool.execute({ action: 'add', text: 'write spec' }, ctx);
ok('add returns confirmation', /added todo 1/.test(res));
let promptText = cap.prompt(env, ctx.session).join('\n');
ok('prompt lists the added task with 1-based index', /1\. \[ \] write spec/.test(promptText));
const file = path.join(root, '.harness', 'todo.json');
const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
ok('persisted to .harness/todo.json under workspace root', onDisk.items.length === 1 && onDisk.items[0].text === 'write spec');

// A fresh ctx (later call / resumed session) reads from the same file.
await tool.execute({ action: 'add', text: 'review spec' }, session('workspace'));
const fresh = session('workspace');
res = await tool.execute({ action: 'list' }, fresh);
ok('list action returns numbered current list', /1\. \[ \] write spec/.test(res) && /2\. \[ \] review spec/.test(res));

// done → [x]; remove → splices; indexes follow the prompt numbering.
res = await tool.execute({ action: 'done', index: 1 }, fresh);
ok('done returns confirmation', /marked todo 1 done/.test(res));
promptText = cap.prompt(env, fresh.session).join('\n');
ok('prompt shows [x] on done item', /1\. \[x\] write spec/.test(promptText));
res = await tool.execute({ action: 'remove', index: 2 }, fresh);
ok('remove returns confirmation', /removed todo: review spec/.test(res));
promptText = cap.prompt(env, fresh.session).join('\n');
ok('removed item no longer in prompt', !/review spec/.test(promptText));

// Out-of-range index → ERROR, no mutation.
res = await tool.execute({ action: 'done', index: 99 }, fresh);
ok('bad index returns ERROR', /ERROR: no todo at index 99/.test(res));

// auto vs ask approval: list auto, writes ask.
ok('list is auto-approved', tool.approval({ action: 'list' }) === 'auto');
ok('add is ask-approved', tool.approval({ action: 'add' }) === 'ask');

// readonly blocks writes (self-determination, ADR-0009); list still allowed.
const rctx = session('readonly');
res = await tool.execute({ action: 'add', text: 'nope' }, rctx);
ok('todo add blocked at readonly', /BLOCKED \(readonly\)/.test(res));
res = await tool.execute({ action: 'list' }, rctx);
ok('todo list allowed at readonly', /write spec/.test(res));

await fs.rm(root, { force: true, recursive: true });
console.log(`\n${passed} todo checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);