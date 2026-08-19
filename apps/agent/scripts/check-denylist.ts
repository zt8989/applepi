// Key-free demonstration of the denylist security closed loop in the real
// agent context (Harness + onion bus + built-in loop). A fake LLM stands in
// for a provider so no API key is needed. Run:
//   pnpm --filter agent check-denylist
import {
  Harness,
  bashTool,
  denylistExtension,
  runLoop,
} from '@applepi/core';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const harness = new Harness();
harness.registerExtension((api) => api.registerTool(bashTool));
harness.registerExtension(denylistExtension); // outermost tool middleware (priority 1000)

// Scenario: model is tricked/decides to run `rm -rf` on a sentinel file.
const sentinel = join(tmpdir(), 'denylist-sentinel-app');
if (existsSync(sentinel)) unlinkSync(sentinel);
writeFileSync(sentinel, 'i exist');

let turn = 0;
const fakeLLM = async () => {
  turn++;
  if (turn === 1) {
    return {
      toolCalls: [
        { toolCallId: 'c1', toolName: 'bash', args: { command: `rm -rf ${sentinel}` } },
      ],
    };
  }
  return { text: 'Understood, I will not run that.' };
};

const messages: any[] = [{ role: 'user', content: 'delete the sentinel file' }];
await harness.bus.run('session', { session: harness.session, state: {}, messages }, async () => {
  await runLoop(harness, messages, { model: null, llmCall: fakeLLM, maxTurns: 4 });
});

const toolMsg = messages.find((m) => m.role === 'tool');
assert.ok(toolMsg, 'tool result message present');
assert.match(toolMsg.content[0].result, /BLOCKED by denylist/);
assert.ok(existsSync(sentinel), 'command never executed (sentinel survives)');
unlinkSync(sentinel);

console.log('loaded extensions via main path unaffected; denylist closed loop OK:');
console.log('  model issued : rm -rf <sentinel>');
console.log(`  tool result  : ${toolMsg.content[0].result}`);
console.log('  sentinel     : survives (command never ran)');
console.log('OK: denylist security closed loop verified (no API key)');
