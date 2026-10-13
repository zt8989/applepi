import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime, demoResponses } from '../src/provider';

/**
 * 端到端（不打网络）：pi-ai 自带的 faux provider + 真的 Models.streamSimple，
 * 走完整条 Redux Loop —— prompt → LLM(流) → 工具 → LLM(流) → idle。
 */
test('pi-ai faux provider：真实 streamSimple 跑完一整条 Agent Loop', async () => {
  const faux = createFauxRuntime();
  faux.setResponses(demoResponses());

  const store = createAgentStore({ runtime: faux.runtime, systemPrompt: 'test' });
  store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' });
  const state = await waitForIdle(store);

  assert.equal(state.phase, 'idle');
  assert.equal(state.error, null);
  assert.equal(state.turns, 2);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['user', 'assistant', 'toolResult', 'assistant'],
  );

  const toolResult = state.messages[2];
  assert.ok(toolResult && toolResult.role === 'toolResult');
  assert.equal(toolResult.isError, false);
  const toolText = toolResult.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
  // bash 的 stdout 就是 42。
  assert.match(toolText, /42/);

  const final = state.messages[3];
  assert.ok(final && final.role === 'assistant');
  const finalText = final.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.match(finalText, /42/);
});
