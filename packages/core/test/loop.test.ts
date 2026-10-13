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
import { createAgentReducer } from '../src/reducer';
import { createInitialState, type AgentState } from '../src/state';

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
          // 工具来自 @earendil-works/pi-coding-agent，这里用官方的 bash 算。
          name: 'bash',
          arguments: { command: 'echo $(((3+4)*6))' },
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

  store.dispatch({ type: 'user.message', text: '算一下 (3+4)*6' });
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
  // bash 的 stdout 里就是 42。
  assert.match(textOf(toolResult), /42/);
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
        name: 'bash',
        arguments: { command: 'echo tick' },
      };
      const message = assistantMessage([toolCall], 'toolUse');
      return streamOf([{ type: 'done', reason: 'toolUse', message }]);
    },
  });

  store.dispatch({ type: 'user.message', text: '一直调工具' });
  const state = await waitForIdle(store);

  assert.equal(calls, 1);
  assert.equal(state.phase, 'idle');
  assert.match(state.error ?? '', /上限/);
});


test('轮数上限是「单回合」的：第二次提问仍然拿满额度', async () => {
  // 回归测试：`turns` 曾经在 user.message 里没归零，于是 maxTurns 变成整个会话累计的上限 ——
  // 第一问就用光额度，第二问只跑 1 轮就报错，现象是「聊着聊着就停了」。
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
        name: 'bash',
        arguments: { command: 'echo tick' },
      };
      const message = assistantMessage([toolCall], 'toolUse');
      return streamOf([{ type: 'done', reason: 'toolUse', message }]);
    },
  });

  store.dispatch({ type: 'user.message', text: '第一问' });
  const first = await waitForIdle(store);
  assert.equal(first.turns, 1, '第一问用满了 1 轮');

  const callsAfterFirst = calls;
  store.dispatch({ type: 'user.message', text: '第二问' });
  const second = await waitForIdle(store);

  // 关键断言：第二问**又**跑满了 1 轮，而不是被上一问的额度欠着。
  assert.equal(calls - callsAfterFirst, 1, '第二问应有完整的 1 轮额度');
  assert.equal(second.turns, 1, 'turns 必须在每次提问时归零');
  assert.match(second.error ?? '', /上限/);
});

test('stopReason 区分「正常收工」和「被上限砍」', async () => {
  // 界面靠 stopReason 决定怎么显示。之前撞上限只写了一句 error 字符串、没有结构化字段，
  // 于是「上限收工」和「LLM 报错」在界面上长得一样，用户只能猜为什么停了。
  const faux = createFauxRuntime();
  let calls = 0;
  // 显式给了 streamFn 会盖掉 faux 的脚本，所以「说完就收工」那一段靠这个开关换行为。
  let finish = false;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    maxTurns: 2,
    streamFn: () => {
      calls += 1;
      if (finish) {
        return streamOf([
          {
            type: 'done',
            reason: 'stop',
            message: assistantMessage([{ type: 'text', text: '说完了' }], 'stop'),
          },
        ]);
      }
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: `call_${calls}`,
        name: 'bash',
        arguments: { command: 'echo tick' },
      };
      return streamOf([{ type: 'done', reason: 'toolUse', message: assistantMessage([toolCall], 'toolUse') }]);
    },
  });

  store.dispatch({ type: 'user.message', text: '一直调工具' });
  const capped = await waitForIdle(store);
  assert.equal(capped.stopReason, 'maxTurns', '撞上限要标成 maxTurns');
  assert.equal(capped.errorKind, null, '上限收工不是 LLM 错误，errorKind 应为空');

  // 正常说完：不该有 error，也不该被显示成「出错」。
  finish = true;
  store.dispatch({ type: 'user.message', text: '打个招呼' });
  const done = await waitForIdle(store);
  assert.equal(done.stopReason, 'completed');
  assert.equal(done.error, null, '正常收工没有 error');
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

  store.dispatch({ type: 'user.message', text: '你好' });
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
  const reducer = createAgentReducer({});
  const next = reducer(state, { type: 'llm.delta', delta: 'x' }) as AgentState;
  assert.equal(next, state);
  assert.equal(Array.isArray(next), false);
});
