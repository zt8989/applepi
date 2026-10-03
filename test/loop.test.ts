import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createFauxRuntime } from '../src/provider';
import { agentReducer } from '../src/reducer';
import { createInitialState } from '../src/state';

const usage = () => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'faux',
    model: 'fake',
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/** 假流：把脚本事件按顺序吐出来。 */
function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  } as unknown as AssistantMessageEventStream;
}

function textOf(message: { content: { type: string; text?: string }[] }): string {
  return message.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

test('prompt → LLM → 工具 → LLM → idle：环闭合，工具结果回到消息流', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      if (calls === 1) {
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: 'call_1',
          name: 'calc',
          arguments: { expression: '(3+4)*6' },
        };
        const message = assistantMessage(
          [{ type: 'text', text: '我来算。' }, toolCall],
          'toolUse',
        );
        return streamOf([
          { type: 'text_delta', contentIndex: 0, delta: '我来算。', partial: message },
          { type: 'toolcall_end', contentIndex: 1, toolCall, partial: message },
          { type: 'done', reason: 'toolUse', message },
        ]);
      }
      const message = assistantMessage([{ type: 'text', text: '(3+4)*6 = 42' }], 'stop');
      return streamOf([
        { type: 'text_delta', contentIndex: 0, delta: '(3+4)*6 = 42', partial: message },
        { type: 'done', reason: 'stop', message },
      ]);
    },
  });

  store.dispatch({ type: 'prompt', text: '算一下 (3+4)*6' });
  const state = await waitForIdle(store);
  console.log('  → 消息链：', state.messages.map((m) => m.role).join(' → '));

  assert.equal(state.phase, 'idle');
  assert.equal(state.error, null);
  assert.equal(state.turns, 2);
  assert.equal(calls, 2);
  assert.deepEqual(
    state.messages.map((m) => m.role),
    ['user', 'assistant', 'toolResult', 'assistant'],
  );
  const toolResult = state.messages[2];
  assert.ok(toolResult);
  assert.equal(toolResult.role, 'toolResult');
  assert.ok(toolResult.role === 'toolResult' && !toolResult.isError);
  assert.match(textOf(toolResult), /= 42/);
});

test('单回合轮数上限：不再无限调 LLM，而是停下并报错', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    maxTurns: 1,
    streamFn: () => {
      calls += 1;
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: `call_${calls}`,
        name: 'now',
        arguments: {},
      };
      const message = assistantMessage([toolCall], 'toolUse');
      return streamOf([{ type: 'done', reason: 'toolUse', message }]);
    },
  });

  store.dispatch({ type: 'prompt', text: '一直调工具' });
  const state = await waitForIdle(store);

  assert.equal(calls, 1);
  assert.equal(state.phase, 'idle');
  assert.match(state.error ?? '', /上限/);
});

test('LLM 出错：错误进状态树，相位回 idle', async () => {
  const faux = createFauxRuntime();
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      const message = assistantMessage([], 'error');
      return streamOf([
        { type: 'error', reason: 'error', error: { ...message, errorMessage: '网络炸了' } },
      ]);
    },
  });

  store.dispatch({ type: 'prompt', text: '你好' });
  const state = await waitForIdle(store);

  assert.equal(state.phase, 'idle');
  assert.equal(state.error, '网络炸了');
});

test('reducer 是纯的：idle 时的流式增量不会改动状态', () => {
  const state = createInitialState({
    systemPrompt: 's',
    providerName: 'deepseek',
    modelId: 'm',
    toolNames: [],
  });
  // redux-loop 的 reducer 可以返回纯 state（没有命令），也可以返回 loop(state, cmd)。
  const next = agentReducer(state, { type: 'llm/delta', delta: 'x' });
  assert.equal(next, state);
  assert.equal(Array.isArray(next), false);
});
