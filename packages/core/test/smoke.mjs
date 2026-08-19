// Smoke test for @harness/core — no API key required.
// Validates the onion bus + tool execution + soft isolation + loader, all
// WITHOUT depending on any concrete tool (reference tools and the denylist
// moved to @applepi/extensions, ADR-0005; their tests live in
// packages/extensions/test/{tools,denylist}.mjs).
import assert from 'node:assert/strict';
import {
  Harness,
  OnionBus,
  runLoop,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// A concrete tool is not needed here: soft-isolation is a bus/loop property,
// exercised through a minimal stub instead of a reference tool.
const stubTool = {
  name: 'stub',
  description: 'no-op stub used by soft-isolation tests',
  parameters: { safeParse: () => ({ success: true }) },
  async execute() {
    return 'stub-ok';
  },
};

// 1. Onion order: outer runs before/after inner.
{
  const bus = new OnionBus();
  const order = [];
  bus.use('tool', async (ctx, next) => {
    order.push('outer-in');
    await next();
    order.push('outer-out');
  }, { priority: 10 });
  bus.use('tool', async (ctx, next) => {
    order.push('inner-in');
    await next();
    order.push('inner-out');
  }, { priority: 1 });
  await bus.run('tool', { state: {} }, async () => { order.push('final'); });
  assert.deepEqual(order, ['outer-in', 'inner-in', 'final', 'inner-out', 'outer-out']);
  ok('onion order (outer wraps inner)');
}

// 2. Veto: returning without next() skips inner + final.
{
  const bus = new OnionBus();
  let innerRan = false;
  let finalRan = false;
  bus.use('tool', async (ctx, next) => {
    ctx.toolResult = 'VETOED';
    return; // no next()
  }, { priority: 10 });
  bus.use('tool', async (ctx, next) => { innerRan = true; await next(); }, { priority: 1 });
  await bus.run('tool', { state: {} }, async () => { finalRan = true; });
  assert.equal(innerRan, false);
  assert.equal(finalRan, false);
  ok('veto skips inner + final');
}

// 3. Soft isolation: a throwing middleware is caught, inner still runs.
{
  const bus = new OnionBus();
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(stubTool));
  bus.use('tool', async (ctx, next) => { throw new Error('boom'); }, { priority: 5 });
  const ctx = { session: harness.session, state: {}, toolName: 'stub', toolArgs: {} };
  await bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.ok(ctx.error, 'ctx.error captured');
  assert.equal(ctx.toolResult, 'stub-ok');
  ok('soft isolation: error captured, tool still executed');
}

// 4. Auto-discovery: a *.ext.mjs in a scanned dir is registered without loader edits (T02).
{
  const harness = new Harness();
  const fxDir = new URL('./fixtures/', import.meta.url).pathname;
  const loaded = await harness.loadExtensionsFromDir(fxDir);
  assert.ok(loaded.includes('echo.ext.mjs'), `fixture discovered: ${loaded}`);
  const names = harness.api.getTools().map((t) => t.name);
  assert.ok(names.includes('echo'), `echo tool registered: ${names}`);
  ok('auto-discovery registers tool from scanned dir (Q12/Q14)');
}

// 5. Discovery set tracks the directory: adding/removing files changes the tool set.
{
  const harness = new Harness();
  const tmp = new URL('./_empty_ext_dir/', import.meta.url).pathname;
  await import('node:fs').then((fs) => fs.mkdirSync(tmp, { recursive: true }));
  const loaded = await harness.loadExtensionsFromDir(tmp);
  assert.equal(loaded.length, 0, 'empty dir yields no extensions');
  assert.ok(!harness.api.getTools().map((t) => t.name).includes('echo'));
  await import('node:fs').then((fs) => fs.rmSync(tmp, { recursive: true, force: true }));
  ok('discovery set tracks directory contents (add/remove files)');
}

// 6. Soft isolation full-loop demo (T07): a misbehaving tool-stack middleware
//    throws (post-next phase), the bus catches it (sets ctx.error), the loop
//    converts it to an ERROR tool result delivered to the model, and the loop
//    advances to the next turn instead of crashing.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(stubTool));
  // priority 5: throws AFTER delegating.
  harness.registerExtension((api) =>
    api.use('tool', async (ctx, next) => {
      await next();
      throw new Error('middleware exploded');
    }, { priority: 5 }),
  );
  let turn = 0;
  let secondTurnRan = false;
  const fakeLLM = async () => {
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ toolCallId: 'c1', toolName: 'stub', args: {} }] };
    }
    secondTurnRan = true;
    return { text: 'recovered' };
  };
  const messages = [{ role: 'user', content: 'run something' }];
  await harness.bus.run('session', { session: harness.session, state: {}, messages }, async () => {
    await runLoop(harness, messages, { model: null, llmCall: fakeLLM, maxTurns: 4 });
  });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message present');
  assert.match(toolMsg.content[0].result, /^ERROR: middleware exploded/, 'ERROR delivered to model');
  assert.ok(secondTurnRan, 'loop continued to the next turn (did not crash)');
  ok('soft isolation: misbehaving middleware -> ERROR to model, loop continues');
}

console.log(`\n${passed} smoke checks passed.`);
