import { createMemory, getCapability } from '../dist/index.js';
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

const file = path.join(os.tmpdir(), `mem-test-${Date.now()}.json`);
await fs.rm(file, { force: true });

// Memory is a declarative capability (ADR-0015): { id, prompt, tools }.
const cap = createMemory({ filePath: file });
ok('registers as capability id=memory', cap.id === 'memory');
ok('contributes a flat prompt fragment', Array.isArray(cap.prompt) === false && typeof cap.prompt === 'function' && cap.prompt({ cwd: process.cwd() }, { history: [], config: {}, scratch: {} }).length >= 1);

const tools = cap.tools;
const write = tools.find((t) => t.name === 'memory_write');
const read = tools.find((t) => t.name === 'memory_read');

ok('registers memory_write', !!write);
ok('registers memory_read', !!read);
ok('resolves via getCapability("memory")', getCapability('memory').tools.some((t) => t.name === 'memory_read'));

// In-session write + read (proves ctx.session.scratch read/write).
const ctx = { session: { history: [], config: {}, scratch: {} } };
const wRes = await write.execute({ key: 'project', value: 'harness' }, ctx);
ok('memory_write returns confirmation', /harness/.test(wRes));
const rInSession = await read.execute({ key: 'project' }, ctx);
ok('in-session read hits scratch mirror', /harness/.test(rInSession));

// A fresh ctx (simulating a later tool call / session) reads from the file.
const freshCtx = { session: { history: [], config: {}, scratch: {} } };
const rFromFile = await read.execute({ key: 'project' }, freshCtx);
ok('file-backed read (cross-call) works', /harness/.test(rFromFile));

// File actually persisted.
const content = await fs.readFile(file, 'utf8');
ok('persisted to JSON file', /harness/.test(content) && /project/.test(content));

// Missing-key path.
const missing = await read.execute(
  { key: 'nope' },
  { session: { history: [], config: {}, scratch: {} } },
);
ok('missing key returns not-found', /not found/.test(missing));

// readonly blocks the write (self-determination, ADR-0009).
const rctx = {
  session: { history: [], config: {}, scratch: { __permissionLevel: 'readonly' } },
};
const blocked = await write.execute({ key: 'k', value: 'v' }, rctx);
ok('memory_write blocked at readonly', /BLOCKED/.test(blocked));

await fs.rm(file, { force: true });
console.log(`\n${passed} memory checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
