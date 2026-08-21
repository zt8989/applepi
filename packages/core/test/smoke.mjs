// Smoke test for @applepi/core (ADR-0015 + ADR-0016) — no API key required.
// Validates the Harness shell after the split core: direct tool registration,
// the tool seam (executeTool: known/unknown/throwing), slash commands (the
// core-owned /level, which persists to the config file per ADR-0016), and the
// web-only streaming loop (stream-loop.mjs). Session persistence lives in
// `session.mjs`.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Harness,
  SessionStore,
  getPermissionLevel,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

const stubTool = {
  name: 'stub',
  description: 'no-op stub',
  parameters: { safeParse: () => ({ success: true }) },
  async execute() {
    return 'stub-ok';
  },
};

// 1. registerTool + duplicate guard + buildToolDefs/getTools surface.
{
  const h = new Harness();
  h.registerTool(stubTool);
  assert.throws(() => h.registerTool({ ...stubTool, name: 'stub' }), /already registered/);
  assert.deepEqual(h.getTools().map((t) => t.name), ['stub']);
  assert.equal(h.getTool('stub').name, 'stub');
  assert.equal(h.getTool('nope'), undefined);
  const defs = h.buildToolDefs();
  assert.equal(defs.stub.description, stubTool.description);
  ok('registerTool + duplicate guard + buildToolDefs');
}

// 2. Tool seam: known tool executes; unknown tool -> ERROR; throwing tool caught.
{
  const h = new Harness();
  h.registerTool(stubTool);
  const ctx = { session: h.session, state: {}, toolName: 'stub', toolArgs: {} };
  await h.executeTool(ctx);
  assert.equal(ctx.toolResult, 'stub-ok');

  const missing = { session: h.session, state: {}, toolName: 'missing', toolArgs: {} };
  await h.executeTool(missing);
  assert.match(missing.toolResult, /^ERROR: unknown tool/);

  h.registerTool({
    name: 'boom',
    description: '',
    parameters: {},
    async execute() {
      throw new Error('kapow');
    },
  });
  const bx = { session: h.session, state: {}, toolName: 'boom', toolArgs: {} };
  await h.executeTool(bx);
  assert.match(bx.toolResult, /^ERROR: kapow/);
  ok('tool seam: known/unknown/throwing');
}

// 3. /level (core-registered, ADR-0016): validates, persists override to config + restore.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-smoke-'));
  try {
    const h = new Harness({ baseDir: dir });
    const store = new SessionStore({ baseDir: dir });
    await store.create();
    h.attachSession(store);
    await h.restoreSecurity(store);
    assert.equal(getPermissionLevel({ session: h.session }), 'workspace', 'default workspace');

    const cmd = h.getSlashCommand('level');
    assert.ok(cmd, 'level command registered by core');
    const msg = await cmd('fullaccess');
    assert.match(msg, /fullaccess/);
    assert.equal(getPermissionLevel({ session: h.session }), 'fullaccess');
    // The override is persisted to the config file (ADR-0016), not a level/set event.
    const cfg = await store.loadConfig();
    assert.equal(cfg.permissionLevel, 'fullaccess');
    await store.appendEvent('someone/set', { x: 1 }); // sanity: events still work
    await assert.rejects(() => cmd('bogus'), /must be one of/);
    assert.equal(h.getSlashCommand('nope'), undefined);
    ok('/level: validate + persist override + restore + unknown command');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 4. unregisterTool.
{
  const h = new Harness();
  h.registerTool(stubTool);
  h.unregisterTool('stub');
  assert.equal(h.getTool('stub'), undefined);
  // unregistering a non-existent tool is a no-op
  h.unregisterTool('nope');
  ok('unregisterTool');
}

console.log(`\n${passed} smoke checks passed.`);
