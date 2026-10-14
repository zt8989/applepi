import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { deriveStream, streamMessages } from '../src/stream';
import { createTraceTree } from '../src/trace';
import type { AgentAction } from '../src/actions';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reduce(state: AgentState, action: AgentAction): AgentState {
  return createAgentReducer({})(state, action) as AgentState;
}

function seed(): AgentState {
  let state = createInitialState({
    systemPrompt: 'sys',
    providerName: 'p',
    modelId: 'm',
    toolNames: [],
    sessionId: 't',
  });
  state = reduce(state, { type: 'prompt.init', systemPrompt: 'sys', tools: [] });
  state = reduce(state, {
    type: 'model.init',
    provider: 'p',
    modelId: 'm',
    thinkingLevel: 'off',
    capabilities: {
      midConvoSystemMessages: true,
      midConvoToolAdditions: true,
      developerRole: false,
    },
  });
  return state;
}

function assistant(
  content: unknown[],
  stopReason: AssistantMessage['stopReason'] = 'toolUse',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage,
    stopReason,
    timestamp: 1,
  } as unknown as AssistantMessage;
}

function call(id: string, name = 'bash'): ToolCall {
  return { type: 'toolCall', id, name, arguments: { command: 'echo hi' } };
}

// ── 消息从节点派生 ──

test('消息从 trace 派生：user / assistant / toolResult 都来自节点自带的 pi 消息', () => {
  let state = seed();
  state = reduce(state, { type: 'user.message', text: '查一下' });
  state = reduce(state, { type: 'agent.run' });
  const call1 = call('c1');
  state = reduce(state, { type: 'llm.done', message: assistant([call1]) });
  state = reduce(state, { type: 'tool/start', call: call1 });
  const result: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'hi' }],
    isError: false,
    timestamp: 2,
  };
  state = reduce(state, { type: 'tool.result', message: result });

  const entries = deriveStream(state.trace, state.messages);
  // 三条消息，且都是 message 条目（不是退回 state.messages）。
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['message', 'message', 'message'],
  );
  const messages = streamMessages(entries);
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.role, 'user');
  assert.equal(messages[1]?.role, 'assistant');
  assert.equal(messages[2]?.role, 'toolResult');
  // 节点 id 作为稳定 key。
  assert.deepEqual(
    entries.map((e) => e.nodeId),
    entries.map((e) => e.id),
  );
});

// ── 错误持久：重发后仍在 ──

test('LLM 失败：错误从 trace 派生，重新发消息后仍然在（不再被 state.error 清掉）', () => {
  let state = seed();
  state = reduce(state, { type: 'user.message', text: '你好' });
  state = reduce(state, { type: 'agent.run' });
  state = reduce(state, {
    type: 'llm.failed',
    error: 'LLM 调用超时（1s）',
    kind: 'timeout',
    cause: 'timeout',
  });
  // 收工（不再重试）—— 让 stopCause 落定。
  state = reduce(state, {
    type: 'llm.giveup',
    error: 'LLM 调用超时（1s）',
    kind: 'timeout',
    cause: 'timeout',
  });
  const before = deriveStream(state.trace, state.messages);
  const errorNotice = before.find((e) => e.kind === 'notice' && e.tone === 'error');
  assert.ok(errorNotice, '应当有一条 error 提示');
  if (errorNotice?.kind !== 'notice') throw new Error('unreachable');
  assert.equal(errorNotice.nodeId.startsWith('n'), true);

  // 重新发一句话：state.error 被清空（这是旧行为里错误消失的原因）……
  state = reduce(state, { type: 'user.message', text: '再试一次' });
  assert.equal(state.error, null);
  // ……但派生的时间线里那条错误提示还在。
  const after = deriveStream(state.trace, state.messages);
  assert.ok(
    after.some((e) => e.kind === 'notice' && e.nodeId === errorNotice.nodeId),
    '重发之后错误提示必须仍在',
  );
});

// ── 配置切换作为提示，落在下一次发话之前 ──

test('换模型 / 换档位：派生出一条 config 提示，位置在下一条 user 消息之前', () => {
  let state = seed();
  state = reduce(state, { type: 'user.message', text: '第一句' });
  state = reduce(state, { type: 'agent.run' });
  // 让第一轮正常收工（相位回 idle，否则第二句会被 `user.message` 的守卫丢掉）。
  state = reduce(state, {
    type: 'llm.done',
    message: assistant([{ type: 'text', text: '好' }], 'stop'),
  });
  state = reduce(state, { type: 'turn.end' });
  assert.equal(state.phase, 'idle');
  // 树已开：现在切换模型 + 档位（一条 `model.changed`，载荷与 `model.init` 一致）。
  state = reduce(state, {
    type: 'model.changed',
    provider: 'p',
    modelId: 'm2',
    thinkingLevel: 'high',
    capabilities: {
      midConvoSystemMessages: true,
      midConvoToolAdditions: true,
      developerRole: false,
    },
  });
  state = reduce(state, { type: 'user.message', text: '第二句' });

  const entries = deriveStream(state.trace, state.messages);
  const configIndex = entries.findIndex((e) => e.kind === 'notice' && e.tone === 'config');
  assert.ok(configIndex >= 0, '应当有一条配置切换提示');
  const notice = entries[configIndex]!;
  if (notice.kind !== 'notice') throw new Error('unreachable');
  assert.equal(notice.title, 'p/m2');
  assert.equal(notice.detail, 'thinking: high');
  // 最后一条 user 消息（第二句）在这条提示之后。
  const lastUser = [...entries].reverse().find((e) => e.kind === 'message');
  assert.ok(lastUser && lastUser.kind === 'message');
  assert.equal(lastUser.message.role, 'user');
  assert.ok(
    entries.indexOf(lastUser) > configIndex,
    'config 提示应排在切换后的那句 user 消息之前',
  );
});

// ── 开场装载不是「切换」──

test('开场装载的 model.init 不产提示（只有真的切换过才产）', () => {
  let state = seed();
  state = reduce(state, { type: 'user.message', text: '你好' });
  const entries = deriveStream(state.trace, state.messages);
  assert.equal(
    entries.filter((e) => e.kind === 'notice' && e.tone === 'config').length,
    0,
  );
});

// ── 旧轨迹退路 ──

test('旧轨迹（节点上没有 message）整体退回 fallbackMessages', () => {
  // 手工造一棵「有节点、没有消息载荷」的树，模拟旧轨迹文件。
  const tree = createTraceTree('old');
  const withUser = {
    ...tree,
    nodes: {
      n1: {
        id: 'n1',
        parentId: null,
        kind: 'user' as const,
        status: 'ok' as const,
        label: '旧',
        createdAt: 1,
        endedAt: 1,
      },
    },
    order: ['n1'],
    nextSeq: 2,
    tipId: 'n1',
  };
  const fallback = [{ role: 'user', content: '从会话文件读回来的', timestamp: 0 }] as never;
  const entries = deriveStream(withUser, fallback);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'message');
  if (entries[0]?.kind !== 'message') throw new Error('unreachable');
  assert.equal(entries[0].nodeId, null);
});
