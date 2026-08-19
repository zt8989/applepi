// End-to-end check for soft isolation (T07), driven without a real LLM/API key
// by injecting a fake `llmCall` into runLoop. Reproduces the real Harness +
// onion bus + built-in loop, registers a misbehaving tool-stack middleware, and
// asserts that: (1) the throw is caught by the bus's per-layer try/catch and
// surfaced as an ERROR result delivered to the model, and (2) the loop advances
// to the next turn instead of crashing. Verifies spec §4 / Q7-(iii) soft
// isolation under the same-process, zero-isolation premise.
import { Harness, runLoop } from '@applepi/core';
import { baseExtension } from '@applepi/extensions';

const harness = new Harness();

// Reference tools + outermost denylist, same wiring as main.ts (ADR-0005).
harness.registerExtension(baseExtension);

// A misbehaving middleware: priority 5 (inner to denylist's 1000), throws AFTER
// delegating to the inner chain (post-next phase) — the nastiest spot to catch.
harness.registerExtension((api) =>
  api.use(
    'tool',
    async (_ctx, next) => {
      await next();
      throw new Error('middleware exploded');
    },
    { priority: 5 },
  ),
);

let turn = 0;
let secondTurnRan = false;
let modelSawError = '';
const fakeLlm: any = async ({ messages }: any) => {
  turn++;
  if (turn === 1) {
    return {
      text: 'about to call bash',
      toolCalls: [
        { toolCallId: 'c1', toolName: 'bash', args: { command: 'echo hi' } },
      ],
    };
  }
  // Capture the tool message the model would see on the next turn.
  const toolMsg = (messages ?? []).find((m: any) => m.role === 'tool');
  if (toolMsg) {
    const c = toolMsg.content;
    modelSawError = Array.isArray(c) ? (c[0]?.result ?? '') : c;
  }
  secondTurnRan = true;
  return { text: 'recovered, loop kept going' };
};

const messages: any[] = [{ role: 'user', content: 'run something' }];
await runLoop(harness, messages, { model: {}, llmCall: fakeLlm, maxTurns: 6 });

console.log('--- model saw on next turn:', modelSawError.slice(0, 120));

const okIsolated =
  /^ERROR: middleware exploded/.test(modelSawError) && secondTurnRan;

if (okIsolated) {
  console.log('check-soft-isolation: OK');
} else {
  console.error('check-soft-isolation: FAIL');
  process.exit(1);
}
