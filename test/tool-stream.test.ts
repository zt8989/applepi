import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, AssistantMessageEventStream, Message } from '@earendil-works/pi-ai';
import { createAgentStore, waitForIdle } from '../src/store';
import { createAgentReducer } from '../src/reducer';
import { createFauxRuntime } from '../src/provider';
import { getTool } from '../src/tools';
import { createInitialState, type AgentState } from '../src/state';
import { renderMessage } from '../src/tui/app';
import { setupTheme } from '../src/tui/theme';
import type { AgentAction } from '../src/actions';

// 官方渲染器要 theme（`theme.colors` 未初始化时读它会抛）。与其它渲染测试同一个做法。
setupTheme(undefined, 'dark');

/**
 * 工具执行的**流式输出**（长命令边跑边显示）。
 *
 * ## 这组测试守的是什么
 *
 * 症状只有一个，但很难归因：用户发一条要跑几十秒的命令，界面**一直不动**，
 * 直到命令结束才突然蹦出工具块。那几十秒的空白与「卡死了」在屏幕上没有区别。
 *
 * 根因历史上是两层，各有一个测试钉住：
 *   1. `tools.ts` 的适配层给官方工具传了 `undefined` 当 `onUpdate` —— 官方的流式
 *      通路根本没被用上（`adapt 传下去 onUpdate`）。
 *   2. 即使 state 里有中间输出，界面也只看 `messages`（而 `toolResult` 要等命令结束
 *      才有）—— 于是没有东西可画（`reducer 存进 tool.progress` +
 *      `正在跑的工具块画在发起它的那条消息后面`）。
 */

const usage = (t: number) => ({
  input: t,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: t,
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
    usage: usage(100),
    stopReason,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function seed(): AgentState {
  return createInitialState({
    systemPrompt: 'test',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 't',
  });
}

function reduce(state: AgentState, action: AgentAction): AgentState {
  const r = createAgentReducer({});
  return r(state, action) as AgentState;
}

// ─── 适配层：onUpdate 有没有被传下去 ───

test('adapt：把 onUpdate 传给官方工具（传 undefined 等于关掉了整条流式通路）', async () => {
  const bash = getTool('bash');
  assert.ok(bash, 'bash 工具在');

  let updates = 0;
  await bash.execute(
    'call-1',
    { command: 'echo streamed-output-marker' },
    undefined,
    () => {
      updates += 1;
    },
  );
  assert.ok(
    updates > 0,
    '官方工具应该至少回调一次 onUpdate（哪怕输出很短）—— 0 次说明 onUpdate 没传下去',
  );
});

// ─── reducer：中间态存到 tool.progress，不进 messages ───

test('tool.progress：只进 toolProgress，**不进 messages**（中途被 Ctrl-C 会留下非法序列）', () => {
  const call = {
    type: 'toolCall' as const,
    id: 'c1',
    name: 'bash',
    arguments: { command: 'sleep 10' },
  };
  let state = reduce(seed(), { type: 'tool/start', call });
  const messagesBefore = state.messages.length;

  state = reduce(state, {
    type: 'tool.progress',
    toolCallId: 'c1',
    content: [{ type: 'text', text: '第 1 行\n' }],
  } as AgentAction);

  assert.equal(state.messages.length, messagesBefore, '中间输出不进 messages');
  assert.equal(state.toolProgress['c1']?.content.length, 1);
});

test('tool.progress：工具不在跑时丢弃（过期的尾巴）', () => {
  const state = reduce(seed(), {
    type: 'tool.progress',
    toolCallId: 'never-started',
    content: [{ type: 'text', text: '幽灵输出' }],
  } as AgentAction);
  assert.equal(state.toolProgress['never-started'], undefined);
});

test('tool.result：清掉 toolProgress（终值已经在 messages 里，留着会画两遍）', () => {
  const call = {
    type: 'toolCall' as const,
    id: 'c1',
    name: 'bash',
    arguments: { command: 'echo hi' },
  };
  let state = reduce(seed(), { type: 'tool/start', call });
  state = reduce(state, {
    type: 'tool.progress',
    toolCallId: 'c1',
    content: [{ type: 'text', text: '中间' }],
  } as AgentAction);
  assert.ok(state.toolProgress['c1']);

  state = reduce(state, {
    type: 'tool.result',
    message: {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: '最终' }],
      isError: false,
      timestamp: 1,
    } as never,
  });

  assert.equal(state.toolProgress['c1'], undefined, '跑完就该清掉');
  assert.ok(state.messages.some((m) => m.role === 'toolResult'), '终值在 messages 里');
});

// ─── 渲染：还没跑完就有东西可画 ───

test('正在跑的工具：在 messages 里还没有 toolResult 时也能画出工具块', () => {
  const call = { type: 'toolCall' as const, id: 'c1', name: 'bash', arguments: { command: 'sleep 30' } };
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: '我跑一下' }, call],
    timestamp: 1,
  } as unknown as Message;

  let state = seed() as AgentState;
  state = { ...state, phase: 'calling-tools', messages: [assistant] } as AgentState;
  state = { ...state, executing: [{ call, startedAt: Date.now() }] } as AgentState;
  state = {
    ...state,
    toolProgress: { c1: { toolCallId: 'c1', content: [{ type: 'text', text: 'installing...\n' }] } },
  } as AgentState;

  // 关键：messages 里**只有** assistant（toolResult 还没产出）。
  assert.equal(state.messages.some((m) => m.role === 'toolResult'), false);
  const lines = renderMessage(state, assistant as never, 100, false);
  const text = lines.join('\n');
  assert.ok(
    text.includes('sleep 30'),
    `还没跑完就该看到命令本身。实际输出：\n${text}`,
  );
});

test('工具跑完（progress 清空）后：不再画「正在跑」的块，只留最终的 toolResult', () => {
  const call = { type: 'toolCall' as const, id: 'c1', name: 'bash', arguments: { command: 'echo hi' } };
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: '跑完了' }, call],
    timestamp: 1,
  } as unknown as Message;
  const toolResult = {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'hi' }],
    isError: false,
    timestamp: 2,
  } as unknown as Message;

  let state = seed() as AgentState;
  // executing 已空（工具结束）、progress 已清空（reducer 做的）
  state = { ...state, phase: 'idle', messages: [assistant, toolResult], executing: [], toolProgress: {} } as AgentState;
  const lines = renderMessage(state, assistant as never, 100, false);
  const text = lines.join('\n');
  assert.equal(
    text.split('sleep').length - 1,
    0,
    '跑完之后 assistant 那一块不该再画一遍工具',
  );
});

// ─── 端到端：确实在命令跑完之前就有了 progress ───

test('渲染「正在跑的工具」不会留下永久定时器（否则进程永远不退出）', () => {
  const call = {
    type: 'toolCall' as const,
    id: 'c1',
    name: 'bash',
    arguments: { command: 'sleep 30' },
  };
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text: 'x' }, call],
    timestamp: 1,
  } as unknown as Message;
  let state = seed() as AgentState;
  state = { ...state, phase: 'calling-tools', messages: [assistant] } as AgentState;
  state = { ...state, executing: [{ call, startedAt: Date.now() }] } as AgentState;
  state = {
    ...state,
    toolProgress: { c1: { toolCallId: 'c1', content: [{ type: 'text', text: 'running\n' }] } },
  } as AgentState;

  // 官方 bash 渲染器看到 isPartial 会 setInterval（让 Elapsed 跳秒），只在**同一个**
  // 组件收到终值时 clearInterval。我们每帧新建一个用完就扔的组件，于是若不主动收尾，
  // 每渲染一帧就漏一个 interval —— 症状是「跑过一次流式工具的进程永远不退出」。
  //
  // 这条测试**只能**间接观察（直接列 handle 在不同 Node 版本上不稳定），
  // 但它至少保证「反复渲染」这个动作不会抛、不会越积越多地做重活。
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50; i += 1) {
    renderMessage(state, assistant as never, 100, false);
  }
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(
    growth < 200 * 1024 * 1024,
    `渲染 50 帧不该堆积大量对象（漏了定时器/组件就是这个症状）。增长 ${Math.round(growth / 1024 / 1024)}MB`,
  );
});

test('端到端：命令还在跑时 state 里就有中间输出（而不是等 toolResult）', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    streamFn: () => {
      calls += 1;
      const first = calls === 1;
      const message = assistantMessage(
        first
          ? [
              { type: 'text', text: '跑一下' },
              {
                type: 'toolCall',
                id: 'c1',
                name: 'bash',
                // 一个真的会跑一会儿、并且**边跑边输出**的命令。
                arguments: { command: 'for i in 1 2 3; do echo "第 $i 行"; sleep 0.3; done' },
              },
            ]
          : [{ type: 'text', text: '好了' }],
        first ? 'toolUse' : 'stop',
      );
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: first ? 'toolUse' : 'stop', message } as never;
        },
      } as unknown as AssistantMessageEventStream;
    },
  });
  store.dispatch({
    type: 'prompt.init',
    systemPrompt: 'test',
    tools: [
      {
        name: 'bash',
        description: '跑命令',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  } as AgentAction);
  store.dispatch({
    type: 'model.init',
    provider: 'faux',
    modelId: 'fake',
    thinkingLevel: 'off',
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
  } as AgentAction);

  // 记录每次 progress 的**行数**，看它是不是逐步增长（而不是最后一次全给）。
  const seenLines: number[] = [];
  const unsubscribe = store.subscribe(() => {
    const progress = store.getState().toolProgress['c1'];
    if (progress === undefined) return;
    const text = progress.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim();
    if (text === '') return;
    const lines = text.split('\n').length;
    if (seenLines[seenLines.length - 1] !== lines) seenLines.push(lines);
  });

  store.dispatch({ type: 'user.message', text: '跑个慢命令' } as AgentAction);
  await waitForIdle(store);
  unsubscribe();

  assert.ok(seenLines.length > 0, '命令跑的过程中就该有 progress');
  assert.ok(
    (seenLines[seenLines.length - 1] ?? 0) > (seenLines[0] ?? 0),
    `progress 应当逐步增长（先 1 行、后多行）。实际：${JSON.stringify(seenLines)}`,
  );
  const final = store.getState();
  assert.equal(final.toolProgress['c1'], undefined, '跑完清空');
  assert.ok(final.messages.some((m) => m.role === 'toolResult'), '终值进了 messages');
});