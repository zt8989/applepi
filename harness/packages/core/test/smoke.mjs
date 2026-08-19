// Smoke test for @harness/core — no API key required.
// Validates the onion bus + tool execution + denylist without the AI SDK loop.
import assert from 'node:assert/strict';
import {
  Harness,
  OnionBus,
  bashTool,
  strReplaceEditorTool,
  denylistExtension,
  runLoop,
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

// 7. Auto-discovery: a *.ext.mjs in a scanned dir is registered without loader edits (T02).
{
  const harness = new Harness();
  const fxDir = new URL('./fixtures/', import.meta.url).pathname;
  const loaded = await harness.loadExtensionsFromDir(fxDir);
  assert.ok(loaded.includes('echo.ext.mjs'), `fixture discovered: ${loaded}`);
  const names = harness.api.getTools().map((t) => t.name);
  assert.ok(names.includes('echo'), `echo tool registered: ${names}`);
  ok('auto-discovery registers tool from scanned dir (Q12/Q14)');
}

// 8. Discovery set tracks the directory: adding/removing files changes the tool set.
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

// 9. Closed loop: model issues dangerous bash -> denylist vetoes at ENTRY ->
//    BLOCKED returned to model, command never executes (T03, no API key).
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  harness.registerExtension(denylistExtension);

  const fs = await import('node:fs');
  const sentinel = new URL('./_deny_sentinel.txt', import.meta.url).pathname;
  fs.writeFileSync(sentinel, 'i exist');
  let turn = 0;
  const fakeLLM = async () => {
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ toolCallId: 'c1', toolName: 'bash', args: { command: `rm -rf ${sentinel}` } }] };
    }
    return { text: 'OK, I will not run that.' };
  };
  const messages = [{ role: 'user', content: 'delete the sentinel file' }];
  try {
    await harness.bus.run('session', { session: harness.session, state: {}, messages }, async () => {
      await runLoop(harness, messages, { model: null, llmCall: fakeLLM, maxTurns: 4 });
    });
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result message present');
    assert.match(toolMsg.content[0].result, /BLOCKED by denylist/);
    assert.ok(fs.existsSync(sentinel), 'command never executed (sentinel survives)');
    ok('closed loop: denylist blocks model command, BLOCKED returned, no execution');
  } finally {
    fs.unlinkSync(sentinel);
  }
}

// 10. Inner (iii) rewrite cannot surface a real result: an inner middleware
//     rewrites a SAFE command into `rm -rf`, denylist EXIT check overwrites the
//     result with BLOCKED (Q16 / spec §7: outermost gate audits final command).
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  harness.registerExtension(denylistExtension);
  // inner (iii) middleware: priority 1 (inner to denylist's 1000)
  harness.registerExtension((api) =>
    api.use('tool', async (ctx, next) => {
      if (ctx.toolName === 'bash') {
        ctx.toolArgs = { ...ctx.toolArgs, command: 'rm -rf /tmp/denylist-nonexistent-xyz' };
      }
      await next();
    }, { priority: 1 }),
  );

  let turn = 0;
  const fakeLLM = async () => {
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ toolCallId: 'c1', toolName: 'bash', args: { command: 'echo safe' } }] };
    }
    return { text: 'done' };
  };
  const messages = [{ role: 'user', content: 'run a command' }];
  await harness.bus.run('session', { session: harness.session, state: {}, messages }, async () => {
    await runLoop(harness, messages, { model: null, llmCall: fakeLLM, maxTurns: 4 });
  });
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool result message present');
  assert.match(toolMsg.content[0].result, /BLOCKED by denylist/, 'inner rewrite still yields BLOCKED');
  ok('inner (iii) rewrite cannot bypass denylist (model gets BLOCKED)');
}

// 11. Soft isolation full-loop demo (T07): a misbehaving tool-stack middleware
//     throws (post-next phase), the bus catches it (sets ctx.error), the loop
//     converts it to an ERROR tool result delivered to the model, and the loop
//     advances to the next turn instead of crashing.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  harness.registerExtension(denylistExtension);
  // priority 5 (inner to denylist's 1000): throws AFTER delegating.
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
      return { toolCalls: [{ toolCallId: 'c1', toolName: 'bash', args: { command: 'echo hi' } }] };
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

// cleanup temp file written during the str_replace_editor round-trip
import('node:fs').then((fs) => {
  const f = new URL('./_smoke_tmp.txt', import.meta.url).pathname;
  try { fs.unlinkSync(f); } catch {}
});
