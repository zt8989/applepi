// Denylist tests for @applepi/extension (ADR-0009 Q9=a): the denylist floor
// moved INTO the bash tool — no middleware, no registration convention. These
// drive the tool through the seam (`harness.executeTool`), asserting the floor
// fires at every level and that a blocked command never executes.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Harness } from '@applepi/core';
import { bashTool } from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

function boot() {
  const harness = new Harness();
  harness.registerTool(bashTool);
  return harness;
}

/** Drive one bash call through the tool seam (as `loop` does). */
async function callBash(harness, command) {
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command } };
  await harness.executeTool(ctx);
  return String(ctx.toolResult ?? '');
}

// 1. Denylist blocks a dangerous bash command at the default level (workspace).
{
  const harness = boot();
  const res = await callBash(harness, 'rm -rf /');
  assert.match(res, /BLOCKED/);
  ok('denylist blocks `rm -rf /` at workspace');
}

// 2. A blocked command never executes: the denylist returns BLOCKED to the
//    caller and the targeted sentinel file survives (closed-loop, seam-level).
{
  const harness = boot();
  const fs = await import('node:fs');
  const sentinel = fileURLToPath(new URL('./_deny_sentinel.txt', import.meta.url));
  fs.writeFileSync(sentinel, 'i exist');
  try {
    const res = await callBash(harness, `rm -rf ${sentinel}`);
    assert.match(res, /BLOCKED/, `blocked: ${res}`);
    assert.ok(fs.existsSync(sentinel), 'command never executed (sentinel survives)');
    ok('closed loop: denylist blocks command, BLOCKED returned, no execution');
  } finally {
    fs.unlinkSync(sentinel);
  }
}

// 3. The floor fires at fullaccess too (level changes permission SIZE, not the floor).
{
  const harness = boot();
  const levelHandler = harness.getSlashCommand('level');
  assert.ok(levelHandler, 'core /level command installed');
  await levelHandler('fullaccess');
  const res = await callBash(harness, 'rm -rf /tmp/denylist-nonexistent-xyz');
  assert.match(res, /BLOCKED/);
  ok('denylist floor fires at fullaccess');
}

console.log(`\n${passed} denylist checks passed.`);
