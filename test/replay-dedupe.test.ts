import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { createTracePersistence, replaySession, type TraceSink } from '../src/trace-store';
import type { AgentAction } from '../src/index';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';

/**
 * 改名后的 tool call id 能不能从 JSONL 恢复？**能，不用重算。**
 *
 * 关键在于落盘时机：`tool.result` 是在 `llm.done` 的改名**之后**才被写进 JSONL 的，
 * 而 `message` 记录的就是 `state.messages` 里的消息 —— 那里已经是新 id。
 * 所以回放只是把落盘的东西读回来，根本不会再次经过 `dedupeToolCallIds`。
 */

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function call(id: string): ToolCall {
  return { type: 'toolCall', id, name: 'bash', arguments: { command: 'echo hi' } };
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

/**
 * 跑一个 store（带落盘），模型每轮都返回 call_1 —— 跨轮撞 id 的真实场景。
 * 返回落盘的 JSONL 文本。
 */
function runSessionWithTrace(turns: number): { jsonl: string; state: AgentState } {
  const lines: string[] = [];
  const sink: TraceSink = { append: (line) => void lines.push(line) };

  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 'p',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 'S',
  });
  // 落盘器要一个 store；这里给它一个最小的适配（只用到 getState/subscribe/dispatch）。
  let notify: (() => void) | null = null;
  const dispatch = (action: AgentAction): void => {
    state = reducer(state, action) as AgentState;
    notify?.();
  };
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    dispatch,
  };
  const persistence = createTracePersistence({ store, sink });

  state = reducer(state, { type: 'prompt.init', systemPrompt: 'p', tools: [] }) as AgentState;
  dispatch({ type: 'prompt.init', systemPrompt: 'p', tools: [] });

  for (let t = 1; t <= turns; t += 1) {
    dispatch({ type: 'user.message', text: `第 ${t} 轮` });
    dispatch({ type: 'agent.run' });
    // 每轮模型都从 call_1 重新数
    dispatch({ type: 'llm.done', message: assistant([call('call_1')]) });
    for (const c of state.pendingToolCalls) {
      dispatch({ type: 'tool/start', call: c });
      dispatch({
        type: 'tool.result',
        message: {
          role: 'toolResult',
          toolCallId: c.id,
          toolName: 'bash',
          content: [{ type: 'text', text: `结果 ${c.id}` }],
          details: null,
          isError: false,
          timestamp: 1,
        },
      } as never);
    }
    dispatch({ type: 'tool.batch.done', count: state.pendingToolCalls.length });
  }

  persistence.dispose();
  return { jsonl: lines.join('\n'), state };
}

test('落盘的 JSONL 里已经是改名后的 id（不是原始的 call_1）', () => {
  const { jsonl, state } = runSessionWithTrace(3);

  // 内存里确实是改过名的
  const pending = state.messages
    .filter((m) => m.role === 'toolResult')
    .map((m) => (m as { toolCallId: string }).toolCallId);
  assert.deepEqual(pending, ['call_1', 'call_1#2', 'call_1#3']);

  // 落盘的 assistant 消息里也已经是新 id
  const assistantIds: string[] = [];
  for (const line of jsonl.split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as { op: string; message?: Message };
    if (record.op !== 'message' || !record.message) continue;
    if (record.message.role === 'assistant') {
      for (const c of record.message.content) {
        if (c.type === 'toolCall') assistantIds.push(c.id);
      }
    }
  }
  assert.deepEqual(
    assistantIds,
    ['call_1', 'call_1#2', 'call_1#3'],
    'JSONL 里存的就是改名后的 id',
  );
});

test('回放能恢复出改名后的 id —— 不重跑 dedupe，也不调模型', () => {
  const { jsonl } = runSessionWithTrace(3);

  // 关键：replaySession 只是一行行读回来，它不认识 dedupeToolCallIds，
  // 也不可能「重新算」出 call_1#2 —— 这个 id 只存在于落盘的那份数据里。
  const replayed = replaySession(jsonl, 'S');

  const calls: string[] = [];
  const results: string[] = [];
  for (const m of replayed.messages as Message[]) {
    if (m.role === 'assistant') {
      for (const c of m.content) if (c.type === 'toolCall') calls.push(c.id);
    } else if (m.role === 'toolResult') {
      results.push(m.toolCallId);
    }
  }

  assert.deepEqual(calls, ['call_1', 'call_1#2', 'call_1#3'], '回放出的 toolCall id 与落盘一致');
  assert.deepEqual(results, ['call_1', 'call_1#2', 'call_1#3'], '回放出的 toolResult id 一致');
  assert.equal(new Set(calls).size, calls.length, 'id 唯一');
  for (const id of calls) assert.ok(results.includes(id), `${id} 有配对的 result`);
});

test('回放出来的轨迹树与内存里一致（含 tool.attempt / tool.result 节点）', () => {
  const { jsonl, state } = runSessionWithTrace(3);
  const replayed = replaySession(jsonl, 'S');

  assert.equal(replayed.tree.order.length, state.trace.order.length, '节点数一致');
  assert.equal(replayed.tree.tipId, state.trace.tipId, 'HEAD 一致');

  // 轨迹节点的 meta 里记着工具名，回放后仍能对上
  const toolResultNodes = replayed.tree.order.filter(
    (id) => replayed.tree.nodes[id]?.kind === 'tool.result',
  );
  assert.equal(toolResultNodes.length, 3, '三个 tool.result 节点');
  for (const id of toolResultNodes) {
    assert.equal(replayed.tree.nodes[id]?.meta?.['tool'], 'bash');
  }
});

test('回放**不需要**原始 LLM 响应 —— 全程零 token', () => {
  // 这个测试的意义：如果哪天 dedupe 改成「回放时重算」，这里会立刻失败
  //（replaySession 拿不到 assistant 的原始 content）。
  const { jsonl } = runSessionWithTrace(2);
  // 人为把 JSONL 里的 assistant content 换成「无法重新推导出 id」的东西：
  // 把 toolResult 里的 id 换成一个「推导不出来」的值：
  const mangled = jsonl.replace(/"toolCallId":"call_1#2"/g, '"toolCallId":"ZZZ"');
  const replayed = replaySession(mangled, 'S');
  const ids = (replayed.messages as Message[])
    .filter((m) => m.role === 'toolResult')
    .map((m) => (m as { toolCallId: string }).toolCallId);
  // 回放出来就是落盘里的那个值（ZZZ），而不是「重新算」出来的 call_1#2 ——
  // 证明回放是**读取**而不是**重算**。
  assert.deepEqual(ids, ['call_1', 'ZZZ']);
});
