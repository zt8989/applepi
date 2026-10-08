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
import { createInitialState } from '../src/state';
import { createAgentReducer } from '../src/reducer';
import { renderTree, traceStats, type AgentState } from '../src/index';
import { deserializeTree, serializeTree } from '../src/trace';

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

/** 假流：把脚本事件按顺序吐出来；中途可以一直不结束（模拟挂住）。 */
function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * 一个「挂住」的流：真的去听 abort 信号，收到就安静收尾（不给 done 事件）。
 * 这才是真超时该有的形状 —— 否则测的就不是超时逻辑，而是我这个假流的 sleep。
 */
function hangingStream(options?: { signal?: AbortSignal | undefined }): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (!signal) {
          setTimeout(resolve, 10_000);
          return;
        }
        if (signal.aborted) {
          resolve();
          return;
        }
        // 兜底 10s，防止信号永远不来时测试挂死。
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    },
  } as unknown as AssistantMessageEventStream;
}

// ─── 树的基本形状 ───

test('轨迹树：成功的一次对话长成 user → turn → step → llm.result 的链', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
  });

  state = reducer(state, { type: 'user.message', text: '你好' }) as AgentState;
  state = reducer(state, { type: 'turn.start' }) as AgentState;
  state = reducer(state, { type: 'step.start' }) as AgentState;
  const userNode = state.trace.order[0];
  assert.ok(userNode);
  assert.equal(state.trace.nodes[userNode]?.kind, 'user');

  // **多了一层 turn**：user 的孩子是回合容器，而**不是** step。
  // 这就是新层级的全部要点 —— 之前 step 挂 user 下面，现在 step 挂 turn 下面。
  const turnNode = state.trace.order[1];
  assert.ok(turnNode);
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');
  assert.equal(state.trace.nodes[turnNode]?.parentId, userNode);

  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const attempt = state.trace.order[2];
  assert.ok(attempt);
  assert.equal(state.trace.nodes[attempt]?.kind, 'step.start');
  // step 的父是 turn 容器
  assert.equal(state.trace.nodes[attempt]?.parentId, turnNode);
  // **容器不推进 tip** —— turn 与 step 都不推进，推进的是里面的 result。
  assert.equal(state.trace.tipId, userNode);
  assert.equal(state.openLlmNodeId, attempt);

  const message = assistantMessage([{ type: 'text', text: '在' }], 'stop');
  state = reducer(state, { type: 'llm.done', message }) as AgentState;
  const result = state.trace.order[3];
  assert.ok(result);
  assert.equal(state.trace.nodes[result]?.kind, 'llm.result');
  assert.equal(state.trace.nodes[result]?.parentId, attempt);
  // result 推进 tip
  assert.equal(state.trace.tipId, result);
  assert.equal(state.openLlmNodeId, null);
  // 无工具 = 回合收工，所以 step.end 也一并开了（紧随其后）。
  assert.equal(state.trace.nodes[state.trace.order[4] ?? '']?.kind, 'step.end');
});

// ─── 需求核心：超时的父 id 指向超时前的节点 ───

test('需求核心：LLM 超时后重试，重试节点的父 id 指向**超时前**的节点（不是失败节点）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
  });

  state = reducer(state, { type: 'user.message', text: '你好' }) as AgentState;
  state = reducer(state, { type: 'turn.start' }) as AgentState;
  state = reducer(state, { type: 'step.start' }) as AgentState;
  const userNode = state.trace.order[0];
  assert.ok(userNode, 'user 节点');
  // 多了一层：重试的分叉长在 **turn 容器**下面，而不是 user 下面。
  // 需求本身（「重试的父 id 指向超时前的节点」）没变，只是那棵树深了一节。
  const turnNode = state.trace.order[1];
  assert.ok(turnNode, 'turn 容器');
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');

  // 第一次尝试
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const firstAttempt = state.openLlmNodeId;
  assert.ok(firstAttempt);

  // 超时了（kind=timeout，可重试）
  state = reducer(state, {
    type: 'llm.failed',
    error: 'LLM 调用超时（1s）',
    kind: 'timeout',
    nodeId: firstAttempt,
  }) as AgentState;

  // 关键断言 1：错误节点确实在树上，且挂在第一次 attempt 下面
  const errorNodeId = state.errorNodeId;
  assert.ok(errorNodeId, '错误必须是树上的一个节点');
  const errorNode = state.trace.nodes[errorNodeId];
  assert.ok(errorNode);
  assert.equal(errorNode.kind, 'error');
  assert.equal(errorNode.status, 'error');
  assert.equal(errorNode.parentId, firstAttempt, 'error 挂在失败的那次 attempt 下');

  // 关键断言 2：错误**不推进 tip**，所以 tip 仍然是 user 节点（超时前那一刻的最后一个闭合点）
  assert.equal(state.trace.tipId, userNode, 'tip 仍指向超时前的节点');
  assert.equal(state.retrying, true, '超时应可重试');
  assert.equal(state.phase, 'thinking', '重试时环不闭合');

  // 第二次尝试：接线看到 retrying 就再发 step.start（开**兄弟** step）+ agent.run
  state = reducer(state, { type: 'step.start' }) as AgentState;
  // 第二次尝试（接线看到 retrying 就再发一条 agent.run）
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const secondAttempt = state.openLlmNodeId;
  assert.ok(secondAttempt);
  assert.notEqual(secondAttempt, firstAttempt, '确实是新的一次尝试');

  // ★ 需求要的那一条：第二次尝试的父 id 指向超时前的容器，而不是失败节点
  assert.equal(
    state.trace.nodes[secondAttempt]?.parentId,
    turnNode,
    '重试的父 id 必须指向超时前的容器',
  );
  assert.notEqual(
    state.trace.nodes[secondAttempt]?.parentId,
    errorNodeId,
    '重试不能挂在错误节点下面',
  );

  // 树上于是长出 git 那样的分叉：失败与重试是**同一个 turn 下的兄弟 step**
  const siblings = state.trace.order.filter((id) => state.trace.nodes[id]?.parentId === turnNode);
  assert.deepEqual(siblings, [firstAttempt, secondAttempt], '失败与重试是兄弟节点');

  // 第二次成功了。注意 `llm.result` **不是**最后一个节点 —— 它后面还跟着一个
  // `step.end`（容器闭合）。但 tip 指向的是 result，不是 step.end：
  // 容器闭合不代表「这里发生了一件事」。
  const message = assistantMessage([{ type: 'text', text: '好了' }], 'stop');
  state = reducer(state, { type: 'llm.done', message }) as AgentState;
  const resultId = state.trace.order[state.trace.order.length - 2];
  assert.ok(resultId);
  assert.equal(state.trace.nodes[resultId]?.kind, 'llm.result');
  assert.equal(state.trace.nodes[resultId]?.parentId, secondAttempt);
  assert.equal(state.trace.tipId, resultId, '成功后才推进 tip');
  assert.equal(state.retrying, false);

  // 树渲染出来就是这个形状。
  //
  // **多了一层 turn**（n2），所以分叉从它下面开始，而 tip 指向 n7（llm.result）
  // —— n8 是 step.end，容器闭合不推进 tip。
  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n${rendered}\n`);
  assert.match(rendered, /├── ✗ n3 step\.start/);
  assert.match(rendered, /└── ✓ n6 step\.start/);
  assert.match(rendered, /HEAD → n7/);
  // turn 容器不带失败标记，也不推进 tip。
  assert.match(rendered, /^· n2 turn\.start/m);
});

test('鉴权失败不重试：错误在树上，但没有分叉，环收工', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
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
  state = reducer(state, {
    type: 'llm.failed',
    error: '401 Unauthorized: api key 无效',
    kind: 'auth',
    ...(attempt !== null && attempt !== undefined ? { nodeId: attempt } : {}),
  }) as AgentState;

  assert.equal(state.retrying, false, '鉴权失败重试没意义');
  assert.equal(state.phase, 'idle', '环要闭合，waitForIdle 才等得到');
  assert.ok(state.errorNodeId, '但错误仍然在树上');
  const siblings = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.parentId === state.trace.order[0],
  );
  assert.equal(siblings.length, 1, '没有第二次尝试，所以没有分叉');
});


test('并行工具调用不算「重试」', () => {
  // 回归测试：traceStats 曾经把 tool.attempt 和 llm.attempt 一起当「尝试」，
  // 于是模型一轮里并行发两个工具（两个同父的兄弟 tool.attempt）就被记成一次重试。
  // 现场表现：顶栏显示「重试 22」，而轨迹里一个 error 节点都没有。
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: ['bash'],
    sessionId: 'test',
  });

  state = reducer(state, { type: 'user.message', text: '并行查两个文件' }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  // 一条成功的 LLM 轮（推进 tip），它下面挂两个并行的工具调用。
  state = reducer(state, {
    type: 'llm.done',
    message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls a' } },
        { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'ls b' } },
      ],
      api: 'openai-completions',
      provider: 'faux',
      model: 'fake',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: Date.now(),
    },
  }) as AgentState;
  state = reducer(state, {
    type: 'tool.call',
    calls: [
      { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls a' } },
      { type: 'toolCall', id: 'call_2', name: 'bash', arguments: { command: 'ls b' } },
    ],
  }) as AgentState;
  for (const id of ['call_1', 'call_2']) {
    state = reducer(state, {
      type: 'tool/start',
      call: { type: 'toolCall', id, name: 'bash', arguments: { command: 'ls' } },
    }) as AgentState;
  }

  const stats = traceStats(state.trace);
  assert.equal(
    stats.retries,
    0,
    '两个并行工具调用是兄弟，不是「第一个失败后的重试」',
  );
  assert.equal(stats.toolCalls, 0, '工具还没返回，所以 tool.result 是 0');
});
test('重试用尽：maxLlmAttempts=2 时只重试一次，第二次失败就收工', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
    maxLlmAttempts: 2,
  });

  state = reducer(state, { type: 'user.message', text: '你好' }) as AgentState;
  state = reducer(state, { type: 'turn.start' }) as AgentState;
  state = reducer(state, { type: 'step.start' }) as AgentState;
  const userNode = state.trace.order[0];

  // 第一次失败
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  state = reducer(state, { type: 'llm.failed', error: 'timeout', kind: 'timeout' }) as AgentState;
  assert.equal(state.retrying, true, '还有一次机会');

  // 第二次也失败：同样先开兄弟 step
  state = reducer(state, { type: 'step.start' }) as AgentState;
  // 第二次也失败
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  state = reducer(state, { type: 'llm.failed', error: 'timeout', kind: 'timeout' }) as AgentState;
  assert.equal(state.retrying, false, '机会用完了');
  assert.equal(state.phase, 'idle');

  const stats = traceStats(state.trace);
  assert.equal(stats.errors, 2, '两个错误节点都在树上');
  assert.equal(stats.retries, 1, '只发生了一次重试');
  // 两个 attempt 是兄弟，都挂在 user 下
  const attempts = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.kind === 'step.start',
  );
  assert.equal(attempts.length, 2);
  // 两个 step 是同一个 turn 容器下的兄弟（分叉就长在这儿）。
  const turnNode = state.trace.order[1];
  assert.ok(turnNode);
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');
  for (const id of attempts) {
    assert.equal(state.trace.nodes[id]?.parentId, turnNode);
  }
});

// ─── 端到端：真的超时一次，然后重试成功 ───

test('端到端：第一次 LLM 调用真的超时，自动重试后成功；树上有分叉，错误已持久化', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    // 超时给 120ms，第一次必定超时；重试预算 = 2 次。
    llmTimeoutMs: 120,
    streamFn: (_model, _context, options) => {
      calls += 1;
      if (calls === 1) return hangingStream({ ...(options?.signal ? { signal: options.signal } : {}) });
      const message = assistantMessage([{ type: 'text', text: '重试成功了' }], 'stop');
      return streamOf([
        { type: 'text_delta', contentIndex: 0, delta: '重试成功了', partial: message },
        { type: 'done', reason: 'stop', message },
      ]);
    },
  });

  store.dispatch({ type: 'user.message', text: '你好' });
  await waitForIdle(store, 20_000);
  // **重新读一次状态**：`waitForIdle` 返回的是「phase 转 idle 那一刻」的快照，
  // 而 `turn.end` 是在那之后才 flush 的（见 reducer 里 `closeTurn()` 的注释）。
  // 不等它就断言 `stats.turns`，读到的是回合容器还没关的那份 —— 0。
  await new Promise((r) => setTimeout(r, 50));
  const state = store.getState();

  assert.equal(calls, 2, '第一次超时 + 一次重试');
  assert.equal(state.phase, 'idle');
  assert.equal(state.error, null, '最终成功，错误不该留在状态里');
  assert.equal(state.turns, 1);

  const stats = traceStats(state.trace);
  assert.equal(stats.retries, 1, '树上记录了一次重试');
  assert.equal(stats.errors, 1, '超时那个错误节点被保留在树上');
  assert.equal(stats.turns, 1, '一个回合');
  // 一步失败 + 一步成功 = 两个 step.end，所以 steps 是 2。
  //
  // 注意它**不等于** turns：一个回合里模型可以查很多轮（每轮一个 step）。
  assert.equal(stats.steps, 2);

  // 重试成功后 state.errorNodeId 已被 agent.run 清空（当前没有错误）——
  // 但**树上那个错误节点必须还在**，这正是「错误也要持久化」要保证的事。
  assert.equal(state.errorNodeId, null, '重试成功后当前没有活跃错误');
  const errorNodes = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.kind === 'error',
  );
  assert.equal(errorNodes.length, 1, '超时的错误节点被留在树上');
  const errorNode = state.trace.nodes[errorNodes[0] as string];
  assert.ok(errorNode, '超时的错误节点在树上');
  assert.match(errorNode?.detail ?? '', /超时/);

  console.log(`\n端到端超时 → 重试：\n${renderTree(state.trace, { maxWidth: 0 })}\n`);
});

test('端到端：每次尝试都超时，重试用尽后停在错误上，错误全部留在树上', async () => {
  const faux = createFauxRuntime();
  let calls = 0;
  const store = createAgentStore({
    runtime: faux.runtime,
    systemPrompt: 'test',
    llmTimeoutMs: 80,
    maxLlmAttempts: 3,
    streamFn: (_model, _context, options) => {
      calls += 1;
      return hangingStream({ ...(options?.signal ? { signal: options.signal } : {}) });
    },
  });

  store.dispatch({ type: 'user.message', text: '你好' });
  await waitForIdle(store, 20_000);
  // **重新读一次状态**：`waitForIdle` 返回的是「phase 转 idle 那一刻」的快照，
  // 而 `turn.end` 是在那之后才 flush 的（见 reducer 里 `closeTurn()` 的注释）。
  // 不等它就断言 `stats.turns`，读到的是回合容器还没关的那份 —— 0。
  await new Promise((r) => setTimeout(r, 50));
  const state = store.getState();

  assert.equal(calls, 3, '首次 + 2 次重试');
  assert.equal(state.phase, 'idle');
  assert.equal(state.errorKind, 'timeout');
  assert.match(state.error ?? '', /超时/);

  const stats = traceStats(state.trace);
  assert.equal(stats.errors, 3, '三次失败都在树上，没丢');
  assert.equal(stats.retries, 2);

  const rendered = renderTree(state.trace, { maxWidth: 0 });
  console.log(`\n全部超时：\n${rendered}\n`);
  // 三个 step 全是同一个 turn 容器下的兄弟（重试的分叉就长在这儿）。
  const userNode = state.trace.order[0];
  const turnNode = state.trace.order[1];
  assert.ok(turnNode, 'turn 容器');
  assert.equal(state.trace.nodes[turnNode]?.kind, 'turn.start');
  assert.equal(state.trace.nodes[turnNode]?.parentId, userNode, 'turn 挂在 user 下');
  const attempts = state.trace.order.filter(
    (id) => state.trace.nodes[id]?.kind === 'step.start',
  );
  assert.equal(attempts.length, 3);
  for (const id of attempts) {
    assert.equal(state.trace.nodes[id]?.parentId, turnNode, '每次尝试的父 id 都指向同一个容器');
  }
});

// ─── 工具与错误 ───

test('工具失败也是树上的一个 error 节点（不推进 tip）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
    systemPrompt: 's',
    providerName: 'faux',
    modelId: 'fake',
    toolNames: [],
    sessionId: 'test',
  });

  state = reducer(state, { type: 'user.message', text: '跑工具' }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const tipBefore = state.trace.tipId;

  const call: ToolCall = {
    type: 'toolCall',
    id: 'call_1',
    name: 'calc',
    arguments: { expression: '1' },
  };
  state = reducer(state, { type: 'tool/start', call }) as AgentState;
  const toolAttempt = state.openToolNodeIds['call_1'];
  assert.ok(toolAttempt);
  assert.equal(state.trace.nodes[toolAttempt]?.parentId, tipBefore);

  state = reducer(state, {
    type: 'tool.result',
    message: {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'calc',
      content: [{ type: 'text', text: '炸了' }],
      details: null,
      isError: true,
      timestamp: Date.now(),
    },
  }) as AgentState;

  const errId = state.errorNodeId;
  assert.ok(errId);
  assert.equal(state.trace.nodes[errId]?.kind, 'error');
  assert.equal(state.trace.nodes[errId]?.parentId, toolAttempt);
  assert.equal(state.trace.tipId, tipBefore, '工具失败也不推进 tip');
});

// ─── 序列化 / 回放 ───

test('轨迹可以序列化并从 JSONL 回放重建（持久化的地基）', () => {
  const reducer = createAgentReducer({});
  let state: AgentState = createInitialState({
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
  state = reducer(state, { type: 'llm.failed', error: '超时', kind: 'timeout' }) as AgentState;
  state = reducer(state, { type: 'agent.run' }) as AgentState;
  const message = assistantMessage([{ type: 'text', text: '好了' }], 'stop');
  state = reducer(state, { type: 'llm.done', message }) as AgentState;

  const restored = deserializeTree(serializeTree(state.trace));

  assert.equal(restored.tipId, state.trace.tipId, 'HEAD 回放一致');
  assert.equal(restored.order.length, state.trace.order.length);
  assert.equal(
    renderTree(restored, { maxWidth: 0 }),
    renderTree(state.trace, { maxWidth: 0 }),
    '回放出来的树与原来逐字一致',
  );
});
