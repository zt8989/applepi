import { createMemoryExtension } from '../../../dist/extensions/index.js';
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

// Drive the extension through a minimal fake HarnessApi (no Harness needed).
const setup = createMemoryExtension({ filePath: file });
const tools = [];
const api = {
  registerTool: (t) => tools.push(t),
  use: () => {},
  ctx: { history: [], config: {}, scratch: {} },
  getTools: () => tools,
};
setup(api);

const write = tools.find((t) => t.name === 'memory_write');
const read = tools.find((t) => t.name === 'memory_read');

ok('registers memory_write', !!write);
ok('registers memory_read', !!read);

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

await fs.rm(file, { force: true });
console.log(`\n${passed} memory checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
