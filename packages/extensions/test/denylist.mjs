// Denylist security-extension tests for @applepi/extensions (ADR-0005) — no
// API key required. Moved here from packages/core/test/smoke.mjs (Q5=A) and
// rewritten for the pure `denylistMiddleware` shape (Q7=A): it is mounted
// manually at priority 1000, exercising the fine-grained path (as opposed to
// baseExtension's internal mounting).
import assert from 'node:assert/strict';
import { Harness, runLoop } from '@applepi/core';
import { bashTool, denylistMiddleware } from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

/** Wire bash + denylistMiddleware outermost (the ADR-0005 registration convention). */
function boot() {
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  harness.registerExtension((api) => api.use('tool', denylistMiddleware, { priority: 1000 }));
  return harness;
}

// 1. Denylist blocks a dangerous bash command (unit level).
{
  const harness = boot();
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'rm -rf /' } };
  await harness.bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.match(ctx.toolResult, /BLOCKED by denylist/);
  ok('denylist blocks `rm -rf /`');
}

// 2. Closed loop: model issues dangerous bash -> denylist vetoes at ENTRY ->
//    BLOCKED returned to model, command never executes (T03, no API key).
{
  const harness = boot();
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

// 3. Inner (iii) rewrite cannot surface a real result: an inner middleware
//    rewrites a SAFE command into `rm -rf`, denylist EXIT check overwrites the
//    result with BLOCKED (Q16 / spec §7: outermost gate audits final command).
{
  const harness = boot();
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

console.log(`\n${passed} denylist checks passed.`);
