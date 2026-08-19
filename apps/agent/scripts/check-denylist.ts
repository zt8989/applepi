// Key-free verification of the denylist floor (ADR-0009 Q9=a): since the
// denylist moved INTO the bash tool, this drives real tool calls through the
// `tool` stack and asserts the floor fires at EVERY level. A fake LLM stands
// in for a provider so no API key is needed. Run:
//   pnpm --filter agent check-denylist
import { Harness, runLoop } from '@applepi/core';
import { bashTool } from '@applepi/extensions';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const harness = new Harness();
harness.registerExtension((api) => api.registerTool(bashTool));

/** Drive one bash call through the `tool` onion stack (as runLoop does). */
async function callBash(command: string): Promise<string> {
  const tctx: any = { session: harness.session, state: {}, toolName: 'bash', toolArgs: { command } };
  await harness.bus.run('tool', tctx, async () => {
    await harness.executeTool(tctx);
  });
  return String(tctx.toolResult ?? '');
}

// 1. Unit level: `rm -rf /` is blocked at the default level (workspace).
{
  const res = await callBash('rm -rf /');
  assert.match(res, /BLOCKED/, `rm -rf / blocked: ${res}`);
}

// 2. Closed loop: model issues dangerous bash -> BLOCKED returned to the
//    model, command never executes (sentinel survives).
{
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
  assert.match(toolMsg.content[0].result, /BLOCKED/);
  assert.ok(existsSync(sentinel), 'command never executed (sentinel survives)');
  unlinkSync(sentinel);
}

// 3. The floor fires at fullaccess too (level is the size of permission, not
//    an exemption from the floor).
{
  const levelHandler = harness.api.getSlashCommand('level')!;
  await levelHandler('fullaccess', harness.api);
  const res = await callBash('rm -rf /tmp/denylist-nonexistent-xyz');
  assert.match(res, /BLOCKED/, `fullaccess still blocks rm -rf: ${res}`);
}

console.log('denylist floor verified at every level (unit + closed loop + fullaccess):');
console.log('OK: denylist security closed loop verified (no API key)');
