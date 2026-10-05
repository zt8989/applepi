import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import type { AgentAction } from '../src/index';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';

/**
 * 回归测试：模型返回**重复的 tool call id**。
 *
 * 现场症状：某个会话「莫名其妙停掉了」。根因是消息流变成非法的
 * 「两个 toolCall(call_1) 只有一个 toolResult」—— provider 拒绝或行为异常。
 *
 * 修法不是去重（那会丢掉模型真要执行的调用），而是在 llm.done 里给冲突的 id
 * 加后缀改名，并让 messages / toolResult / openToolNodeIds 全用新 id。
 */

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function call(id: string, name = 'bash'): ToolCall {
  return { type: 'toolCall', id, name, arguments: { command: 'echo hi' } };
}

function assistant(content: unknown[]): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage,
    stopReason: 'toolUse',
    timestamp: 1,
  } as unknown as AssistantMessage;
}

function reduce(state: AgentState, action: AgentAction): AgentState {
  const r = createAgentReducer({});
  return r(state, action) as AgentState;
}

/** 走完一轮：prompt.init → user → agent.run → llm.done（带若干 toolCall） */
function startTurn(calls: ToolCall[]): AgentState {
  let state = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
  state = reduce(state, { type: 'prompt.init', systemPrompt: 'p', tools: [] });
  state = reduce(state, { type: 'user.message', text: 'go' });
  state = reduce(state, { type: 'agent.run' });
  return reduce(state, { type: 'llm.done', message: assistant(calls) });
}

/** 把一批工具全部执行完（tool.start → tool.result → tool.batch.done） */
function runTools(state: AgentState): AgentState {
  for (const c of state.pendingToolCalls) {
    state = reduce(state, { type: 'tool/start', call: c });
    state = reduce(state, {
      type: 'tool.result',
      message: {
        role: 'toolResult',
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: 'text', text: `结果 ${c.id}` }],
        details: null,
        isError: false,
        timestamp: 1,
      },
    } as never);
  }
  return reduce(state, { type: 'tool.batch.done', count: state.pendingToolCalls.length });
}

/** 检查消息序列是否合法：每个 toolCall 都有唯一配对的 toolResult */
function assertLegalSequence(state: AgentState, expectedCalls: number): void {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of state.messages) {
    if (m.role === 'assistant') {
      for (const c of m.content) if (c.type === 'toolCall') calls.push(c.id);
    } else if (m.role === 'toolResult') {
      results.push(m.toolCallId);
    }
  }
  assert.equal(calls.length, expectedCalls, 'toolCall 数量');
  assert.equal(results.length, expectedCalls, 'toolResult 数量必须与 toolCall 相同');
  assert.equal(new Set(calls).size, calls.length, 'toolCall id 必须唯一');
  for (const id of calls) {
    assert.ok(results.includes(id), `toolCall ${id} 有对应的 toolResult`);
  }
}

test('同一批里重复的 tool call id：改名后消息序列仍然合法', () => {
  let state = startTurn([call('call_1'), call('call_1')]);

  // messages 里已经是两个不同的 id
  const assistantMsg = state.messages.find((m) => m.role === 'assistant');
  const ids = (assistantMsg?.content ?? [])
    .filter((c): c is ToolCall => c.type === 'toolCall')
    .map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, '两个 toolCall 的 id 必须不同');
  assert.ok(ids.includes('call_1'), '第一个保留原 id');
  assert.ok(ids.includes('call_1#2'), '第二个加后缀');

  state = runTools(state);
  assertLegalSequence(state, 2);
});

test('三个重复 id：#2 #3 依次排开，全部执行', () => {
  let state = startTurn([call('call_1'), call('call_1'), call('call_1')]);
  const ids = state.pendingToolCalls.map((c) => c.id);
  assert.deepEqual(ids, ['call_1', 'call_1#2', 'call_1#3']);

  state = runTools(state);
  assertLegalSequence(state, 3);
  // 三个工具的轨迹节点各自独立，不会互相覆盖
  const toolResults = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.kind === 'tool.result',
  );
  assert.equal(toolResults.length, 3, '三个 tool.result 节点（openToolNodeIds 没有互相覆盖）');
  // executing / pending 都清空了
  assert.equal(state.executing.length, 0);
  assert.equal(state.pendingToolCalls.length, 0);
});

test('与**历史**消息的 id 撞了也要改名', () => {
  let state = startTurn([call('call_1')]);
  state = runTools(state);

  // 下一轮模型又返回了 call_1（有些模型每轮都从 call_1 开始数）
  state = reduce(state, { type: 'user.message', text: '再来' });
  state = reduce(state, { type: 'agent.run' });
  state = reduce(state, { type: 'llm.done', message: assistant([call('call_1')]) });

  const ids = state.pendingToolCalls.map((c) => c.id);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], 'call_1', '不能与历史 toolResult 的 id 相同');
  assert.ok(ids[0]?.startsWith('call_1#'), '实际是加后缀：' + ids[0]);

  state = runTools(state);
  // 两轮的工具结果都在，且 id 互不冲突
  const results = state.messages
    .filter((m) => m.role === 'toolResult')
    .map((m) => (m as { toolCallId: string }).toolCallId);
  assert.equal(results.length, 2);
  assert.equal(new Set(results).size, 2, '两轮的 toolResult id 不重复');
});

test('没有重复时**不改** id（不做无谓的改写）', () => {
  const state = startTurn([call('call_a'), call('call_b')]);
  assert.deepEqual(
    state.pendingToolCalls.map((c) => c.id),
    ['call_a', 'call_b'],
    '干净的 id 原样保留',
  );
});

test('id 冲突时 tool/start 与 tool/result 用的都是新 id（轨迹才对得上）', () => {
  let state = startTurn([call('call_1'), call('call_1')]);
  const [first, second] = state.pendingToolCalls;
  assert.ok(first && second);

  state = reduce(state, { type: 'tool/start', call: first });
  state = reduce(state, { type: 'tool/start', call: second });
  // openToolNodeIds 必须有两个条目（用唯一 id 索引），而不是一个被覆盖
  assert.equal(Object.keys(state.openToolNodeIds).length, 2, '两个工具各自有节点记录');

  state = runTools(state);
  // 两个 tool.result 节点都正确闭合
  const results = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.kind === 'tool.result',
  );
  assert.equal(results.length, 2);
  for (const id of results) {
    assert.equal(state.trace.nodes[id]?.status, 'ok', '都闭合了');
    assert.equal(state.trace.nodes[id]?.parentId !== null, true, '各自挂在自己的 tool.attempt 下');
  }
});

test('未知工具（同名重复但不同工具名）也各自配对', () => {
  // 极端情况：模型对两个不同的工具都用了 call_1
  let state = startTurn([call('call_1', 'read'), call('call_1', 'bash')]);
  const ids = state.pendingToolCalls.map((c) => `${c.name}:${c.id}`);
  assert.deepEqual(ids, ['read:call_1', 'bash:call_1#2']);

  state = runTools(state);
  assertLegalSequence(state, 2);
});
