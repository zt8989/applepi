// Reference-tool tests for @applepi/extension (ADR-0005) — no API key
// required. Exercises `bash` and `str_replace_editor` end-to-end through a
// real Harness. Per ADR-0015 tools are registered directly and execute via the
// tool seam (`harness.executeTool`).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
  harness.registerTool(bashTool);
  const ctx = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command: 'echo hello-from-extensions' } };
  await harness.executeTool(ctx);
  assert.match(ctx.toolResult, /hello-from-extensions/);
  ok('bash tool executes safe command');
}

// 2. str_replace_editor write + view round-trip.
{
  const harness = new Harness();
  harness.registerTool(strReplaceEditorTool);
  // fileURLToPath (not .pathname): .pathname yields a `/C:/...` root-relative
  // path on Windows, which the tool then mis-resolves to `C:\C:\...`.
  const f = fileURLToPath(new URL('./_tools_tmp.txt', import.meta.url));
  const wctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'write', path: f, content: 'line1\nline2' } };
  await harness.executeTool(wctx);
  assert.match(wctx.toolResult, /WROTE/);
  const rctx = { session: harness.session, state: {}, toolName: 'str_replace_editor', toolArgs: { command: 'view', path: f } };
  await harness.executeTool(rctx);
  assert.match(rctx.toolResult, /line1/);
  ok('str_replace_editor write+view round-trip');
}

// 3. Unknown tool via the seam -> ERROR (no onion to fall through).
{
  const harness = new Harness();
  const ctx = { session: harness.session, state: {}, toolName: 'nope', toolArgs: {} };
  await harness.executeTool(ctx);
  assert.match(ctx.toolResult, /^ERROR: unknown tool/);
  ok('executeTool reports unknown tool');
}

console.log(`\n${passed} tools checks passed.`);

// cleanup temp file written during the str_replace_editor round-trip
import('node:fs').then((fs) => {
  const f = fileURLToPath(new URL('./_tools_tmp.txt', import.meta.url));
  try { fs.unlinkSync(f); } catch {}
});
