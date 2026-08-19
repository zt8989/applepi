// Reference-tool tests for @applepi/extensions (ADR-0005) — no API key
// required. Exercises `bash` and `str_replace_editor` end-to-end through a
// real Harness (moved here from packages/core/test/smoke.mjs, Q5=A).
import assert from 'node:assert/strict';
import { Harness } from '@applepi/core';
import { bashTool, strReplaceEditorTool } from '../dist/index.js';

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ok - ${name}`);
}

// 1. Bash tool executes a safe command end-to-end.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(bashTool));
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'echo hello-from-extensions' } };
  await harness.bus.run('tool', ctx, async () => { await harness.executeTool(ctx); });
  assert.match(ctx.toolResult, /hello-from-extensions/);
  ok('bash tool executes safe command');
}

// 2. str_replace_editor write + view round-trip.
{
  const harness = new Harness();
  harness.registerExtension((api) => api.registerTool(strReplaceEditorTool));
  const f = new URL('./_tools_tmp.txt', import.meta.url).pathname;
  const wctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'write', path: f, content: 'line1\nline2' } };
  await harness.bus.run('tool', wctx, async () => { await harness.executeTool(wctx); });
  assert.match(wctx.toolResult, /WROTE/);
  const rctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'view', path: f } };
  await harness.bus.run('tool', rctx, async () => { await harness.executeTool(rctx); });
  assert.match(rctx.toolResult, /line1/);
  ok('str_replace_editor write+view round-trip');
}

console.log(`\n${passed} tools checks passed.`);

// cleanup temp file written during the str_replace_editor round-trip
import('node:fs').then((fs) => {
  const f = new URL('./_tools_tmp.txt', import.meta.url).pathname;
  try { fs.unlinkSync(f); } catch {}
});
