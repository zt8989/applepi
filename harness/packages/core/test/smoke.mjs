// Smoke test for @harness/core — no API key required.
// Validates the onion bus + tool execution + denylist without the AI SDK loop.
import assert from 'node:assert/strict';
import {
  Harness,
  OnionBus,
  bashTool,
  strReplaceEditorTool,
  denylistExtension,
} from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

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
  harness.registerExtension((api) => api.registerTool(bashTool));
  bus.use('tool', async (ctx, next) => { throw new Error('boom'); }, { priority: 5 });
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'echo hi' } };
  await bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.ok(ctx.error, 'ctx.error captured');
  assert.equal(ctx.toolResult.trim(), 'hi');
  ok('soft isolation: error captured, tool still executed');
}

// 4. Bash tool executes a safe command end-to-end.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'echo hello-from-core' } };
  await harness.bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.match(ctx.toolResult, /hello-from-core/);
  ok('bash tool executes safe command');
}

// 5. str_replace_editor write + view round-trip.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(strReplaceEditorTool));
  const f = new URL('./_smoke_tmp.txt', import.meta.url).pathname;
  const wctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'write', path: f, content: 'line1\nline2' } };
  await harness.bus.run('tool', wctx, async () => { await harness.executeTool(wctx); });
  assert.match(wctx.toolResult, /WROTE/);
  const rctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'view', path: f } };
  await harness.bus.run('tool', rctx, async () => { await harness.executeTool(rctx); });
  assert.match(rctx.toolResult, /line1/);
  ok('str_replace_editor write+view round-trip');
}

// 6. Denylist blocks a dangerous bash command (T03 closed loop, unit level).
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  harness.registerExtension(denylistExtension);
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'rm -rf /' } };
  await harness.bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.match(ctx.toolResult, /BLOCKED by denylist/);
  ok('denylist blocks `rm -rf /`');
}

console.log(`\n${passed} smoke checks passed.`);

// cleanup temp file written during the str_replace_editor round-trip
import('node:fs').then((fs) => {
  const f = new URL('./_smoke_tmp.txt', import.meta.url).pathname;
  try { fs.unlinkSync(f); } catch {}
});
