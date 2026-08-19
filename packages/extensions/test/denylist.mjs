// Denylist tests for @applepi/extensions (ADR-0009 Q9=a): the denylist floor
// moved INTO the bash tool — no middleware, no registration convention. These
// drive the tool directly and through the loop, asserting the floor fires at
// every level.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Harness, runLoop } from '@applepi/core';
import { bashTool } from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

function boot() {
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  return harness;
}

/** Drive one bash call through the `tool` onion stack (as runLoop does). */
async function callBash(harness, command) {
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command } };
  await harness.bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  return String(ctx.toolResult ?? '');
}

// 1. Denylist blocks a dangerous bash command at the default level (workspace).
{
  const harness = boot();
  const res = await callBash(harness, 'rm -rf /');
  assert.match(res, /BLOCKED/);
  ok('denylist blocks `rm -rf /` at workspace');
}

// 2. Closed loop: model issues dangerous bash -> BLOCKED returned to model,
//    command never executes (sentinel survives).
{
  const harness = boot();
  const fs = await import('node:fs');
  const sentinel = fileURLToPath(new URL('./_deny_sentinel.txt', import.meta.url));
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
    assert.match(toolMsg.content[0].result, /BLOCKED/);
    assert.ok(fs.existsSync(sentinel), 'command never executed (sentinel survives)');
    ok('closed loop: denylist blocks model command, BLOCKED returned, no execution');
  } finally {
    fs.unlinkSync(sentinel);
  }
}

// 3. The floor fires at fullaccess too (level changes permission SIZE, not the floor).
{
  const harness = boot();
  const levelHandler = harness.api.getSlashCommand('level');
  assert.ok(levelHandler, 'core SecurityPolicy /level command installed');
  await levelHandler('fullaccess', harness.api);
  const res = await callBash(harness, 'rm -rf /tmp/denylist-nonexistent-xyz');
  assert.match(res, /BLOCKED/);
  ok('denylist floor fires at fullaccess');
}

console.log(`\n${passed} denylist checks passed.`);
