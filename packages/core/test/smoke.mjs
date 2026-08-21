// Smoke test for @applepi/core (ADR-0015) — no API key required.
// Validates the Harness shell after the split core: direct tool registration,
// the tool seam (executeTool: known/unknown/throwing), slash commands (the
// core-owned /level), and the CLI run() path with a fake LLM.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Harness,
  SessionStore,
  runLoop,
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

// 3. runLoop: the fake LLM returns a tool call, the seam executes it, the
//    result feeds back to the model, and the loop advances to the next turn.
{
  const h = new Harness();
  h.registerTool(stubTool);
  let turn = 0;
  let done = false;
  const fakeLLM = async () => {
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ toolCallId: 'c1', toolName: 'stub', args: {} }] };
    }
    done = true;
    return { text: 'done' };
  };
  const messages = [{ role: 'user', content: 'run' }];
  await runLoop(h, messages, { model: null, llmCall: fakeLLM, maxTurns: 4 });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message present');
  assert.equal(toolMsg.content[0].result, 'stub-ok');
  assert.ok(done, 'loop advanced to the next turn (did not crash)');
  ok('runLoop: tool seam executes + result fed back + next turn');
}

// 4. run(): persists the user turn, threads history, keeps system out of history.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-smoke-'));
  try {
    const h = new Harness();
    h.registerTool(stubTool);
    const store = new SessionStore({ baseDir: dir });
    await store.create();
    h.attachSession(store);
    const fakeLLM = async () => ({ text: 'hello back' });
    const messages = await h.run('hi', 'SYSTEM_PROMPT', null, { llmCall: fakeLLM });
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'SYSTEM_PROMPT');
    assert.ok(messages.some((m) => m.role === 'user' && m.content === 'hi'));
    // System prompt is NOT part of the persisted conversation history.
    assert.ok(!h.session.history.some((m) => m.role === 'system'));
    // Persisted lines: user + assistant (system not persisted by run()).
    const loaded = await store.load();
    const roles = loaded.messages.map((m) => m.role);
    assert.ok(roles.includes('user') && roles.includes('assistant'));
    assert.equal(roles.includes('system'), false);
    ok('run(): persists user turn, excludes system from history');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 5. /level (core-registered): validates, writes level/set + scratch, restores.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'applepi-smoke-'));
  try {
    const h = new Harness();
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
    const ev = await store.lastEvent('level/set');
    assert.equal(ev.payload.level, 'fullaccess');
    await assert.rejects(() => cmd('bogus'), /must be one of/);
    assert.equal(h.getSlashCommand('nope'), undefined);
    ok('/level: validate + persist + restore + unknown command');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// 6. unregisterTool.
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
