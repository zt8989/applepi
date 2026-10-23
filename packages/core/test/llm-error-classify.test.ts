import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLlmError, createInitialState, isRetryable, type AgentState } from '../src/state';
import { createAgentReducer } from '../src/reducer';

/**
 * LLM 错误分类 —— 连接类失败必须归进 `network`（可重试）。
 *
 * 起因：zai-coding-cn 的 glm-5.3-flash 断连时，SDK 抛的是 APIConnectionError，
 * 文案就是「Connection error.」—— 旧分类认不出它，落进 `unknown`，
 * 于是超时会重试、断连却直接收工（reason=error）。
 */

test('SDK 的 APIConnectionError（默认文案 Connection error.）归为 network', () => {
  assert.equal(classifyLlmError('Connection error.'), 'network');
  assert.equal(classifyLlmError('Connection error'), 'network');
});

test('常见连接错误文案都归为 network', () => {
  assert.equal(classifyLlmError('fetch failed: ECONNREFUSED 127.0.0.1:443'), 'network');
  assert.equal(classifyLlmError('Connection refused (os error 111)'), 'network');
  assert.equal(classifyLlmError('Connection reset by peer'), 'network');
  assert.equal(classifyLlmError('Connection closed unexpectedly'), 'network');
  // ECONNABORTED 含 abort，但不能被 abort 分支截走：它是连接错误，不是用户中断。
  assert.equal(classifyLlmError('ECONNABORTED'), 'network');
});

test('不可重试的错误不因新关键词误判', () => {
  assert.equal(classifyLlmError('Invalid API key provided'), 'auth');
  assert.equal(classifyLlmError('Request timed out after 120000ms'), 'timeout');
  // 中文「运行被用户中断」不归这里认：effects.ts 先认 RunAbortedError 异常类型，
  // classifyLlmError 只是英文文案的兑底。
  assert.equal(classifyLlmError('ECONNABORTED'), 'network');
});

test('network 类可重试（与 timeout 同一待遇）', () => {
  assert.equal(isRetryable('network'), true);
  assert.equal(isRetryable('timeout'), true);
  assert.equal(isRetryable('unknown'), false);
});

/** 连接失败走完整 reducer：应像超时一样停在 thinking（retrying），而不是收工。 */
function runAndFail(error: string, kind: 'network' | 'unknown'): AgentState {
  const reducer = createAgentReducer({});
  let state = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
  });
  state = reducer(state, { type: 'user.message', text: '你好' }) as AgentState;
  state = reducer(state, { type: 'turn.start' }) as AgentState;
  state = reducer(state, { type: 'step.start' }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const attempt = state.openLlmNodeId;
  assert.ok(attempt);
  return reducer(state, {
    type: 'llm.failed',
    error,
    kind,
    nodeId: attempt,
  }) as AgentState;
}

test('Connection error. 走 llm.failed 后可重试（phase=thinking），unknown 则收工', () => {
  const retriable = runAndFail('Connection error.', 'network');
  assert.equal(retriable.retrying, true, '连接失败应可重试');
  assert.equal(retriable.phase, 'thinking', '重试时环不闭合');
  assert.equal(retriable.stopReason, null);

  const fatal = runAndFail('Connection error.', 'unknown');
  assert.notEqual(fatal.stopReason, null, 'unknown 不重试，直接收工');
});
